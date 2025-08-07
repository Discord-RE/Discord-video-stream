import pDebounce from "p-debounce";
import LibAV, { type CodecParameters, type Packet } from "@lng2004/libav.js-variant-webcodecs-avf-with-decoders";
import { Log } from "debug-level";
import { uid } from "uid";
import { AVCodecID } from "./LibavCodecId.js";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";

type MediaStreamInfoCommon = {
    index: number,
    codec: AVCodecID,
    codecpar: CodecParameters,
}
export type VideoStreamInfo = MediaStreamInfoCommon & {
    width: number,
    height: number,
    framerate_num: number,
    framerate_den: number,
}
export type AudioStreamInfo = MediaStreamInfoCommon & {
    sample_rate: number
};

const allowedVideoCodec = new Set([
    AVCodecID.AV_CODEC_ID_H264,
    AVCodecID.AV_CODEC_ID_H265,
    AVCodecID.AV_CODEC_ID_VP8,
    AVCodecID.AV_CODEC_ID_VP9,
    AVCodecID.AV_CODEC_ID_AV1
]);

const allowedAudioCodec = new Set([
    AVCodecID.AV_CODEC_ID_OPUS
]);

function parseOpusPacketDuration(frame: Uint8Array)
{
    // https://datatracker.ietf.org/doc/html/rfc6716#section-3.1
    const frameSizes = [
        // SILK only, narrow band
        10, 20, 40, 60,

        // SILK only, medium band
        10, 20, 40, 60,

        // SILK only, wide band
        10, 20, 40, 60,

        // Hybrid, super wide band
        10, 20,

        // Hybrid, full band
        10, 20,

        // CELT only, narrow band
        2.5, 5, 10, 20,

        // CELT only, wide band
        2.5, 5, 10, 20,

        // CELT only, super wide band
        2.5, 5, 10, 20,

        // CELT only, full band
        2.5, 5, 10, 20
    ];

    const frameSize = 48000 / 1000 * frameSizes[frame[0] >> 3];

    let frameCount = 0;
    const c = frame[0] & 0b11;
    switch (c)
    {
        case 0:
            frameCount = 1;
            break;

        case 1:
        case 2:
            frameCount = 2;
            break;

        case 3:
            frameCount = frame[1] & 0b111111;
            break;
    }

    return frameSize * frameCount;
}

const idToStream = new Map<string, Readable>();
const libavInstance = LibAV.LibAV();
libavInstance.then((libav) => {
    libav.onread = (id) => {
        idToStream.get(id)?.resume();
    }
})

type DemuxerOptions = {
    format: "matroska" | "nut"
}

export async function demux(input: Readable, {
    format
}: DemuxerOptions) {
    const loggerInput = new Log("demux:input");
    const loggerFormat = new Log("demux:format");
    const loggerFrameCommon = new Log("demux:frame:common");
    const loggerFrameVideo = new Log("demux:frame:video");
    const loggerFrameAudio = new Log("demux:frame:audio");

    const libav = await libavInstance;
    const filename = uid();
    await libav.mkreaderdev(filename);
    idToStream.set(filename, input);

    const ondata = (chunk: Buffer) => {
        loggerInput.trace(`Received ${chunk.length} bytes of data for input ${filename}`);
        libav.ff_reader_dev_send(filename, chunk)
    };
    const onend = () => {
        loggerInput.trace(`Reached the end of input ${filename}`);
        libav.ff_reader_dev_send(filename, null);
    }
    input.on("data", ondata);
    input.on("end", onend);

    const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(filename, format);
    const pkt = await libav.av_packet_alloc();

    const cleanup = () => {
        vPipe.off("drain", readFrame);
        aPipe.off("drain", readFrame);
        input.off("data", ondata);
        input.off("end", onend);
        idToStream.delete(filename);
        vbsf && libav.av_bsf_free_js(vbsf);
        libav.avformat_close_input_js(fmt_ctx);
        libav.av_packet_free(pkt);
        libav.unlink(filename);
    }

    const vStream = streams.find((stream) => stream.codec_type === libav.AVMEDIA_TYPE_VIDEO)
    const aStream = streams.find((stream) => stream.codec_type === libav.AVMEDIA_TYPE_AUDIO)
    let vInfo: VideoStreamInfo | undefined
    let aInfo: AudioStreamInfo | undefined;
    const vPipe = new PassThrough({ objectMode: true, writableHighWaterMark: 128 });
    const aPipe = new PassThrough({ objectMode: true, writableHighWaterMark: 128 });

    let vbsf: number;
    if (vStream) {
        if (!allowedVideoCodec.has(vStream.codec_id)) {
            const codecName = await libav.avcodec_get_name(vStream.codec_id);
            cleanup();
            throw new Error(`Video codec ${codecName} is not allowed`)
        }
        let bsf = "null";
        switch (vStream.codec_id)
        {
            case AVCodecID.AV_CODEC_ID_H264:
                bsf = "h264_mp4toannexb,dump_extra";
                break;
            case AVCodecID.AV_CODEC_ID_HEVC:
                bsf = "hevc_mp4toannexb,dump_extra";
                break;
        }
        vbsf = await libav.av_bsf_list_parse_str_js(bsf);
        if (!vbsf)
            throw new Error(`Failed to construct bitstream filterchain: ${bsf}`);

        // av_bsf_free() will free par_in, so we have to make a copy of the original codecpar
        const par_in = await libav.avcodec_parameters_alloc();
        await libav.avcodec_parameters_copy(par_in, vStream.codecpar);
        await libav.AVBSFContext_par_in_s(vbsf, par_in);
        await libav.AVBSFContext_time_base_in_s(vbsf, vStream.time_base_num, vStream.time_base_den);
        await libav.av_bsf_init(vbsf);
        const codecpar_ptr = await libav.AVBSFContext_par_out(vbsf);
        const codecpar = await libav.ff_copyout_codecpar(codecpar_ptr);
        vInfo = {
            index: vStream.index,
            codec: vStream.codec_id,
            codecpar,
            width: codecpar.width ?? 0,
            height: codecpar.height ?? 0,
            framerate_num: await libav.AVCodecParameters_framerate_num(codecpar_ptr),
            framerate_den: await libav.AVCodecParameters_framerate_den(codecpar_ptr),
        }
        loggerFormat.info({
            info: vInfo
        }, `Found video stream in input ${filename}`)
    }
    if (aStream) {
        if (!allowedAudioCodec.has(aStream.codec_id)) {
            const codecName = await libav.avcodec_get_name(aStream.codec_id);
            cleanup();
            throw new Error(`Audio codec ${codecName} is not allowed`);
        }
        const codecpar = await libav.ff_copyout_codecpar(aStream.codecpar);
        aInfo = {
            index: aStream.index,
            codec: aStream.codec_id,
            codecpar,
            sample_rate: codecpar.sample_rate ?? 0
        }
        loggerFormat.info({
            info: aInfo
        }, `Found audio stream in input ${filename}`)
    }

    const readFrame = pDebounce.promise(async () => {
        let resume = true;
        while (resume) {
            const [status, streams] = await libav.ff_read_frame_multi(fmt_ctx, pkt, {
                limit: 1,
                unify: true,
                copyoutPacket: "ptr"
            });
            for (const packet of streams[0] ?? []) {
                const stream_index = await libav.AVPacket_stream_index(packet);
                if (vInfo && vInfo.index === stream_index) {
                    const packet_bsf: Packet[] = await libav.ff_bsf_multi(vbsf, pkt, [packet]);
                    packet_bsf.forEach((packet) => resume &&= vPipe.write(packet));
                    loggerFrameVideo.trace("Pushed a frame into the video pipe");
                    // packet is freed by ff_copyin_packet
                }
                else if (aInfo && aInfo.index === stream_index) {
                    const packet_copyout = await libav.ff_copyout_packet(packet);
                    packet_copyout.duration ||= parseOpusPacketDuration(packet_copyout.data);
                    resume &&= aPipe.write(packet_copyout);
                    loggerFrameAudio.trace("Pushed a frame into the audio pipe");
                    await libav.av_packet_free_js(packet);
                }
                else {
                    // Free unused packets to prevent memory leak
                    await libav.av_packet_free_js(packet);
                }
            }
            if (status < 0 && status !== -libav.EAGAIN) {
                // End of file, or some error happened
                if (status === LibAV.AVERROR_EOF)
                {
                    loggerFrameCommon.info("Reached end of stream. Stopping");
                    const packet_bsf: Packet[] = await libav.ff_bsf_multi(vbsf, pkt, [], { fin: true });
                    packet_bsf.forEach((packet) => resume &&= vPipe.write(packet));
                }
                else
                {
                    loggerFrameCommon.info({ status }, "Received an error during frame extraction. Stopping");
                }
                cleanup();
                vPipe.end();
                aPipe.end();
                return;
            }
            if (!resume) {
                input.pause();
                loggerInput.trace("Input stream paused");
            }
        }
    });
    vPipe.on("drain", () => {
        loggerFrameVideo.trace("Video pipe drained");
        readFrame();
    });
    aPipe.on("drain", () => {
        loggerFrameAudio.trace("Audio pipe drained");
        readFrame();
    });
    readFrame();
    return {
        video: vInfo ? { ...vInfo, stream: vPipe as Readable } : undefined,
        audio: aInfo ? { ...aInfo, stream: aPipe as Readable } : undefined
    }
}
