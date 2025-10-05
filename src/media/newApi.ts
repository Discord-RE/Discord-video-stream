import ffmpeg from 'fluent-ffmpeg';
import pDebounce from 'p-debounce';
import sharp from 'sharp';
import Log from 'debug-level';
import { PassThrough, type Readable } from "node:stream";
import { demux } from './LibavDemuxer.js';
import { VideoStream } from './VideoStream.js';
import { AudioStream } from './AudioStream.js';
import { isBun, isDeno, isFiniteNonZero } from '../utils.js';
import { AVCodecID } from './LibavCodecId.js';
import { createDecoder } from './LibavDecoder.js';
import { Encoders } from './encoders/index.js';
import type { Request } from 'zeromq';

import LibAV from '@lng2004/libav.js-variant-webcodecs-avf-with-decoders';
import type { SupportedVideoCodec } from '../utils.js';
import type { MediaUdp, Streamer } from '../client/index.js';
import type { EncoderSettingsGetter } from './encoders/index.js';
import type { VideoStreamInfo } from './LibavDemuxer.js';

export type PrepareStreamOptions = {
    /**
     * Disable video transcoding
     * If enabled, all video related settings have no effects, and the input
     * video stream is used as-is.
     * 
     * You need to ensure that the video stream has the right properties
     * (keyframe every 1s, B-frames disabled). Failure to do so will result in
     * a glitchy stream, or degraded performance
     */
    noTranscoding: boolean,

    /**
     * Video width
     */
    width: number,

    /**
     * Video height
     */
    height: number,

    /**
     * Video frame rate
     */
    frameRate?: number,

    /**
     * Video codec
     */
    videoCodec: SupportedVideoCodec,

    /**
     * Video average bitrate in kbps
     */
    bitrateVideo: number,

    /**
     * Video max bitrate in kbps
     */
    bitrateVideoMax: number,

    /**
     * Audio bitrate in kbps
     */
    bitrateAudio: number,

    /**
     * Enable audio output
     */
    includeAudio: boolean,

    /**
     * Functions to get encoder settings
     * This function will receive the average and max bitrate as the input, and
     * returns an object containing encoder settings for the supported codecs
     */
    encoder: EncoderSettingsGetter

    /**
     * Enable hardware accelerated decoding
     */
    hardwareAcceleratedDecoding: boolean,

    /**
     * Add some options to minimize latency
     */
    minimizeLatency: boolean,

    /**
     * Custom headers for HTTP requests
     */
    customHeaders: Record<string, string>,

    /**
     * Custom ffmpeg flags/options to pass directly to ffmpeg
     * These will be added to the command after other options
     */
    customFfmpegFlags: string[]
}

export type Controller = {
    volume: number,
    setVolume(newVolume: number): Promise<boolean>
};

export function prepareStream(
    input: string | Readable,
    options: Partial<PrepareStreamOptions> = {},
    cancelSignal?: AbortSignal
) {
    cancelSignal?.throwIfAborted();
    const defaultOptions = {
        noTranscoding: false,
        // negative values = resize by aspect ratio, see https://trac.ffmpeg.org/wiki/Scaling
        width: -2,
        height: -2,
        frameRate: undefined,
        videoCodec: "H264",
        bitrateVideo: 5000,
        bitrateVideoMax: 7000,
        bitrateAudio: 128,
        includeAudio: true,
        encoder: Encoders.software(),
        hardwareAcceleratedDecoding: false,
        minimizeLatency: false,
        customHeaders: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.3",
            "Connection": "keep-alive",
        },
        customFfmpegFlags: []
    } satisfies PrepareStreamOptions;

    function mergeOptions(opts: Partial<PrepareStreamOptions>) {
        return {
            noTranscoding:
                opts.noTranscoding ?? defaultOptions.noTranscoding,

            width:
                isFiniteNonZero(opts.width) ? Math.round(opts.width) : defaultOptions.width,

            height:
                isFiniteNonZero(opts.height) ? Math.round(opts.height) : defaultOptions.height,

            frameRate:
                isFiniteNonZero(opts.frameRate) && opts.frameRate > 0
                    ? opts.frameRate
                    : defaultOptions.frameRate,

            videoCodec:
                opts.videoCodec ?? defaultOptions.videoCodec,

            bitrateVideo:
                isFiniteNonZero(opts.bitrateVideo) && opts.bitrateVideo > 0
                    ? Math.round(opts.bitrateVideo)
                    : defaultOptions.bitrateVideo,

            bitrateVideoMax:
                isFiniteNonZero(opts.bitrateVideoMax) && opts.bitrateVideoMax > 0
                    ? Math.round(opts.bitrateVideoMax)
                    : defaultOptions.bitrateVideoMax,

            bitrateAudio:
                isFiniteNonZero(opts.bitrateAudio) && opts.bitrateAudio > 0
                    ? Math.round(opts.bitrateAudio)
                    : defaultOptions.bitrateAudio,

            encoder:
                opts.encoder ?? defaultOptions.encoder,

            includeAudio:
                opts.includeAudio ?? defaultOptions.includeAudio,

            hardwareAcceleratedDecoding:
                opts.hardwareAcceleratedDecoding ?? defaultOptions.hardwareAcceleratedDecoding,

            minimizeLatency:
                opts.minimizeLatency ?? defaultOptions.minimizeLatency,

            customHeaders: {
                ...defaultOptions.customHeaders, ...opts.customHeaders
            },

            customFfmpegFlags:
                opts.customFfmpegFlags ?? defaultOptions.customFfmpegFlags
        } satisfies PrepareStreamOptions
    }

    const mergedOptions = mergeOptions(options);

    let isHttpUrl = false;
    let isHls = false;
    let isSrt = false;

    if (typeof input === "string") {
        isHttpUrl = input.startsWith('http') || input.startsWith('https');
        isHls = input.includes('m3u');
        isSrt = input.startsWith("srt://");
    }

    const output = new PassThrough();

    // command creation
    const command = ffmpeg(input)
        .addOption('-loglevel', 'info')

    // input options
    const { hardwareAcceleratedDecoding, minimizeLatency, customHeaders } = mergedOptions;
    if (hardwareAcceleratedDecoding)
        command.inputOption('-hwaccel', 'auto');

    if (minimizeLatency) {
        command.addOptions([
            '-fflags nobuffer',
            '-analyzeduration 0'
        ])
    }

    if (isHttpUrl) {
        command.inputOption('-headers',
            Object.entries(customHeaders).map(([k, v]) => `${k}: ${v}`).join("\r\n")
        );
        if (!isHls) {
            command.inputOptions([
                '-reconnect 1',
                '-reconnect_at_eof 1',
                '-reconnect_streamed 1',
                '-reconnect_delay_max 4294'
            ]);
        }
    }

    if (isSrt)
    {
        command.inputOption("-scan_all_pmts 0");
    }

    // general output options
    command
        .output(output)
        .outputFormat("nut");

    // video setup
    const {
        noTranscoding, width, height, frameRate, bitrateVideo, bitrateVideoMax, videoCodec, encoder
    } = mergedOptions;
    command.addOutputOption("-map 0:v");

    if (noTranscoding)
    {
        command.videoCodec("copy");
    }
    else
    {
        command.videoFilter(`scale=${width}:${height}`)

        if (frameRate)
            command.fpsOutput(frameRate);

        command.addOutputOption([
            "-b:v", `${bitrateVideo}k`,
            "-maxrate:v", `${bitrateVideoMax}k`,
            "-bf", "0",
            "-pix_fmt", "yuv420p",
            "-force_key_frames", "expr:gte(t,n_forced*1)"
        ]);

        const encoderSettings = encoder(bitrateVideo, bitrateVideoMax)[videoCodec];
        if (!encoderSettings)
            throw new Error(`Encoder settings not specified for ${videoCodec}`);
        command
            .videoCodec(encoderSettings.name)
            .outputOptions(encoderSettings.options);
    }

    // audio setup
    const { includeAudio, bitrateAudio } = mergedOptions;
    if (includeAudio)
        command
            .addOutputOption("-map 0:a?")
            .audioChannels(2)
            /*
             * I don't have much surround sound material to test this with,
             * if you do and you have better settings for this, feel free to
             * contribute!
             */
            .addOutputOption("-lfe_mix_level 1")
            .audioFrequency(48000)
            .audioCodec("libopus")
            .audioBitrate(`${bitrateAudio}k`)
            .audioFilters("volume@internal_lib=1.0")

    // Add custom ffmpeg flags
    if (mergedOptions.customFfmpegFlags && mergedOptions.customFfmpegFlags.length > 0) {
        command.addOptions(mergedOptions.customFfmpegFlags);
    }

    // exit handling
    const promise = new Promise<void>((resolve, reject) => {
        command.on("error", (err) => {
            if (cancelSignal?.aborted)
                /**
                 * fluent-ffmpeg might throw an error when SIGTERM is sent to
                 * the process, so we check if the abort signal is triggered
                 * and throw that instead
                 */
                reject(cancelSignal.reason);
            else
                reject(err);
        });
        command.on("end", () => resolve());
    })
    promise.catch(() => {});
    cancelSignal?.addEventListener("abort", () => command.kill("SIGTERM"), { once: true });

    // realtime control mechanism
    let currentVolume = 1;
    let zmqClientPromise: Promise<Request> | undefined;
    if (includeAudio && !isBun() && !isDeno())
    {
        function randomInclusive(start: number, end: number)
        {
            return Math.floor(Math.random() * (end - start + 1)) + start;
        }
        // Last octet is from 2 to 254 to avoid WSL2 shenanigans
        const loopbackIp = [
            127, randomInclusive(0, 255), randomInclusive(0, 255), randomInclusive(2, 254)
        ].join(".");
        const zmqEndpoint = `tcp://${loopbackIp}:42069`;
        command.audioFilters(`azmq=b=${zmqEndpoint.replaceAll(":","\\\\:")}`);
        zmqClientPromise = import("zeromq").then(zmq => {
            const client = new zmq.Request({ sendTimeout: 5000, receiveTimeout: 5000 });
            client.connect(zmqEndpoint);
            promise.finally(() => client.disconnect(zmqEndpoint));
            return client;
        });
    }

    command.run();

    return {
        command,
        output,
        promise,
        controller: {
            get volume() {
                return currentVolume;
            },
            async setVolume(newVolume: number)
            {
                if (newVolume < 0)
                    return false;
                try
                {
                    if (!zmqClientPromise)
                        return false;
                    const client = await zmqClientPromise;
                    await client.send(`volume@internal_lib volume ${newVolume}`);
                    const [res] = await client.receive();
                    if (res.toString("utf-8").split(" ")[0] !== "0")
                        return false;
                    currentVolume = newVolume;
                    return true;
                }
                catch
                {
                    return false;
                }
            }
        } satisfies Controller
    }
}

export type PlayStreamOptions = {
    /**
     * Set stream type as "Go Live" or camera stream
     */
    type: "go-live" | "camera",

    /**
     * Set format of the stream
     */
    format: "matroska" | "nut",

    /**
     * Override video width sent to Discord.
     * 
     * DO NOT SPECIFY UNLESS YOU KNOW WHAT YOU'RE DOING!
     */
    width: number | ((v: VideoStreamInfo) => number),

    /**
     * Override video height sent to Discord.
     * 
     * DO NOT SPECIFY UNLESS YOU KNOW WHAT YOU'RE DOING!
     */
    height: number | ((v: VideoStreamInfo) => number),

    /**
     * Override video frame rate sent to Discord.
     * 
     * DO NOT SPECIFY UNLESS YOU KNOW WHAT YOU'RE DOING!
     */
    frameRate: number | ((v: VideoStreamInfo) => number),

    /**
     * Same as ffmpeg's `readrate_initial_burst` command line flag
     * 
     * See https://ffmpeg.org/ffmpeg.html#:~:text=%2Dreadrate_initial_burst
     */
    readrateInitialBurst: number | undefined,

    /**
     * Enable stream preview from input stream (experimental)
     */
    streamPreview: boolean,
}

export async function playStream(
    input: Readable, streamer: Streamer,
    options: Partial<PlayStreamOptions> = {},
    cancelSignal?: AbortSignal
)
{
    const logger = new Log("playStream");
    cancelSignal?.throwIfAborted();
    if (!streamer.voiceConnection)
        throw new Error("Bot is not connected to a voice channel");

    const defaultOptions = {
        type: "go-live",
        format: "nut",
        width: (video) => video.width,
        height: (video) => video.height,
        frameRate: (video) => (video.framerate_num / video.framerate_den),
        readrateInitialBurst: undefined,
        streamPreview: false,
    } satisfies PlayStreamOptions;

    function mergeOptions(opts: Partial<PlayStreamOptions>)
    {
        return {
            type:
                opts.type ?? defaultOptions.type,

            format:
                opts.format ?? defaultOptions.format,

            width:
                typeof opts.width === "function" || (isFiniteNonZero(opts.width) && opts.width > 0)
                    ? opts.width
                    : defaultOptions.width,

            height:
                typeof opts.height === "function" || (isFiniteNonZero(opts.height) && opts.height > 0)
                    ? opts.height
                    : defaultOptions.height,

            frameRate:
                typeof opts.frameRate === "function" || (isFiniteNonZero(opts.frameRate) && opts.frameRate > 0)
                    ? opts.frameRate
                    : defaultOptions.frameRate,

            readrateInitialBurst:
                isFiniteNonZero(opts.readrateInitialBurst) && opts.readrateInitialBurst > 0
                    ? opts.readrateInitialBurst
                    : defaultOptions.readrateInitialBurst,

            streamPreview:
                opts.streamPreview ?? defaultOptions.streamPreview,
        } satisfies PlayStreamOptions
    }

    const mergedOptions = mergeOptions(options);
    logger.debug({ options: mergedOptions }, "Merged options");

    logger.debug("Initializing demuxer");
    const { video, audio } = await demux(input, {
        format: mergedOptions.format
    });
    cancelSignal?.throwIfAborted();

    if (!video)
        throw new Error("No video stream in media");

    const cleanupFuncs: (() => unknown)[] = [];
    const videoCodecMap: Record<number, SupportedVideoCodec> = {
        [AVCodecID.AV_CODEC_ID_H264]: "H264",
        [AVCodecID.AV_CODEC_ID_H265]: "H265",
        [AVCodecID.AV_CODEC_ID_VP8]: "VP8",
        [AVCodecID.AV_CODEC_ID_VP9]: "VP9",
        [AVCodecID.AV_CODEC_ID_AV1]: "AV1"
    }

    let udp: MediaUdp;
    let stopStream: () => unknown;
    if (mergedOptions.type === "go-live")
    {
        udp = await streamer.createStream();
        stopStream = () => streamer.stopStream();
    }
    else
    {
        udp = streamer.voiceConnection.udp;
        streamer.signalVideo(true);
        stopStream = () => streamer.signalVideo(false);
    }
    udp.setPacketizer(videoCodecMap[video.codec]);
    udp.mediaConnection.setSpeaking(true);
    const { width, height, frameRate } = mergedOptions;
    udp.mediaConnection.setVideoAttributes(true, {
        width: Math.round(typeof width === "function" ? width(video) : width),
        height: Math.round(typeof height === "function" ? height(video) : height),
        fps: Math.round(typeof frameRate === "function" ? frameRate(video) : frameRate)
    });

    const vStream = new VideoStream(udp);
    video.stream.pipe(vStream);
    if (audio)
    {
        const aStream = new AudioStream(udp);
        audio.stream.pipe(aStream);
        vStream.syncStream = aStream;

        const burstTime = mergedOptions.readrateInitialBurst;
        if (typeof burstTime === "number")
        {
            vStream.sync = false;
            vStream.noSleep = aStream.noSleep = true;
            const stopBurst = (pts: number) => {
                if (pts < burstTime * 1000)
                    return;
                vStream.sync = true;
                vStream.noSleep = aStream.noSleep = false;
                vStream.off("pts", stopBurst);
            }
            vStream.on("pts", stopBurst);
        }
    }
    if (mergedOptions.streamPreview && mergedOptions.type === "go-live")
    {
        (async () => {
            const logger = new Log("playStream:preview");
            logger.debug("Initializing decoder for stream preview");
            const decoder = await createDecoder(video.codec, video.codecpar);
            if (!decoder)
            {
                logger.warn("Failed to initialize decoder. Stream preview will be disabled");
                return;
            }
            cleanupFuncs.push(() => {
                logger.debug("Freeing decoder");
                decoder.free();
            });
            const updatePreview = pDebounce.promise(async (packet: LibAV.Packet) => {
                if (!(packet.flags !== undefined && packet.flags & LibAV.AV_PKT_FLAG_KEY))
                    return;
                const decodeStart = performance.now();
                const [frame] = await decoder.decode([packet]).catch((e) => {
                    logger.error(e, "Failed to decode the frame");
                    return []
                });
                if (!frame)
                    return;
                const decodeEnd = performance.now();
                logger.debug(`Decoding a frame took ${decodeEnd - decodeStart}ms`);

                return sharp(frame.data, {
                    raw: {
                        width: frame.width ?? 0,
                        height: frame.height ?? 0,
                        channels: 4
                    }
                })
                .resize(1024, 576, { fit: "inside" })
                .jpeg()
                .toBuffer()
                .then(image => streamer.setStreamPreview(image))
                .catch(() => {});
            });
            video.stream.on("data", updatePreview);
            cleanupFuncs.push(() => video.stream.off("data", updatePreview));
        })();
    }
    return new Promise<void>((resolve, reject) => {
        cleanupFuncs.push(() => {
            stopStream();
            udp.mediaConnection.setSpeaking(false);
            udp.mediaConnection.setVideoAttributes(false);
        });
        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp)
                return;
            cleanedUp = true;
            for (const f of cleanupFuncs)
                f();
        }
        cancelSignal?.addEventListener("abort", () => {
            cleanup();
            reject(cancelSignal.reason);
        }, { once: true })
        vStream.once("finish", () => {
            if (cancelSignal?.aborted)
                return;
            cleanup();
            resolve();
        });
    }).catch(() => {});
}
