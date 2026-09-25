import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { Log } from "debug-level";
import {
  AVERROR_EAGAIN,
  AVERROR_EOF,
  AVFMT_FLAG_CUSTOM_IO,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_VIDEO,
  avGetCodecName,
  BitStreamFilterAPI,
  type CodecParameters,
  Dictionary,
  FFmpegError,
  FormatContext,
  InputFormat,
  IOStream,
  Packet,
  type Stream,
} from "node-av";
import pDebounce from "p-debounce";
import {
  H264NalUnitTypes,
  H265NalUnitTypes,
} from "../client/processing/AnnexBHelper.js";
import { AVCodecID } from "./LibavCodecId.js";

type MediaStreamInfoCommon = {
  index: number;
  codec: AVCodecID;
  codecpar: CodecParameters;
  avStream: Stream;
};

export type VideoStreamInfo = MediaStreamInfoCommon & {
  width: number;
  height: number;
  framerate_num: number;
  framerate_den: number;
};
export type AudioStreamInfo = MediaStreamInfoCommon & {
  sample_rate: number;
};

const allowedVideoCodec = new Set([
  AVCodecID.AV_CODEC_ID_H264,
  AVCodecID.AV_CODEC_ID_H265,
  AVCodecID.AV_CODEC_ID_VP8,
  AVCodecID.AV_CODEC_ID_VP9,
  AVCodecID.AV_CODEC_ID_AV1,
]);

const allowedAudioCodec = new Set([AVCodecID.AV_CODEC_ID_OPUS]);

function parseOpusPacketDuration(frame: Uint8Array) {
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
    2.5, 5, 10, 20,
  ];

  const frameSize = (48000 / 1000) * frameSizes[frame[0] >> 3];

  let frameCount = 0;
  const c = frame[0] & 0b11;
  switch (c) {
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

type DemuxerOptions = {
  format: "matroska" | "nut";
};

export async function demux(input: Readable, { format }: DemuxerOptions) {
  const loggerFormat = new Log("demux:format");
  const loggerFrameCommon = new Log("demux:frame:common");
  const loggerFrameVideo = new Log("demux:frame:video");
  const loggerFrameAudio = new Log("demux:frame:audio");

  const filename = randomUUID();

  // Low-level demux path (FormatContext + av_read_frame directly, no
  // high-level Demuxer wrapper): packets are pulled one at a time, gated by
  // downstream drain, so zero packets sit buffered here. The wrapper runs a
  // dedicated demux thread feeding a 100-packet queue, which sits permanently
  // full behind our 1x pacer (~1.2s of stale media) and forces matching slosh
  // in ffmpeg's mux queue upstream.
  const inputFormat = InputFormat.findInputFormat(format);
  if (!inputFormat) throw new Error(`Input format '${format}' not found`);

  const formatContext = new FormatContext();
  const ioContext = IOStream.create(input, { bufferSize: 8192 });
  try {
    formatContext.allocContext();
    formatContext.pb = ioContext;
    formatContext.setFlags(AVFMT_FLAG_CUSTOM_IO);
    const dict = Dictionary.fromObject({ fflags: "nobuffer" });
    const openRet = await formatContext.openInput("", inputFormat, dict);
    dict.free();
    FFmpegError.throwIfError(openRet, "Failed to open input");
    const infoRet = await formatContext.findStreamInfo(null);
    FFmpegError.throwIfError(infoRet, "Failed to find stream info");
  } catch (e) {
    input.destroy();
    try {
      ioContext.freeContext();
    } catch {}
    try {
      await formatContext.closeInput();
    } catch {}
    throw e;
  }

  const streams = formatContext.streams ?? [];
  const vStream = streams.find(
    (s) => s.codecpar.codecType === AVMEDIA_TYPE_VIDEO,
  );
  const aStream = streams.find(
    (s) => s.codecpar.codecType === AVMEDIA_TYPE_AUDIO,
  );

  let vInfo: VideoStreamInfo | undefined;
  let aInfo: AudioStreamInfo | undefined;
  const vPipe = new PassThrough({
    objectMode: true,
    highWaterMark: 0,
  });
  const aPipe = new PassThrough({
    objectMode: true,
    highWaterMark: 0,
  });
  const vbsf: BitStreamFilterAPI[] = [];

  // Scratch packet reused for every av_read_frame; downstream gets its own
  // clone. Freed on cleanup.
  const scratch = new Packet();
  scratch.alloc();

  const applyBitStreamFilters = async (
    input: Packet | null,
    filters: BitStreamFilterAPI[],
  ) => {
    let packets = [input];
    for (const filter of filters) {
      const newPackets: (Packet | null)[] = [];
      for (const packet of packets) {
        newPackets.push(...(await filter.filterAll(packet)));
        packet?.free();
      }
      if (!input) newPackets.push(null);
      packets = newPackets;
    }
    return packets;
  };

  /** Pull one packet straight from the input (null = EOF). */
  const readPacket = async (): Promise<Packet | null> => {
    for (;;) {
      const ret = await formatContext.readFrame(scratch);
      if (ret >= 0) {
        const pkt = scratch.clone();
        scratch.unref();
        if (!pkt) throw new Error("Failed to clone demuxed packet");
        const stream = streams.find((s) => s.index === pkt.streamIndex);
        if (stream) pkt.timeBase = stream.timeBase;
        return pkt;
      }
      if (FFmpegError.is(ret, AVERROR_EOF)) return null;
      // EAGAIN: no data available yet (quiet live source); retry shortly,
      // mirroring the high-level wrapper and ffmpeg CLI's av_usleep().
      if (FFmpegError.is(ret, AVERROR_EAGAIN)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw new FFmpegError(ret);
    }
  };

  const readFrame = pDebounce.promise(async () => {
    let resume = true;
    while (resume) {
      try {
        const inPacket = await readPacket();
        if (!inPacket) {
          loggerFrameCommon.info("Reached end of stream. Stopping");
          const packets = await applyBitStreamFilters(null, vbsf);
          for (const packet of packets) {
            if (packet) vPipe.write(packet);
          }
          cleanup();
          return;
        }
        const streamIndex = inPacket.streamIndex;
        if (vInfo && vInfo.index === streamIndex) {
          loggerFrameVideo.trace("Received a video packet");
          // The filter chain consumes and frees the input clone.
          const packets = await applyBitStreamFilters(inPacket, vbsf);
          for (const packet of packets) {
            if (packet) resume &&= vPipe.write(packet);
          }
        } else if (aInfo && aInfo.index === streamIndex) {
          const packet = inPacket;
          packet.duration ||= BigInt(parseOpusPacketDuration(packet.data!));
          resume &&= aPipe.write(packet);
        } else {
          // Stream with no consumer (e.g. subtitles): drop it so an
          // unconsumed stream can never stall the loop.
          inPacket.free();
        }
      } catch (e) {
        loggerFrameCommon.info(
          { error: e },
          "Received an error during frame extraction. Stopping",
        );
        cleanup();
        return;
      }
    }
  });

  let closed = false;
  const onVideoDrain = () => {
    loggerFrameVideo.trace("Video pipe drained");
    readFrame();
  };
  const onAudioDrain = () => {
    loggerFrameAudio.trace("Audio pipe drained");
    readFrame();
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    input.destroy();
    // Unblock a parked av_read_frame, then release the format context (which
    // detaches our IOContext) and free the IOContext itself.
    try {
      formatContext.interrupt();
    } catch {}
    void formatContext.closeInput(true).catch(() => {});
    try {
      ioContext.freeContext();
    } catch {}
    try {
      scratch.free();
    } catch {}
    vPipe.off("drain", onVideoDrain);
    aPipe.off("drain", onAudioDrain);
    vPipe.end();
    aPipe.end();
    for (const el of vbsf) el.close();
  };

  if (vStream) {
    const codecId = vStream.codecpar.codecId;
    if (!allowedVideoCodec.has(codecId)) {
      const codecName = avGetCodecName(codecId);
      cleanup();
      throw new Error(`Video codec ${codecName} is not allowed`);
    }
    try {
      switch (codecId) {
        case AVCodecID.AV_CODEC_ID_H264:
          vbsf.push(BitStreamFilterAPI.create("h264_mp4toannexb", vStream));
          // filter_units only inspects NAL headers (no CBS RBSP parsing),
          // so AUD removal stays tolerant of malformed filler.
          vbsf.push(
            BitStreamFilterAPI.create("filter_units", vbsf.at(-1)!, {
              options: {
                remove_types: String(H264NalUnitTypes.AccessUnitDelimiter),
              },
            }),
          );
          vbsf.push(BitStreamFilterAPI.create("dump_extra", vbsf.at(-1)!));
          break;
        case AVCodecID.AV_CODEC_ID_HEVC:
          vbsf.push(BitStreamFilterAPI.create("hevc_mp4toannexb", vStream));
          vbsf.push(
            BitStreamFilterAPI.create("filter_units", vbsf.at(-1)!, {
              options: {
                remove_types: String(H265NalUnitTypes.AUD_NUT),
              },
            }),
          );
          vbsf.push(BitStreamFilterAPI.create("dump_extra", vbsf.at(-1)!));
          break;
        default:
          vbsf.push(BitStreamFilterAPI.create("null", vStream));
          break;
      }
    } catch (e) {
      cleanup();
      throw new Error("Failed to construct bitstream filterchain", {
        cause: (e as Error).cause,
      });
    }

    const codecpar = vStream.codecpar;
    vInfo = {
      index: vStream.index,
      codec: codecId,
      codecpar,
      width: codecpar.width ?? 0,
      height: codecpar.height ?? 0,
      framerate_num: codecpar.frameRate.num,
      framerate_den: codecpar.frameRate.den,
      avStream: vStream,
    };
    loggerFormat.info(
      {
        info: vInfo,
      },
      `Found video stream in input ${filename}`,
    );
  }
  if (aStream) {
    const codecId = aStream.codecpar.codecId;
    if (!allowedAudioCodec.has(codecId)) {
      const codecName = avGetCodecName(codecId);
      cleanup();
      throw new Error(`Audio codec ${codecName} is not allowed`);
    }
    aInfo = {
      index: aStream.index,
      codec: codecId,
      codecpar: aStream.codecpar,
      sample_rate: aStream.codecpar.sampleRate || 0,
      avStream: aStream,
    };
    loggerFormat.info(
      {
        info: aInfo,
      },
      `Found audio stream in input ${filename}`,
    );
  }

  vPipe.on("drain", onVideoDrain);
  aPipe.on("drain", onAudioDrain);
  readFrame();
  return {
    video: vInfo ? { ...vInfo, stream: vPipe as Readable } : undefined,
    audio: aInfo ? { ...aInfo, stream: aPipe as Readable } : undefined,
  };
}
