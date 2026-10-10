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
  AV_NOPTS_VALUE,
  AV_PKT_FLAG_KEY,
  Log as AVLog,
  type AVLogLevel,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_VIDEO,
  avGetCodecName,
  type BitStreamFilterAPI,
  type CodecContext,
  Decoder,
  type DecoderOptions,
  Demuxer,
  Encoder,
  type EncoderOptions,
  FF_ENCODER_LIBOPUS,
  FFmpegError,
  FilterAPI,
  type Frame,
  HardwareContext,
  InputFormat,
  type Packet,
  Rational,
  type Stream,
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
   * Initial audio volume multiplier (1.0 = original volume)
   */
  volume: number;

  /**
   * Start playback at this position, in seconds
   */
  startPosition: number;

  /**
   * Select the video stream to play, from the video streams present in the
   * input. Return null to disable video output
   */
  videoStream: (streams: Stream[]) => Stream | null;

  /**
   * Select the audio stream to play, from the audio streams present in the
   * input. Return null to disable audio output
   */
  audioStream: (streams: Stream[]) => Stream | null;

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
  /**
   * Seek the stream to the given position in seconds.
   * The transport timestamps are kept continuous so audio/video stays in
   * sync and playback pacing is unaffected.
   */
  seek(positionSeconds: number): Promise<boolean>;
  /**
   * Current playback position in seconds
   */
  readonly position: number | undefined;
  /**
   * Total duration in seconds, if known
   */
  readonly duration: number | undefined;
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
 * Packet pts in seconds, or undefined when the packet carries no
 * usable timestamp
 */
function packetSecs(packet: Packet): number | undefined {
  if (packet.pts === AV_NOPTS_VALUE) return undefined;
  const { num, den } = packet.timeBase;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return undefined;
  }
  return (Number(packet.pts) * num) / den;
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
 * through a wrapper stream. The detected format is returned alongside the
 * buffer so it doesn't have to be probed again.
 */
async function probeFormat(
  stream: Readable,
): Promise<{ buffer: Buffer; format: InputFormat } | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  // destroyOnReturn: false, so the stream survives when the probe succeeds
  // early and the remaining data is still needed
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= 2 ** 20) break;
    const buffer = Buffer.concat(chunks);
    const format = InputFormat.probe(buffer);
    if (format) return { buffer, format };
  }
  return null;
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
    volume: 1,
    startPosition: 0,
    videoStream: (streams) => streams[0] ?? null,
    audioStream: (streams) => streams[0] ?? null,
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

      volume:
        opts.volume !== undefined &&
        Number.isFinite(opts.volume) &&
        opts.volume >= 0
          ? opts.volume
          : defaultOptions.volume,

      startPosition:
        opts.startPosition !== undefined &&
        Number.isFinite(opts.startPosition) &&
        opts.startPosition >= 0
          ? opts.startPosition
          : defaultOptions.startPosition,

      encoder: opts.encoder ?? defaultOptions.encoder,

      videoStream: opts.videoStream ?? defaultOptions.videoStream,

      audioStream: opts.audioStream ?? defaultOptions.audioStream,

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
    videoStream,
    audioStream,
    bitrateAudio,
    volume,
    startPosition,
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
        // Keep the container's absolute timestamps (disables the
        // demuxer's discontinuity remapping, which would hide seek
        // targets from the position tracking / pacing logic)
        copyTs: true,
      });
    } else {
      const probed = await probeFormat(input);
      if (!probed?.format?.name) {
        input.destroy();
        throw new Error("Could not detect the input format");
      }
      probeWrapper = new PassThrough();
      probeWrapper.write(probed.buffer);
      input.pipe(probeWrapper);
      demuxer = await Demuxer.open(probeWrapper, {
        options: inputOptions,
        bufferSize: 8192,
        signal: cancelSignal,
        format: probed.format.name,
        copyTs: true,
      });
    }
  } catch (e) {
    if (typeof input !== "string") input.destroy();
    throw new Error("Failed to open input", { cause: e });
  }

  const videoStreams = demuxer.streams.filter(
    (s) => s.codecpar.codecType === AVMEDIA_TYPE_VIDEO,
  );
  const vStream = videoStream(videoStreams);
  const aStream = audioStream(
    demuxer.streams.filter((s) => s.codecpar.codecType === AVMEDIA_TYPE_AUDIO),
  );

  let vbsf: BitStreamFilterAPI[] = [];

  let videoChain: TrackChain | undefined;
  let audioChain: TrackChain | undefined;

  const closePipeline = () => {
    demuxer.close();
    probeWrapper?.destroy();
    if (typeof input !== "string") input.destroy();
    for (const filter of vbsf) filter.close();
    for (const chain of [videoChain, audioChain]) {
      if (!chain) continue;
      chain.decoder.close();
      chain.filter.close();
      chain.encoder.close();
    }
  };

  if (!vStream) {
    closePipeline();
    throw new Error(
      videoStreams.length === 0
        ? "No video stream in media"
        : "Video output cannot be disabled",
    );
  }

  if (startPosition > 0) {
    try {
      const target = BigInt(Math.floor(startPosition * 1_000_000));
      const ret = await demuxer
        .getFormatContext()
        .seekFile(-1, target - 1_000_000n, target, target + 1_000_000n);
      FFmpegError.throwIfError(ret, "seek failed");
    } catch (e) {
      closePipeline();
      throw new Error("Failed to seek to the given start position", {
        cause: e,
      });
    }
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
  if (aStream) {
    aInfo = {
      index: aStream.index,
      codec: aStream.codecpar.codecId,
      codecpar: aStream.codecpar,
      sample_rate: aStream.codecpar.sampleRate || 0,
      avStream: aStream,
    };
    logger.info({ info: aInfo }, "Prepared audio stream");
  }

  type TrackChain = {
    decoder: Decoder;
    filter: FilterAPI;
    encoder: Encoder;
    createFilter: () => FilterAPI;
    // set by controller.seek; the track's generator loop consumes it when
    // the jump to the post-seek packets is spotted, so the flush (and the
    // filter recreation, which anchors the new filter graph on post-seek
    // timestamps) happens exactly at the content boundary
    seekPending: boolean;
  };

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
      hw && HardwareContext.create(hw.deviceType, encoderSettings.device);
    if (hw && !encodeHardware) {
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
      hw?.scaleFilter && encodeHardware?.testDecoder(vStream.codecpar.codecId)
        ? { hardware: encodeHardware, scaleFilter: hw.scaleFilter }
        : null;

    const outFilters = encoderSettings.outFilters;
    const videoFilterSpec = hwChain
      ? [
          // the upload passes hardware frames through untouched
          "hwupload",
          `${hwChain.scaleFilter}=w=${outWidth}:h=${outHeight}:format=nv12`,
          ...(frameRate ? [`fps=${frameRate}`] : []),
        ].join(",")
      : [
          `scale=${width}:${height}`,
          ...(frameRate ? [`fps=${frameRate}`] : []),
          // the outFilters handle the pixel format when present (e.g. the
          // vaapi upload filterchain), so the default 4:2:0 conversion is
          // only needed without them
          ...(outFilters?.length ? outFilters : ["format=yuv420p"]),
        ].join(",");
    // the encode context always goes to the filterchain: the upload filters
    // (hwupload) need it for their hardware frames context
    const createVideoFilter = () =>
      FilterAPI.create(videoFilterSpec, {
        hardware: encodeHardware,
        signal: cancelSignal,
      });
    const videoFilter = createVideoFilter();

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
    const videoDecoder = await Decoder.create(vStream, decoderOptions);

    // pass the target framerate explicitly: the framerate the encoder derives
    // itself (from the filter/decoder stream) may be wrong or missing, which
    // breaks the encoder's average bitrate calculations
    const targetFramerate = frameRate
      ? new Rational(frameRate, 1)
      : sourceFramerate;
    const targetFps =
      targetFramerate.den > 0 ? targetFramerate.num / targetFramerate.den : 0;
    const encoderOptions: EncoderOptions = {
      filter: videoFilter,
      decoder: videoDecoder,
      autoFormat: true,
      context: {
        ...(targetFramerate.num > 0 && targetFramerate.den > 0
          ? { framerate: targetFramerate }
          : {}),
        bitRate: `${bitrateVideo}k`,
        rcMaxRate: `${bitrateVideoMax}k`,
        rcBufferSize: `${Math.round(bitrateVideo / 2)}k`,
        // keyframes every ~1s, like ffmpeg's `-force_key_frames expr:gte(t,n_forced*1)`
        gopSize: Math.max(1, Math.round(targetFps > 0 ? targetFps : 30)),
        // B-frames are not supported by Discord's packetizer
        maxBFrames: 0,
      },
      options: encoderSettings.options,
      signal: cancelSignal,
    };
    const videoEncoder = await Encoder.create(
      encoderSettings.name,
      encoderOptions,
    );
    videoChain = {
      decoder: videoDecoder,
      filter: videoFilter,
      encoder: videoEncoder,
      createFilter: createVideoFilter,
      seekPending: false,
    };
  }

  let currentVolume = volume;

  if (aStream) {
    const audioDecoder = await Decoder.create(aStream, {
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
    // asetnsamples pin the graph to exactly one opus frame
    // (960 samples @ 48kHz) per frame, so the encoder emits one packet per
    // frame and ffmpeg propagates consistent container timestamps itself
    const createAudioFilter = () =>
      FilterAPI.create(
        `volume@internal_lib=${currentVolume},asetnsamples=n=960:p=0`,
        {
          signal: cancelSignal,
        },
      );
    const audioFilter = createAudioFilter();
    const audioEncoder = await Encoder.create(FF_ENCODER_LIBOPUS, {
      autoResample: true,
      decoder: audioDecoder,
      filter: audioFilter,
      context: { bitRate: `${bitrateAudio}k` },
      signal: cancelSignal,
    });
    audioChain = {
      decoder: audioDecoder,
      filter: audioFilter,
      encoder: audioEncoder,
      createFilter: createAudioFilter,
      seekPending: false,
    };
  }

  const totalDuration =
    demuxer.duration > 0 && Number.isFinite(demuxer.duration)
      ? demuxer.duration
      : undefined;

  // Current playback position in seconds, tracked from the demuxer's
  // video packets. With copyTs, packet timestamps are the container's
  // absolute timestamps, so this directly reflects the position.
  let currentPosition: number | undefined;
  const trackPosition = (packet: Packet) => {
    const secs = packetSecs(packet);
    if (secs !== undefined) currentPosition = secs;
  };

  // Encoders don't necessarily preserve the input frame timestamps in
  // their output packets (e.g. the native opus encoder numbers packets
  // with its own sample counter, which also restarts when its buffers are
  // flushed). To keep the original container timestamps all the way to
  // the output frames, re-stamp each encoded packet with the container
  // pts of the frame it was encoded from.
  type FramePts = { pts: bigint; num: number; den: number };

  async function* encodeFrames(
    frames: Frame[],
    encoder: Encoder,
    pendingPts: FramePts[],
  ): AsyncGenerator<Packet> {
    for (const frame of frames) {
      if (frame.pts !== AV_NOPTS_VALUE && frame.timeBase.den !== 0) {
        pendingPts.push({
          pts: frame.pts,
          num: frame.timeBase.num,
          den: frame.timeBase.den,
        });
      }
      const packets = await encoder.encodeAll(frame);
      frame.free();
      for (const p of packets) {
        const source = pendingPts.shift();
        if (source && p.timeBase.den !== 0 && p.timeBase.num !== 0) {
          // rescale the container pts into the packet's timebase
          p.pts = p.dts =
            (source.pts * BigInt(source.num) * BigInt(p.timeBase.den)) /
            (BigInt(source.den) * BigInt(p.timeBase.num));
        }
        yield p;
      }
    }
  }

  async function* filterEncode(
    frames: Frame[],
    filter: FilterAPI,
    encoder: Encoder,
    pendingPts: FramePts[],
  ): AsyncGenerator<Packet> {
    for (const frame of frames) {
      const filtered = await filter.processAll(frame);
      frame.free();
      yield* encodeFrames(filtered, encoder, pendingPts);
    }
  }

  async function* transcodeTrack(
    source: AsyncGenerator<Packet | null>,
    chain: TrackChain,
    onPacket: ((packet: Packet) => void) | undefined,
  ): AsyncGenerator<Packet> {
    const { decoder, encoder } = chain;
    // container pts of frames fed to the encoder, in order, used to
    // re-stamp the encoded packets (see encodeFrames)
    const pendingPts: FramePts[] = [];
    let lastDemuxSecs: number | undefined;
    let packetsSinceSeek = 0;
    for await (const packet of source) {
      if (!packet || cancelSignal?.aborted) break;
      const secs = packetSecs(packet);
      if (chain.seekPending) {
        // wait for the jump to the post-seek packets before flushing, so
        // the recreated filter graph anchors on post-seek timestamps
        // (anchoring it on stale queued packets would starve it forever
        // on backward seeks)
        const jumped =
          secs !== undefined &&
          lastDemuxSecs !== undefined &&
          Math.abs(secs - lastDemuxSecs) > 0.5;
        packetsSinceSeek++;
        if (jumped || packetsSinceSeek > 120) {
          chain.seekPending = false;
          packetsSinceSeek = 0;
          pendingPts.length = 0;
          flushChain(chain);
        }
      }
      if (secs !== undefined) lastDemuxSecs = secs;
      onPacket?.(packet);
      const frames = await decoder.decodeAll(packet);
      packet.free();
      yield* filterEncode(frames, chain.filter, encoder, pendingPts);
    }
    // flush the tail of the transcode chain at EOF
    yield* filterEncode(
      await decoder.decodeAll(null),
      chain.filter,
      encoder,
      pendingPts,
    );
    yield* encodeFrames(
      await chain.filter.processAll(null),
      encoder,
      pendingPts,
    );
    for (const p of await encoder.encodeAll(null)) yield p;
  }

  // Flush the codec buffers and restart the filter graph (filters keep no
  // user-visible flush API, so they are recreated). The encoder is
  // deliberately not flushed: it is configured without B-frames/lookahead
  // buffering, so there is (almost) nothing stale to drop, and flushing an
  // encoder mid-stream wedges it (subsequent sends fail).
  const flushChain = (chain: TrackChain | undefined) => {
    if (!chain) return;
    chain.decoder.getCodecContext()?.flushBuffers();
    const oldFilter = chain.filter;
    chain.filter = chain.createFilter();
    oldFilter.close();
  };

  async function* videoGenerator(): AsyncGenerator<Packet> {
    if (noTranscoding) {
      for await (const packet of demuxer.packets(vStream!.index)) {
        if (!packet || cancelSignal?.aborted) return;
        trackPosition(packet);
        let out: Packet[] = [packet];
        for (const f of vbsf) {
          const next: Packet[] = [];
          for (const p of out) next.push(...(await f.filterAll(p)));
          out = next;
        }
        packet.free();
        for (const p of out) yield p;
      }
      return;
    }
    yield* transcodeTrack(
      demuxer.packets(vStream!.index),
      videoChain!,
      trackPosition,
    );
  }

  async function* audioGenerator(): AsyncGenerator<Packet> {
    if (!aStream) return;
    yield* transcodeTrack(
      demuxer.packets(aStream.index),
      audioChain!,
      undefined,
    );
  }

  const videoOut = Readable.from(videoGenerator(), { objectMode: true });
  const audioOut = aStream
    ? Readable.from(audioGenerator(), { objectMode: true })
    : undefined;

  const outputs = [videoOut, ...(audioOut ? [audioOut] : [])];
  const promise = new Promise<void>((resolve, reject) => {
    Promise.all(
      outputs.map((output) => finished(output, { cleanup: true })),
    ).then(() => resolve(), reject);
    cancelSignal?.addEventListener(
      "abort",
      () => {
        reject(cancelSignal.reason);
      },
      { once: true },
    );
  });
  promise.then(
    () => closePipeline(),
    () => closePipeline(),
  );

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
        if (!audioChain) return false;
        try {
          audioChain.filter.sendCommand(
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
      async seek(positionSeconds: number) {
        if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
          return false;
        }
        try {
          // avformat_seek_file with a tight tolerance: seek as close to the
          // target as the container allows instead of jumping to the
          // previous keyframe of the default stream
          const target = BigInt(Math.floor(positionSeconds * 1_000_000));
          const ret = await demuxer
            .getFormatContext()
            .seekFile(-1, target - 1_000_000n, target, target + 1_000_000n);
          FFmpegError.throwIfError(ret, "seek failed");
        } catch {
          return false;
        }
        // the actual flush happens inside each track's generator loop when
        // the jump to the post-seek packets is spotted, so the recreated
        // filter graph anchors on post-seek timestamps
        if (videoChain) videoChain.seekPending = true;
        if (audioChain) audioChain.seekPending = true;
        currentPosition = positionSeconds;
        return true;
      },
      get position() {
        return currentPosition;
      },
      get duration() {
        return totalDuration;
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
