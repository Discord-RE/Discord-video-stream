import { PassThrough, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import Log from "debug-level";
import {
  AV_CHANNEL_ORDER_NATIVE,
  AV_CODEC_FLAG_LOW_DELAY,
  AV_LOG_DEBUG,
  AV_LOG_ERROR,
  AV_LOG_FATAL,
  AV_LOG_INFO,
  AV_LOG_PANIC,
  AV_LOG_QUIET,
  AV_LOG_TRACE,
  AV_LOG_VERBOSE,
  AV_LOG_WARNING,
  AV_PKT_FLAG_KEY,
  Log as AVLog,
  type AVLogLevel,
  avGetCodecName,
  type BitStreamFilterAPI,
  type CodecContext,
  Decoder,
  type DecoderOptions,
  Demuxer,
  Encoder,
  type EncoderOptions,
  type Frame,
  FF_ENCODER_LIBOPUS,
  FilterAPI,
  HardwareContext,
  InputFormat,
  pipeline,
  type Packet,
} from "node-av";
import pDebounce from "p-debounce";
import sharp from "sharp";
import type { Streamer } from "../client/index.js";
import type { WebRtcConnWrapper } from "../client/voice/WebRtcWrapper.js";
import type { SupportedVideoCodec } from "../utils.js";
import { isFiniteNonZero } from "../utils.js";
import { AudioStream } from "./AudioStream.js";
import type { EncoderSettingsGetter } from "./encoders/index.js";
import { Encoders, hardwareForEncoder } from "./encoders/index.js";
import { AVCodecID } from "./LibavCodecId.js";
import { createDecoder } from "./LibavDecoder.js";
import {
  type AudioStreamInfo,
  allowedVideoCodec,
  createVideoBitStreamFilters,
  demux,
  streamFrameRate,
  type VideoStreamInfo,
} from "./LibavDemuxer.js";
import { VideoStream } from "./VideoStream.js";

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
  noTranscoding: boolean;

  /**
   * Video width
   */
  width: number;

  /**
   * Video height
   */
  height: number;

  /**
   * Video frame rate
   */
  frameRate?: number;

  /**
   * Video codec
   */
  videoCodec: SupportedVideoCodec;

  /**
   * Video average bitrate in kbps
   */
  bitrateVideo: number;

  /**
   * Video max bitrate in kbps
   */
  bitrateVideoMax: number;

  /**
   * Audio bitrate in kbps
   */
  bitrateAudio: number;

  /**
   * Enable audio output
   */
  includeAudio: boolean;

  /**
   * Functions to get encoder settings
   * This function will receive the average and max bitrate as the input, and
   * returns an object containing encoder settings for the supported codecs
   */
  encoder: EncoderSettingsGetter;

  /**
   * Add some options to minimize latency
   */
  minimizeLatency: boolean;

  /**
   * Custom headers for HTTP requests
   */
  customHeaders: Record<string, string>;

  /**
   * Custom input options to pass directly to ffmpeg
   * These will be added to the command before other options
   *
   * NOTE: this option only applies to the ffmpeg CLI, and is ignored when
   * transcoding in-process
   */
  customInputOptions: string[];

  /**
   * Custom ffmpeg flags/options to pass directly to ffmpeg
   * These will be added to the command after other options
   *
   * NOTE: this option only applies to the ffmpeg CLI, and is ignored when
   * transcoding in-process
   */
  customFfmpegFlags: string[];

  /**
   * FFmpeg log level
   */
  logLevel:
    | "quiet"
    | "panic"
    | "fatal"
    | "error"
    | "warning"
    | "info"
    | "verbose"
    | "debug"
    | "trace";
};

export type Controller = {
  volume: number;
  setVolume(newVolume: number): Promise<boolean>;
};

export type PreparedStream = {
  /**
   * The encoded video packet stream, ready to be sent to Discord
   */
  video: VideoStreamInfo & { stream: Readable };

  /**
   * The encoded audio packet stream, ready to be sent to Discord
   */
  audio?: AudioStreamInfo & { stream: Readable };
};

export type PrepareStreamResult = {
  output: PreparedStream;

  /**
   * Resolves when the transcode pipeline finished processing the input,
   * rejects when the pipeline failed or was cancelled
   */
  promise: Promise<unknown>;

  controller: Controller;
};

const videoCodecMap: Record<number, SupportedVideoCodec> = {
  [AVCodecID.AV_CODEC_ID_H264]: "H264",
  [AVCodecID.AV_CODEC_ID_H265]: "H265",
  [AVCodecID.AV_CODEC_ID_VP8]: "VP8",
  [AVCodecID.AV_CODEC_ID_VP9]: "VP9",
  [AVCodecID.AV_CODEC_ID_AV1]: "AV1",
};

const preparedVideoCodecMap: Record<SupportedVideoCodec, AVCodecID> = {
  H264: AVCodecID.AV_CODEC_ID_H264,
  H265: AVCodecID.AV_CODEC_ID_HEVC,
  VP8: AVCodecID.AV_CODEC_ID_VP8,
  VP9: AVCodecID.AV_CODEC_ID_VP9,
  AV1: AVCodecID.AV_CODEC_ID_AV1,
};

const avLogLevels = {
  quiet: AV_LOG_QUIET,
  panic: AV_LOG_PANIC,
  fatal: AV_LOG_FATAL,
  error: AV_LOG_ERROR,
  warning: AV_LOG_WARNING,
  info: AV_LOG_INFO,
  verbose: AV_LOG_VERBOSE,
  debug: AV_LOG_DEBUG,
  trace: AV_LOG_TRACE,
} satisfies Record<PrepareStreamOptions["logLevel"], AVLogLevel>;

function roundEven(n: number) {
  return n % 2 === 0 ? n : n + 1;
}

/**
 * Compute the output video dimensions like ffmpeg's scale filter does with
 * negative values (negative values = resize by aspect ratio,
 * see https://trac.ffmpeg.org/wiki/Scaling)
 */
function computeScaledDims(
  inWidth: number,
  inHeight: number,
  width: number,
  height: number,
) {
  if (inWidth <= 0 || inHeight <= 0) {
    return {
      width: width > 0 ? width : inWidth,
      height: height > 0 ? height : inHeight,
    };
  }
  if (width < 0 && height < 0) {
    return { width: roundEven(inWidth), height: roundEven(inHeight) };
  }
  if (width < 0) {
    return { width: roundEven((height * inWidth) / inHeight), height };
  }
  if (height < 0) {
    return { width, height: roundEven((width * inHeight) / inWidth) };
  }
  return { width, height };
}

/**
 * Read the first bytes of the stream, mirroring ffmpeg's incremental probing,
 * to detect the container format. `Demuxer.open` requires an explicit format
 * for Readable inputs, so the consumed bytes are replayed into the demuxer
 * through a wrapper stream.
 */
async function readProbeBuffer(stream: Readable): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < 2 ** 20) {
    const chunk: Buffer | null = await new Promise((resolve) => {
      if (stream.readableEnded || stream.destroyed) {
        resolve(null);
        return;
      }
      const buffered: Buffer | null = stream.read();
      if (buffered) {
        resolve(buffered);
        return;
      }
      const cleanup = () => {
        stream.off("readable", onReadable);
        stream.off("end", onEnd);
        stream.off("error", onError);
      };
      const onReadable = () => {
        cleanup();
        resolve(stream.read());
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const onError = () => {
        cleanup();
        resolve(null);
      };
      stream.once("readable", onReadable);
      stream.once("end", onEnd);
      stream.once("error", onError);
    });
    if (!chunk) break;
    chunks.push(chunk);
    size += chunk.length;
    if (InputFormat.probe(Buffer.concat(chunks))) break;
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

/**
 * Strip the null flush markers a pipeline generator yields at the end of the
 * stream, so the generator can be consumed by `Readable.from`, which rejects
 * null values instead of treating them as the end of the stream
 * (see https://github.com/nodejs/node/issues/32845).
 */
function withoutFlushMarkers(source: AsyncGenerator<Packet | Frame | null>) {
  return (async function* () {
    for await (const packet of source) {
      if (packet === null) return;
      yield packet;
    }
  })();
}

export async function prepareStream(
  input: string | Readable,
  options: Partial<PrepareStreamOptions> = {},
  cancelSignal?: AbortSignal,
): Promise<PrepareStreamResult> {
  cancelSignal?.throwIfAborted();

  const logger = new Log("prepareStream");
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
    minimizeLatency: false,
    customHeaders: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.3",
      Connection: "keep-alive",
    },
    customInputOptions: [],
    customFfmpegFlags: [],
    logLevel: "verbose",
  } satisfies PrepareStreamOptions;

  function mergeOptions(opts: Partial<PrepareStreamOptions>) {
    return {
      noTranscoding: opts.noTranscoding ?? defaultOptions.noTranscoding,

      width: isFiniteNonZero(opts.width)
        ? Math.round(opts.width)
        : defaultOptions.width,

      height: isFiniteNonZero(opts.height)
        ? Math.round(opts.height)
        : defaultOptions.height,

      frameRate:
        isFiniteNonZero(opts.frameRate) && opts.frameRate > 0
          ? opts.frameRate
          : defaultOptions.frameRate,

      videoCodec: opts.videoCodec ?? defaultOptions.videoCodec,

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

      encoder: opts.encoder ?? defaultOptions.encoder,

      includeAudio: opts.includeAudio ?? defaultOptions.includeAudio,

      minimizeLatency: opts.minimizeLatency ?? defaultOptions.minimizeLatency,

      customHeaders: {
        ...defaultOptions.customHeaders,
        ...opts.customHeaders,
      },

      customInputOptions:
        opts.customInputOptions ?? defaultOptions.customInputOptions,

      customFfmpegFlags:
        opts.customFfmpegFlags ?? defaultOptions.customFfmpegFlags,

      logLevel: opts.logLevel ?? defaultOptions.logLevel,
    } satisfies PrepareStreamOptions;
  }

  const mergedOptions = mergeOptions(options);
  const {
    noTranscoding,
    width,
    height,
    frameRate,
    bitrateVideo,
    bitrateVideoMax,
    videoCodec,
    encoder: encoderGetter,
    includeAudio,
    bitrateAudio,
    minimizeLatency,
    customHeaders,
    customInputOptions,
    customFfmpegFlags,
    logLevel,
  } = mergedOptions;

  AVLog.setLevel(avLogLevels[logLevel]);

  if (customInputOptions.length > 0 || customFfmpegFlags.length > 0) {
    logger.warn(
      "customInputOptions and customFfmpegFlags only apply to the ffmpeg CLI; they are ignored when transcoding in-process",
    );
  }

  let isHttpUrl = false;
  let isHls = false;
  let isSrt = false;

  if (typeof input === "string") {
    isHttpUrl = input.startsWith("http") || input.startsWith("https");
    isHls = input.includes("m3u");
    isSrt = input.startsWith("srt://");
  }

  const inputOptions: Record<string, string | number> = {};

  if (minimizeLatency) {
    inputOptions.fflags = "nobuffer";
    inputOptions.max_delay = 100000;
  }

  if (isHttpUrl) {
    inputOptions.headers = Object.entries(customHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    if (!isHls) {
      inputOptions.reconnect = "1";
      inputOptions.reconnect_at_eof = "1";
      inputOptions.reconnect_streamed = "1";
      inputOptions.reconnect_delay_max = "4294";
    }
  }

  if (isSrt) {
    inputOptions.scan_all_pmts = "0";
  }

  // demuxer creation
  let demuxer: Demuxer;
  let probeWrapper: PassThrough | undefined;
  try {
    if (typeof input === "string") {
      demuxer = await Demuxer.open(input, {
        options: inputOptions,
        bufferSize: 8192,
        signal: cancelSignal,
      });
    } else {
      const probedBuffer = await readProbeBuffer(input);
      if (!probedBuffer) {
        input.destroy();
        throw new Error("Input stream ended before its format could be probed");
      }
      const probedFormat = InputFormat.probe(probedBuffer)?.name;
      if (!probedFormat) {
        input.destroy();
        throw new Error("Could not detect the input format");
      }
      probeWrapper = new PassThrough();
      probeWrapper.write(probedBuffer);
      input.pipe(probeWrapper);
      demuxer = await Demuxer.open(probeWrapper, {
        options: inputOptions,
        bufferSize: 8192,
        signal: cancelSignal,
        format: probedFormat,
      });
    }
  } catch (e) {
    if (typeof input !== "string") input.destroy();
    throw new Error("Failed to open input", { cause: e });
  }

  const vStream = demuxer.video();
  const aStream = demuxer.audio();

  // video transcode pipeline (decoder -> filters -> encoder)
  let videoDecoder: Decoder | undefined;
  let videoFilter: FilterAPI | undefined;
  let videoEncoder: Encoder | undefined;

  // audio pipeline (decoder -> volume filter -> encoder)
  let audioDecoder: Decoder | undefined;
  let audioFilter: FilterAPI | undefined;
  let audioEncoder: Encoder | undefined;

  let vbsf: BitStreamFilterAPI[] = [];

  const closePipeline = () => {
    demuxer.close();
    probeWrapper?.destroy();
    if (typeof input !== "string") input.destroy();
    for (const filter of vbsf) filter.close();
    videoFilter?.close();
    videoDecoder?.close();
    videoEncoder?.close();
    audioFilter?.close();
    audioDecoder?.close();
    audioEncoder?.close();
  };

  if (!vStream) {
    closePipeline();
    throw new Error("No video stream in media");
  }

  if (noTranscoding && !allowedVideoCodec.has(vStream.codecpar.codecId)) {
    const codecName = avGetCodecName(vStream.codecpar.codecId);
    closePipeline();
    throw new Error(`Video codec ${codecName} is not allowed`);
  }

  // only the passthrough path needs the mp4 -> annexb conversion: encoders
  // created without a global header flag already emit annexb, with the
  // parameter sets repeated before each keyframe
  vbsf = noTranscoding ? createVideoBitStreamFilters(vStream) : [];

  const codecpar = vStream.codecpar;
  const inWidth = codecpar.width ?? 0;
  const inHeight = codecpar.height ?? 0;
  const sourceFramerate = streamFrameRate(vStream);
  const { width: outWidth, height: outHeight } = computeScaledDims(
    inWidth,
    inHeight,
    width,
    height,
  );

  let vInfo: VideoStreamInfo;
  if (noTranscoding) {
    vInfo = {
      index: vStream.index,
      codec: codecpar.codecId,
      codecpar,
      width: inWidth,
      height: inHeight,
      framerate_num: sourceFramerate.num,
      framerate_den: sourceFramerate.den,
      avStream: vStream,
    };
  } else {
    vInfo = {
      index: vStream.index,
      // packets fed to Discord are the encoder output, not the input codec
      codec: preparedVideoCodecMap[videoCodec],
      codecpar,
      width: outWidth,
      height: outHeight,
      framerate_num: frameRate ?? sourceFramerate.num,
      framerate_den: frameRate ? 1 : sourceFramerate.den,
      avStream: vStream,
    };
  }
  logger.info({ info: vInfo }, "Prepared video stream");

  let aInfo: AudioStreamInfo | undefined;
  if (includeAudio && aStream) {
    aInfo = {
      index: aStream.index,
      codec: aStream.codecpar.codecId,
      codecpar: aStream.codecpar,
      sample_rate: aStream.codecpar.sampleRate || 0,
      avStream: aStream,
    };
    logger.info({ info: aInfo }, "Prepared audio stream");
  }

  if (!noTranscoding) {
    const encoderSettings = encoderGetter(bitrateVideo, bitrateVideoMax)[
      videoCodec
    ];
    if (!encoderSettings) {
      closePipeline();
      throw new Error(`Encoder settings not specified for ${videoCodec}`);
    }

    // Deduce the hardware context from the encoder name (e.g. "h264_vaapi" ->
    // VAAPI), so any hardware encoder works without per-encoder special cases
    const hw = hardwareForEncoder(encoderSettings.name);
    const encodeHardware =
      hw === null
        ? null
        : HardwareContext.create(hw.deviceType, encoderSettings.device);
    if (hw !== null && !encodeHardware) {
      closePipeline();
      throw new Error(
        `Failed to create hardware device context for ${encoderSettings.name}`,
      );
    }

    // HW decode + HW scale when the encoder's context can decode the input
    // and the encoder has a hardware scaler, else decode and scale on the CPU.
    // The check must be an actual hardware test: getDecoderCodec only reports
    // the registered hw configs, which say nothing about driver support.
    const hwChain =
      hw !== null &&
      hw.scaleFilter !== undefined &&
      encodeHardware !== null &&
      encodeHardware.testDecoder(vStream.codecpar.codecId)
        ? { hardware: encodeHardware, scaleFilter: hw.scaleFilter }
        : null;

    videoFilter = FilterAPI.create(
      hwChain
        ? [
            // the upload passes hardware frames through untouched
            "hwupload",
            `${hwChain.scaleFilter}=w=${outWidth}:h=${outHeight}:format=nv12`,
            ...(frameRate ? [`fps=${frameRate}`] : []),
          ].join(",")
        : [
            `scale=${width}:${height}`,
            ...(frameRate ? [`fps=${frameRate}`] : []),
            "format=yuv420p",
            ...(encoderSettings.outFilters ?? []),
          ].join(","),
      // the encode context always goes to the filterchain: the upload filters
      // (hwupload) need it for their hardware frames context
      { hardware: encodeHardware, signal: cancelSignal },
    );

    const decoderOptions: DecoderOptions = {
      hardware: hwChain?.hardware ?? null,
      exitOnError: false,
      signal: cancelSignal,
    };
    if (minimizeLatency) {
      decoderOptions.configure = (ctx: CodecContext) => {
        ctx.setFlags(AV_CODEC_FLAG_LOW_DELAY);
      };
    }
    videoDecoder = await Decoder.create(vStream, decoderOptions);

    const inFps =
      vInfo.framerate_den > 0 ? vInfo.framerate_num / vInfo.framerate_den : 0;
    const encoderOptions: EncoderOptions = {
      filter: videoFilter,
      decoder: videoDecoder,
      autoFormat: true,
      context: {
        bitRate: `${bitrateVideo}k`,
        rcMaxRate: `${bitrateVideoMax}k`,
        rcBufferSize: `${Math.round(bitrateVideo / 2)}k`,
        // keyframes every ~1s, like ffmpeg's `-force_key_frames expr:gte(t,n_forced*1)`
        gopSize: Math.max(1, Math.round(frameRate ?? (inFps > 0 ? inFps : 30))),
        // B-frames are not supported by Discord's packetizer
        maxBFrames: 0,
      },
      options: encoderSettings.options,
      signal: cancelSignal,
    };
    videoEncoder = await Encoder.create(encoderSettings.name, encoderOptions);
  }

  if (includeAudio && aStream) {
    audioDecoder = await Decoder.create(aStream, {
      exitOnError: false,
      // Discord expects 48kHz stereo opus
      resample: {
        sampleRate: 48000,
        channelLayout: {
          nbChannels: 2,
          order: AV_CHANNEL_ORDER_NATIVE,
          mask: 3n,
        },
      },
      signal: cancelSignal,
    });
    audioFilter = FilterAPI.create("volume@internal_lib=1.0", {
      signal: cancelSignal,
    });
    audioEncoder = await Encoder.create(FF_ENCODER_LIBOPUS, {
      autoResample: true,
      decoder: audioDecoder,
      filter: audioFilter,
      context: { bitRate: `${bitrateAudio}k` },
      signal: cancelSignal,
    });
  }

  // the pipeline generators signal EOF by yielding null, which Readable.from
  // rejects instead of treating as the end of the stream
  // (see https://github.com/nodejs/node/issues/32845), so the flush markers
  // are filtered out before they reach it
  const videoOut = Readable.from(
    withoutFlushMarkers(
      pipeline(
        { video: demuxer },
        {
          video: noTranscoding
            ? [vbsf]
            : [videoDecoder, videoFilter, videoEncoder],
        },
        { signal: cancelSignal },
      ).video,
    ),
    { objectMode: true },
  );

  const audioOut =
    includeAudio && aStream
      ? Readable.from(
          withoutFlushMarkers(
            pipeline(
              { audio: demuxer },
              { audio: [audioDecoder, audioFilter, audioEncoder] },
              { signal: cancelSignal },
            ).audio,
          ),
          { objectMode: true },
        )
      : undefined;

  const outputs = [videoOut, ...(audioOut ? [audioOut] : [])];
  const promise = new Promise<void>((resolve, reject) => {
    Promise.all(
      outputs.map((output) => finished(output, { cleanup: true })),
    ).then(
      () => resolve(),
      reject,
    );
    cancelSignal?.addEventListener(
      "abort",
      () => {
        reject(cancelSignal.reason);
      },
      { once: true },
    );
  });
  promise.then(() => closePipeline(), () => closePipeline());

  let currentVolume = 1;

  return {
    output: {
      video: { ...vInfo, stream: videoOut },
      audio: audioOut && aInfo ? { ...aInfo, stream: audioOut } : undefined,
    },
    promise,
    controller: {
      get volume() {
        return currentVolume;
      },
      async setVolume(newVolume: number) {
        if (!Number.isFinite(newVolume) || newVolume < 0) return false;
        if (!audioFilter) return false;
        try {
          audioFilter.sendCommand(
            "volume@internal_lib",
            "volume",
            String(newVolume),
          );
          currentVolume = newVolume;
          return true;
        } catch {
          return false;
        }
      },
    } satisfies Controller,
  };
}

export type PlayStreamOptions = {
  /**
   * Set stream type as "Go Live" or camera stream
   */
  type: "go-live" | "camera";

  /**
   * Set format of the stream
   */
  format: "matroska" | "nut";

  /**
   * Override video width sent to Discord.
   *
   * DO NOT SPECIFY UNLESS YOU KNOW WHAT YOU'RE DOING!
   */
  width: number | ((v: VideoStreamInfo) => number);

  /**
   * Override video height sent to Discord.
   *
   * DO NOT SPECIFY UNLESS YOU KNOW WHAT YOU'RE DOING!
   */
  height: number | ((v: VideoStreamInfo) => number);

  /**
   * Override video frame rate sent to Discord.
   *
   * DO NOT SPECIFY UNLESS YOU KNOW WHAT YOU'RE DOING!
   */
  frameRate: number | ((v: VideoStreamInfo) => number);

  /**
   * Same as ffmpeg's `readrate_initial_burst` command line flag
   *
   * See https://ffmpeg.org/ffmpeg.html#:~:text=%2Dreadrate_initial_burst
   */
  readrateInitialBurst: number | undefined;

  /**
   * Enable stream preview from input stream (experimental)
   */
  streamPreview: boolean;
};

function isPreparedStream(
  input: Readable | PreparedStream,
): input is PreparedStream {
  return !Readable.isReadable(input as Readable);
}

export async function playStream(
  input: Readable | PreparedStream,
  streamer: Streamer,
  options: Partial<PlayStreamOptions> = {},
  cancelSignal?: AbortSignal,
) {
  const logger = new Log("playStream");
  cancelSignal?.throwIfAborted();
  if (!streamer.voiceConnection)
    throw new Error("Bot is not connected to a voice channel");

  const defaultOptions = {
    type: "go-live",
    format: "nut",
    width: (video) => video.width,
    height: (video) => video.height,
    frameRate: (video) => video.framerate_num / video.framerate_den,
    readrateInitialBurst: undefined,
    streamPreview: false,
  } satisfies PlayStreamOptions;

  function mergeOptions(opts: Partial<PlayStreamOptions>) {
    return {
      type: opts.type ?? defaultOptions.type,

      format: opts.format ?? defaultOptions.format,

      width:
        typeof opts.width === "function" ||
        (isFiniteNonZero(opts.width) && opts.width > 0)
          ? opts.width
          : defaultOptions.width,

      height:
        typeof opts.height === "function" ||
        (isFiniteNonZero(opts.height) && opts.height > 0)
          ? opts.height
          : defaultOptions.height,

      frameRate:
        typeof opts.frameRate === "function" ||
        (isFiniteNonZero(opts.frameRate) && opts.frameRate > 0)
          ? opts.frameRate
          : defaultOptions.frameRate,

      readrateInitialBurst:
        isFiniteNonZero(opts.readrateInitialBurst) &&
        opts.readrateInitialBurst > 0
          ? opts.readrateInitialBurst
          : defaultOptions.readrateInitialBurst,

      streamPreview: opts.streamPreview ?? defaultOptions.streamPreview,
    } satisfies PlayStreamOptions;
  }

  const mergedOptions = mergeOptions(options);
  logger.debug({ options: mergedOptions }, "Merged options");

  const { video, audio } = isPreparedStream(input)
    ? input
    : await demux(input, {
        format: mergedOptions.format,
      });
  cancelSignal?.throwIfAborted();

  if (!video) throw new Error("No video stream in media");

  const cleanupFuncs: (() => unknown)[] = [];

  let conn: WebRtcConnWrapper;
  let stopStream: () => unknown;
  if (mergedOptions.type === "go-live") {
    conn = await streamer.createStream();
    stopStream = () => streamer.stopStream();
  } else {
    conn = streamer.voiceConnection.webRtcConn;
    streamer.signalVideo(true);
    stopStream = () => streamer.signalVideo(false);
  }
  conn.setPacketizer(videoCodecMap[video.codec]);
  conn.mediaConnection.setSpeaking(true);
  const { width, height, frameRate } = mergedOptions;
  conn.mediaConnection.setVideoAttributes(true, {
    width: Math.round(typeof width === "function" ? width(video) : width),
    height: Math.round(typeof height === "function" ? height(video) : height),
    fps: Math.round(
      typeof frameRate === "function" ? frameRate(video) : frameRate,
    ),
  });

  const vStream = new VideoStream(conn);
  video.stream.pipe(vStream);
  if (audio) {
    const aStream = new AudioStream(conn);
    audio.stream.pipe(aStream);
    vStream.syncStream = aStream;

    const burstTime = mergedOptions.readrateInitialBurst;
    if (typeof burstTime === "number") {
      vStream.sync = false;
      vStream.noSleep = aStream.noSleep = true;
      const stopBurst = (pts: number) => {
        if (pts < burstTime * 1000) return;
        vStream.sync = true;
        vStream.noSleep = aStream.noSleep = false;
        vStream.off("pts", stopBurst);
      };
      vStream.on("pts", stopBurst);
    }
  }
  if (mergedOptions.streamPreview && mergedOptions.type === "go-live") {
    (async () => {
      const logger = new Log("playStream:preview");
      logger.debug("Initializing decoder for stream preview");
      const decoder = await createDecoder(video.avStream).catch((e) => {
        logger.warn(
          "Failed to initialize decoder. Stream preview will be disabled",
        );
        logger.debug({ error: e });
        return undefined;
      });
      if (!decoder) return;
      cleanupFuncs.push(() => {
        logger.debug("Freeing decoder");
        decoder.free();
      });
      const updatePreview = pDebounce.promise(async (packet: Packet) => {
        if (!(packet.flags !== undefined && packet.flags & AV_PKT_FLAG_KEY))
          return;
        const decodeStart = performance.now();
        const frames = await decoder.decode(packet).catch((e) => {
          logger.error(e, "Failed to decode the frame");
          return [];
        });
        if (!frames.length) return;

        const decodeEnd = performance.now();
        logger.debug(`Decoding a frame took ${decodeEnd - decodeStart}ms`);
        const frame = frames[0];

        return sharp(frame.toBuffer(), {
          raw: {
            width: frame.width ?? 0,
            height: frame.height ?? 0,
            channels: 4,
          },
        })
          .resize(1024, 576, { fit: "inside" })
          .jpeg()
          .toBuffer()
          .then((image) => streamer.setStreamPreview(image))
          .catch(() => {})
          .finally(() => {
            for (const frame of frames) frame.free();
          });
      });
      video.stream.on("data", updatePreview);
      cleanupFuncs.push(() => video.stream.off("data", updatePreview));
    })();
  }
  const promise = new Promise<void>((resolve, reject) => {
    cleanupFuncs.push(() => {
      stopStream();
      conn.mediaConnection.setSpeaking(false);
      conn.mediaConnection.setVideoAttributes(false);
    });
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      for (const f of cleanupFuncs) f();
    };
    cancelSignal?.addEventListener(
      "abort",
      () => {
        cleanup();
        reject(cancelSignal.reason);
      },
      { once: true },
    );
    vStream.once("finish", () => {
      if (cancelSignal?.aborted) return;
      cleanup();
      resolve();
    });
  });
  promise.catch(() => {});
  return promise;
}
