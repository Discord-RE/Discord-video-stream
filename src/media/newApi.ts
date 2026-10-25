import { PassThrough, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import Log from "debug-level";
import {
  AV_CHANNEL_ORDER_NATIVE,
  AV_CODEC_FLAG_LOW_DELAY,
  AV_NOPTS_VALUE,
  AV_PKT_FLAG_KEY,
  AV_ROUND_NEAR_INF,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_VIDEO,
  type AVPixelFormat,
  type AVSampleFormat,
  avGetCodecName,
  avGetPixFmtName,
  avGetSampleFmtName,
  avRescaleQ,
  avRescaleRnd,
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
  type IRational,
  type Packet,
  Rational,
  type Stream,
} from "node-av";
import pDebounce from "p-debounce";
import sharp from "sharp";
import Queue from "yocto-queue";
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

/**
 * A pts in seconds, or undefined when it carries no usable timestamp (the
 * unset sentinel, or a time base that cannot scale it)
 */
function ptsSecs(pts: bigint, timeBase: Rational): number | undefined {
  if (pts === AV_NOPTS_VALUE) return undefined;
  const { num, den } = timeBase;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return undefined;
  }
  return (Number(pts) * num) / den;
}

/** Packet pts in seconds, or undefined when it carries no usable timestamp */
const packetSecs = (packet: Packet) => ptsSecs(packet.pts, packet.timeBase);

/**
 * Container timestamps of a frame fed to an encoder, used to re-stamp the
 * encoded packet.
 *
 * Encoders don't necessarily preserve the input frame timestamps in their
 * output packets (e.g. the native opus encoder numbers packets with its own
 * sample counter, which also restarts when its buffers are flushed). To keep
 * the original container timestamps all the way to the output frames, each
 * encoded packet is re-stamped with the pts and duration of the frame it was
 * encoded from.
 */
type FramePts = { pts: bigint; duration: bigint; timeBase: IRational };

/**
 * Codec name for logs. The local AVCodecID enum and the bindings' one hold the
 * same numbers, so the cast only bridges the two nominally distinct types.
 */
const codecName = (codecId: number) =>
  avGetCodecName(codecId as Parameters<typeof avGetCodecName>[0]);

/** Readable rational ("num/den"), for logs carrying time bases and framerates */
function describeRational(rational: Rational): string {
  return `${rational.num}/${rational.den}`;
}

/**
 * A pts in seconds rounded to milliseconds, for the log helpers. Raw values
 * carry float noise from the time base conversion ("0.30000000000000004"),
 * which crowds out the fields worth reading in a per-frame trace.
 */
function stampSecs(pts: bigint, timeBase: Rational): number | undefined {
  const secs = ptsSecs(pts, timeBase);
  return secs === undefined ? undefined : Math.round(secs * 1000) / 1000;
}

/**
 * Snapshot of a frame's identity for tracing. Must be taken before the frame
 * is freed: every property reads straight out of the native frame.
 */
function describeFrame(frame: Frame) {
  const { timeBase } = frame;
  const common = {
    pts: stampSecs(frame.pts, timeBase),
    duration: stampSecs(frame.duration, timeBase),
    timeBase: describeRational(timeBase),
  };
  // audio frames carry no dimensions, so they are described by their sample
  // count and sample format instead
  if (frame.nbSamples > 0) {
    return {
      ...common,
      samples: frame.nbSamples,
      sampleFormat:
        avGetSampleFmtName(frame.format as AVSampleFormat) ?? frame.format,
    };
  }
  return {
    ...common,
    width: frame.width,
    height: frame.height,
    format: avGetPixFmtName(frame.format as AVPixelFormat) ?? frame.format,
    memory: frame.hwFramesCtx ? "hardware" : "system",
  };
}

/** Snapshot of a packet's identity for tracing */
function describePacket(packet: Packet) {
  const { timeBase, flags } = packet;
  return {
    pts: stampSecs(packet.pts, timeBase),
    dts: stampSecs(packet.dts, timeBase),
    duration: stampSecs(packet.duration, timeBase),
    timeBase: describeRational(timeBase),
    size: packet.size,
    key: (flags & AV_PKT_FLAG_KEY) !== 0,
  };
}

/** What the demuxer found in one of the input's streams */
function describeStream(stream: Stream) {
  const { codecpar } = stream;
  // every value is converted to a number: the log serializer cannot handle
  // the bigints the native wrappers return
  const common = {
    index: stream.index,
    codec: codecName(codecpar.codecId),
    bitRate: Number(codecpar.bitRate),
    duration: Number(stream.duration),
    timeBase: describeRational(stream.timeBase),
  };
  if (codecpar.codecType === AVMEDIA_TYPE_VIDEO) {
    const framerate = streamFrameRate(stream);
    return {
      ...common,
      type: "video",
      width: codecpar.width,
      height: codecpar.height,
      format: avGetPixFmtName(codecpar.format as AVPixelFormat),
      framerate: framerate.den > 0 ? framerate.num / framerate.den : undefined,
    };
  }
  if (codecpar.codecType === AVMEDIA_TYPE_AUDIO) {
    return {
      ...common,
      type: "audio",
      sampleRate: codecpar.sampleRate,
      channels: codecpar.channels,
    };
  }
  return { ...common, type: "other" };
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
  let w = width === 0 ? inWidth : Math.trunc(width);
  let h = height === 0 ? inHeight : Math.trunc(height);
  const factorW = w < -1 ? -w : 1;
  const factorH = h < -1 ? -h : 1;
  if (w < 0 && h < 0) {
    w = inWidth;
    h = inHeight;
  }
  if (w < 0) {
    w =
      Number(
        avRescaleRnd(
          BigInt(h),
          BigInt(inWidth),
          BigInt(inHeight) * BigInt(factorW),
          AV_ROUND_NEAR_INF,
        ),
      ) * factorW;
  }
  if (h < 0) {
    h =
      Number(
        avRescaleRnd(
          BigInt(w),
          BigInt(inHeight),
          BigInt(inWidth) * BigInt(factorH),
          AV_ROUND_NEAR_INF,
        ),
      ) * factorH;
  }
  return { width: w, height: h };
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

const DEFAULT_PREPARE_OPTIONS: PrepareStreamOptions = {
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
};

/** Rounded, finite and non-zero (negatives allowed, e.g. -2 = keep aspect ratio) */
function pickInt(value: number | undefined, fallback: number): number {
  return isFiniteNonZero(value) ? Math.round(value) : fallback;
}

/** Rounded, finite and greater than zero */
function pickPositiveInt(value: number | undefined, fallback: number): number {
  return isFiniteNonZero(value) && value > 0 ? Math.round(value) : fallback;
}

/** Finite and greater than zero, kept as given */
function pickPositive(
  value: number | undefined,
  fallback: number | undefined,
): number | undefined {
  return isFiniteNonZero(value) && value > 0 ? value : fallback;
}

/** Finite and zero or above (0 is a valid position/volume) */
function pickNonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/** User supplied options with defaults applied and values validated */
function resolveOptions(
  opts: Partial<PrepareStreamOptions>,
): PrepareStreamOptions {
  const defaults = DEFAULT_PREPARE_OPTIONS;
  return {
    noTranscoding: opts.noTranscoding ?? defaults.noTranscoding,
    width: pickInt(opts.width, defaults.width),
    height: pickInt(opts.height, defaults.height),
    frameRate: pickPositive(opts.frameRate, defaults.frameRate),
    videoCodec: opts.videoCodec ?? defaults.videoCodec,
    bitrateVideo: pickPositiveInt(opts.bitrateVideo, defaults.bitrateVideo),
    bitrateVideoMax: pickPositiveInt(
      opts.bitrateVideoMax,
      defaults.bitrateVideoMax,
    ),
    bitrateAudio: pickPositiveInt(opts.bitrateAudio, defaults.bitrateAudio),
    volume: pickNonNegative(opts.volume, defaults.volume),
    startPosition: pickNonNegative(opts.startPosition, defaults.startPosition),
    videoStream: opts.videoStream ?? defaults.videoStream,
    audioStream: opts.audioStream ?? defaults.audioStream,
    encoder: opts.encoder ?? defaults.encoder,
    minimizeLatency: opts.minimizeLatency ?? defaults.minimizeLatency,
    customHeaders: { ...defaults.customHeaders, ...opts.customHeaders },
    customInputOptions: opts.customInputOptions ?? defaults.customInputOptions,
    customFfmpegFlags: opts.customFfmpegFlags ?? defaults.customFfmpegFlags,
  };
}

/** Demuxer options derived from the input: latency tweaks, and, for http(s)
 * inputs, the custom headers plus the reconnect flags that keep the stream
 * alive across network drops */
function buildInputOptions(
  input: string | Readable,
  options: PrepareStreamOptions,
): Record<string, string | number> {
  const inputOptions: Record<string, string | number> = {};
  if (options.minimizeLatency) {
    inputOptions.fflags = "nobuffer";
    inputOptions.max_delay = 100000;
  }
  if (typeof input !== "string") return inputOptions;

  // covers https as well
  if (input.startsWith("http")) {
    inputOptions.headers = Object.entries(options.customHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    // HLS streams already reconnect on their own
    if (!input.includes("m3u")) {
      inputOptions.reconnect = "1";
      inputOptions.reconnect_at_eof = "1";
      inputOptions.reconnect_streamed = "1";
      inputOptions.reconnect_delay_max = "4294";
    }
  }
  if (input.startsWith("srt://")) {
    inputOptions.scan_all_pmts = "0";
  }
  return inputOptions;
}

/**
 * Open the input and start demuxing it. `Demuxer.open` cannot probe the
 * format of a Readable on its own, so those inputs are probed here and the
 * consumed bytes are replayed into the demuxer (see `probeFormat`).
 */
async function openInput(
  input: string | Readable,
  options: PrepareStreamOptions,
  signal?: AbortSignal,
): Promise<{ demuxer: Demuxer; probeWrapper?: PassThrough }> {
  const logger = new Log("prepareStream:input");
  const demuxerOptions = {
    options: buildInputOptions(input, options),
    bufferSize: 8192,
    signal,
    // Keep the container's absolute timestamps (disables the demuxer's
    // discontinuity remapping, which would hide seek targets from the
    // position tracking / pacing logic)
    copyTs: true,
  };

  logger.info(
    {
      source: typeof input === "string" ? input : "readable",
      inputOptions: demuxerOptions.options,
    },
    "Opening input",
  );

  let probeWrapper: PassThrough | undefined;
  try {
    if (typeof input !== "string") {
      logger.debug("Probing the input format from the first bytes");
      const probed = await probeFormat(input);
      if (!probed?.format?.name)
        throw new Error("Could not detect the input format");
      logger.info(
        {
          format: probed.format.name,
          longName: probed.format.longName,
          probedBytes: probed.buffer.length,
        },
        "Probed input format",
      );
      probeWrapper = new PassThrough();
      probeWrapper.write(probed.buffer);
      input.pipe(probeWrapper);
      return {
        probeWrapper,
        demuxer: await Demuxer.open(probeWrapper, {
          ...demuxerOptions,
          format: probed.format.name,
        }),
      };
    }
    return { demuxer: await Demuxer.open(input, demuxerOptions) };
  } catch (e) {
    if (typeof input !== "string") {
      probeWrapper?.destroy();
      input.destroy();
    }
    logger.error(e, "Failed to open input");
    throw new Error("Failed to open input", { cause: e });
  }
}

/**
 * avformat_seek_file with a tight tolerance: seek as close to the target as
 * the container allows instead of jumping to the previous keyframe of the
 * default stream
 */
async function seekTo(demuxer: Demuxer, positionSeconds: number) {
  const target = BigInt(Math.floor(positionSeconds * 1_000_000));
  const ret = await demuxer
    .getFormatContext()
    .seekFile(-1, target - 1_000_000n, target, target + 1_000_000n);
  FFmpegError.throwIfError(ret, "seek failed");
}

/**
 * The decode -> filter -> encode stage of a track. Absent when transcoding
 * is off: the track then passes the demuxer's packets straight through its
 * bitstream filters.
 */
type TranscodeStage = {
  decoder: Decoder;
  filter: FilterAPI;
  encoder: Encoder;
  createFilter: () => FilterAPI;
};

/**
 * A track's loggers. Each pipeline stage gets its own namespace so a trace can
 * be narrowed to a single stage, e.g. only what the filter produced:
 * `DEBUG="trace:prepareStream:video:filter"`. Note the level goes in front of
 * the namespace, and that the namespace match is anchored, so a parent needs a
 * trailing wildcard: `DEBUG="trace:prepareStream:video*"`.
 */
type TrackChainLoggers = {
  /** track-level events: setup, flush, close, packets on the track's output */
  track: Log;
  /** the packet fed to the decoder, and the frames it produced */
  decode: Log;
  /** the frames the filter produced from the decoder's */
  filter: Log;
  /** the frames handed to the encoder, and the packets it emitted */
  encode: Log;
};

type TrackChain = {
  transcode: TranscodeStage | null;
  /** this track's per-stage loggers */
  loggers: TrackChainLoggers;
  // set by controller.seek; the track's generator loop consumes it when
  // the jump to the post-seek packets is spotted, so the flush (and the
  // filter recreation, which anchors the new filter graph on post-seek
  // timestamps) happens exactly at the content boundary
  seekPending: boolean;
  // annexb conversion + per-keyframe parameter sets, run over the track's
  // output on its way out, whether that output is encoded or passthrough
  bsf: BitStreamFilterAPI[];
  /**
   * container timestamps of the frames handed to the encoder, matched to its
   * output packets one for one
   */
  frameStamps: Queue<FramePts>;
};

const newTrackChain = (
  name: "video" | "audio",
  transcode: TranscodeStage | null,
  bsf: BitStreamFilterAPI[],
): TrackChain => ({
  transcode,
  loggers: {
    track: new Log(`prepareStream:${name}`),
    decode: new Log(`prepareStream:${name}:decode`),
    filter: new Log(`prepareStream:${name}:filter`),
    encode: new Log(`prepareStream:${name}:encode`),
  },
  seekPending: false,
  bsf,
  frameStamps: new Queue(),
});

/** Release every codec/filter/bitstream-filter resource a chain holds */
function closeChain(chain: TrackChain | undefined) {
  if (!chain) return;
  chain.loggers.track.debug("Closing the chain");
  chain.transcode?.decoder.close();
  chain.transcode?.filter.close();
  chain.transcode?.encoder.close();
  for (const bsf of chain.bsf) bsf.close();
}

/**
 * Build the video transcode stage: decode (in hardware when the encoder
 * supports it), scale, and encode with the settings for the requested codec.
 */
async function createVideoChain(params: {
  /** input video stream */
  stream: Stream;
  /** codec of the packets the encoder emits */
  codec: AVCodecID;
  options: PrepareStreamOptions;
  sourceFramerate: Rational;
  /** dimensions the video is scaled to */
  outputSize: { width: number; height: number };
  signal?: AbortSignal;
}): Promise<TrackChain> {
  const { stream, codec, options, sourceFramerate, outputSize, signal } =
    params;
  const logger = new Log("prepareStream:video");
  const {
    videoCodec,
    bitrateVideo,
    bitrateVideoMax,
    frameRate,
    width,
    height,
    minimizeLatency,
  } = options;

  const settings = options.encoder(bitrateVideo, bitrateVideoMax)[videoCodec];
  if (!settings)
    throw new Error(`Encoder settings not specified for ${videoCodec}`);

  logger.info(
    {
      codec: videoCodec,
      encoder: settings.name,
      device: settings.device,
      outputOptions: settings.options,
      bitrateVideo,
      bitrateVideoMax,
    },
    "Using video encoder",
  );
  const decoderCodec = codecName(stream.codecpar.codecId);

  // Deduce the hardware context from the encoder name (e.g. "h264_vaapi" ->
  // VAAPI), so any hardware encoder works without per-encoder special cases
  const hw = hardwareForEncoder(settings.name);
  let hwContext: HardwareContext | null = null;
  let hwScaleFilter: string | null = null;
  let hwDecodeWorks = false;
  if (hw) {
    hwContext = HardwareContext.create(hw.deviceType, settings.device);
    if (hwContext) {
      logger.debug(
        { deviceType: hwContext.deviceTypeName, device: settings.device },
        "Created hardware device context",
      );
    } else {
      throw new Error(
        `Failed to create hardware device context for ${settings.name}`,
      );
    }

    // HW decode + HW scale when the encoder's context can decode the input,
    // else decode and scale on the CPU. The check must be an actual hardware
    // test: getDecoderCodec only reports the registered hw configs, which say
    // nothing about driver support.
    hwDecodeWorks = hwContext.testDecoder(stream.codecpar.codecId);
    logger.info(
      {
        decoderCodec,
        hardwareDecode: hwDecodeWorks,
      },
      hwDecodeWorks
        ? "Using hardware decoding"
        : "Hardware decoding failed, falling back to software",
    );
    if (hwDecodeWorks) {
      hwScaleFilter = hw.scaleFilter;
    }
  } else {
    logger.info({ decoderCodec }, "Using software decoding");
  }

  const outFilters = settings.outFilters;
  const filterSpec = hwScaleFilter
    ? [
        // the upload passes hardware frames through untouched
        "hwupload",
        `${hwScaleFilter}=w=${outputSize.width}:h=${outputSize.height}:format=nv12`,
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
  const createFilter = () =>
    FilterAPI.create(filterSpec, { hardware: hwContext, signal });
  logger.info(
    { filterSpec, hardware: hwContext?.deviceTypeName },
    "Using video filter graph",
  );

  const decoderOptions: DecoderOptions = {
    hardware: hwDecodeWorks ? hwContext : null,
    exitOnError: false,
    signal,
  };
  if (minimizeLatency) {
    decoderOptions.configure = (ctx: CodecContext) => {
      ctx.setFlags(AV_CODEC_FLAG_LOW_DELAY);
    };
  }

  let videoDecoder: Decoder | undefined;
  let videoFilter: FilterAPI | undefined;
  try {
    videoFilter = createFilter();
    videoDecoder = await Decoder.create(stream, decoderOptions);
    logger.debug(
      {
        decoder: decoderCodec,
        hardware: hwDecodeWorks ? hwContext?.deviceTypeName : null,
        minimizeLatency,
      },
      "Created video decoder",
    );

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
      options: settings.options,
      signal,
    };
    const videoEncoder = await Encoder.create(settings.name, encoderOptions);
    logger.debug(
      {
        encoder: settings.name,
        // the context carries a Rational, which the serializer can't handle
        targetFramerate: describeRational(targetFramerate),
        targetFps,
        bitRate: `${bitrateVideo}k`,
        rcMaxRate: `${bitrateVideoMax}k`,
        gopSize: encoderOptions.context?.gopSize,
      },
      "Created video encoder",
    );

    return newTrackChain(
      "video",
      {
        decoder: videoDecoder,
        filter: videoFilter,
        encoder: videoEncoder,
        createFilter,
      },
      // fed by the encoder: the parameter sets live in its extradata, so
      // dump_extra can re-insert them before every keyframe
      createVideoBitStreamFilters(videoEncoder, codec),
    );
  } catch (e) {
    logger.error(e, "Failed to create the video chain");
    // release whatever was created before the failure
    videoDecoder?.close();
    videoFilter?.close();
    throw e;
  }
}

/**
 * Build the audio track: decode and resample to what Discord expects
 * (48kHz stereo opus), then encode with libopus. `getVolume` is read every
 * time the filter graph is (re)created, so seeking keeps the current volume.
 */
async function createAudioChain(params: {
  stream: Stream;
  bitrate: number;
  getVolume: () => number;
  signal?: AbortSignal;
}): Promise<TrackChain> {
  const { stream, bitrate, getVolume, signal } = params;
  const logger = new Log("prepareStream:audio");

  logger.info(
    {
      decoder: codecName(stream.codecpar.codecId),
      encoder: FF_ENCODER_LIBOPUS,
      bitrate,
      sampleRate: stream.codecpar.sampleRate,
      channels: stream.codecpar.channels,
      volume: getVolume(),
    },
    "Using audio encoder",
  );

  let audioDecoder: Decoder | undefined;
  let audioFilter: FilterAPI | undefined;
  try {
    audioDecoder = await Decoder.create(stream, {
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
      signal,
    });
    // asetnsamples pin the graph to exactly one opus frame
    // (960 samples @ 48kHz) per frame, so the encoder emits one packet per
    // frame and ffmpeg propagates consistent container timestamps itself
    const createFilter = () =>
      FilterAPI.create(
        `volume@internal_lib=${getVolume()},asetnsamples=n=960:p=0`,
        { signal },
      );
    audioFilter = createFilter();
    const audioEncoder = await Encoder.create(FF_ENCODER_LIBOPUS, {
      autoResample: true,
      decoder: audioDecoder,
      filter: audioFilter,
      context: { bitRate: `${bitrate}k` },
      signal,
    });

    return newTrackChain(
      "audio",
      {
        decoder: audioDecoder,
        filter: audioFilter,
        encoder: audioEncoder,
        createFilter,
      },
      // opus is not a video codec, so there is no annexb conversion to do
      [],
    );
  } catch (e) {
    logger.error(e, "Failed to create the audio chain");
    // release whatever was created before the failure
    audioDecoder?.close();
    audioFilter?.close();
    throw e;
  }
}

/**
 * Run one packet through every stage of the chain in turn, yielding the
 * packets that come out the far end. Each stage reads the array the previous
 * one filled and fills its own, so no stage calls the next.
 *
 * A null packet means "flush": the decoder drains its buffered frames, and
 * the null is handed on so the filter drains next, and then the encoder,
 * which still holds frames of its own (lookahead, reordering) and emits
 * packets for them.
 *
 * Encoded packets are re-stamped from the FramePts the frames were queued
 * with, to keep the container timestamps.
 */
async function* drainChain(
  chain: TrackChain,
  packet: Packet | null,
): AsyncGenerator<Packet> {
  const transcode = chain.transcode;
  // each stage's snapshots are only taken when its own trace is on, so the
  // disabled case costs nothing but the check
  const {
    decode: decodeLog,
    filter: filterLog,
    encode: encodeLog,
    track: trackLog,
  } = chain.loggers;
  const traceDecode = decodeLog.enabled.trace;
  const traceFilter = filterLog.enabled.trace;
  const traceEncode = encodeLog.enabled.trace;
  const traceTrack = trackLog.enabled.trace;

  let out: Packet[];
  if (!transcode) {
    out = packet ? [packet] : [];
    if (traceTrack && packet)
      trackLog.trace({ packet: describePacket(packet) }, "passthrough packet");
  } else {
    // decoder
    const decoderOutput: (Frame | null)[] =
      await transcode.decoder.decodeAll(packet);
    if (traceDecode) {
      const frames = decoderOutput.filter((f) => f !== null);
      decodeLog.trace(
        {
          input: packet && describePacket(packet),
          frames: frames.map(describeFrame),
        },
        `decoded ${frames.length} frame(s)`,
      );
    }
    if (!packet) decoderOutput.push(null);

    // filter
    const filterOutput: (Frame | null)[] = [];
    for (const frame of decoderOutput) {
      const filtered = await transcode.filter.processAll(frame);
      if (traceFilter && frame) {
        filterLog.trace(
          {
            input: describeFrame(frame),
            frames: filtered.filter((f) => f !== null).map(describeFrame),
          },
          `filtered frame into ${filtered.length} frame(s)`,
        );
      }
      filterOutput.push(...filtered);
      frame?.free();
    }
    if (!packet) filterOutput.push(null);

    // encoder
    const encoderOutput: Packet[] = [];
    for (const frame of filterOutput) {
      if (frame && frame.pts !== AV_NOPTS_VALUE && frame.timeBase.den !== 0) {
        chain.frameStamps.enqueue({
          pts: frame.pts,
          duration: frame.duration,
          timeBase: frame.timeBase,
        });
      }
      const encoded = await transcode.encoder.encodeAll(frame);
      if (traceEncode && frame) {
        encodeLog.trace(
          { frame: describeFrame(frame), packets: encoded.map(describePacket) },
          `encoded frame into ${encoded.length} packet(s)`,
        );
      }
      encoderOutput.push(...encoded);
      frame?.free();
    }

    // match each encoded packet back to the frame it was encoded from
    for (const p of encoderOutput) {
      const stamp = chain.frameStamps.dequeue();
      if (stamp && p.timeBase.den !== 0 && p.timeBase.num !== 0) {
        p.pts = p.dts = avRescaleQ(stamp.pts, stamp.timeBase, p.timeBase);
        /**
         * The duration is copied for the same reason, and is just as
         * necessary: encoders with AV_CODEC_CAP_DELAY timestamp their own
         * output packets, and ffmpeg only backfills `pkt->duration` on the
         * no-delay path, so the AMF encoders leave it at 0. Downstream that
         * reads as a 0ms frametime: no pacing, and an RTP timestamp that
         * never advances.
         */
        p.duration = avRescaleQ(stamp.duration, stamp.timeBase, p.timeBase);
      }
      if (traceEncode)
        encodeLog.trace({ packet: describePacket(p) }, "restamped packet");
    }

    out = encoderOutput;
  }

  // the bitstream filters: the mp4 -> annexb conversion, plus the
  // per-keyframe parameter sets. Both paths need this: passthrough packets
  // are length-prefixed, and encoders that do not repeat their parameter
  // sets before every keyframe (h264_amf emits them once, in extradata, and
  // bare IDRs after that) leave a mid-stream viewer with nothing to decode.
  for (const f of chain.bsf) {
    const next: Packet[] = [];
    for (const p of out) {
      next.push(...(await f.filterAll(p)));
      p.free();
    }
    out = next;
  }
  for (const p of out) {
    if (traceTrack)
      trackLog.trace({ packet: describePacket(p) }, "output packet");
    yield p;
  }
}

// Flush the codec buffers and restart the filter graph (filters keep no
// user-visible flush API, so they are recreated). The encoder is
// deliberately not flushed: it is configured without B-frames/lookahead
// buffering, so there is (almost) nothing stale to drop, and flushing an
// encoder mid-stream wedges it (subsequent sends fail).
const flushChain = (chain: TrackChain | undefined) => {
  if (!chain?.transcode) return;
  const { decoder, filter, createFilter } = chain.transcode;
  decoder.getCodecContext()?.flushBuffers();
  chain.transcode.filter = createFilter();
  filter.close();
};

/**
 * Pump one track: consume the demuxer's packets for it and yield the
 * packets to send to Discord, transcoded if the chain has a transcode
 * stage and otherwise passed through untouched.
 */
async function* pumpTrack(
  source: AsyncGenerator<Packet | null>,
  chain: TrackChain,
  signal: AbortSignal | undefined,
  onPacket?: (packet: Packet) => void,
): AsyncGenerator<Packet> {
  let lastDemuxSecs: number | undefined;
  let packetsSinceSeek = 0;
  const { track: logger } = chain.loggers;

  for await (const packet of source) {
    if (!packet || signal?.aborted) break;
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
        logger.debug(
          { jumped, packetsSinceSeek, from: lastDemuxSecs, to: secs },
          "Flushing the chain after seek",
        );
        // frameStamps is deliberately left alone: the encoder is not flushed
        // (see flushChain), so it still holds the frames these entries
        // describe and will emit their packets. Dropping the entries would
        // leave every one of those packets matched to the wrong frame, and
        // the last one to an empty queue.
        flushChain(chain);
      }
    }
    if (secs !== undefined) lastDemuxSecs = secs;
    onPacket?.(packet);

    // with a transcode stage the decoder reads the packet and the stages
    // behind it work on frames; without one the packet itself is what the
    // bitstream filters read. Either way it is done with afterwards.
    yield* drainChain(chain, packet);
    packet.free();
  }
  if (!chain.transcode) return;
  logger.debug("Flushing the chain at the end of the track");
  // flush the decoder, and with it the filter and the encoder behind it
  yield* drainChain(chain, null);
}

/** Live playback state, shared between the pipeline and the controller */
type PlaybackState = {
  /**
   * Current playback position in seconds, tracked from the demuxer's video
   * packets. With copyTs, packet timestamps are the container's absolute
   * timestamps, so this directly reflects the position.
   */
  position: number | undefined;
  /** Current audio volume multiplier (1.0 = original volume) */
  volume: number;
};

function createController(params: {
  demuxer: Demuxer;
  state: PlaybackState;
  videoChain: TrackChain;
  audioChain: TrackChain | undefined;
  duration: number | undefined;
}): Controller {
  const { demuxer, state, videoChain, audioChain, duration } = params;

  return {
    get volume() {
      return state.volume;
    },
    async setVolume(newVolume: number) {
      if (!Number.isFinite(newVolume) || newVolume < 0) return false;
      const filter = audioChain?.transcode?.filter;
      if (!filter) return false;
      try {
        filter.sendCommand("volume@internal_lib", "volume", String(newVolume));
        state.volume = newVolume;
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
        await seekTo(demuxer, positionSeconds);
      } catch {
        return false;
      }
      // the actual flush happens inside each track's generator loop when
      // the jump to the post-seek packets is spotted, so the recreated
      // filter graph anchors on post-seek timestamps
      videoChain.seekPending = true;
      if (audioChain) audioChain.seekPending = true;
      state.position = positionSeconds;
      return true;
    },
    get position() {
      return state.position;
    },
    get duration() {
      return duration;
    },
  };
}

export async function prepareStream(
  input: string | Readable,
  options: Partial<PrepareStreamOptions> = {},
  cancelSignal?: AbortSignal,
): Promise<PrepareStreamResult> {
  cancelSignal?.throwIfAborted();

  const logger = new Log("prepareStream");
  const resolved = resolveOptions(options);
  const {
    noTranscoding,
    width,
    height,
    frameRate,
    videoCodec,
    bitrateAudio,
    volume,
    startPosition,
    videoStream,
    audioStream,
    customInputOptions,
    customFfmpegFlags,
  } = resolved;

  if (customInputOptions.length > 0 || customFfmpegFlags.length > 0) {
    logger.warn(
      "customInputOptions and customFfmpegFlags only apply to the ffmpeg CLI; they are ignored when transcoding in-process",
    );
  }

  const { demuxer, probeWrapper } = await openInput(
    input,
    resolved,
    cancelSignal,
  );

  let videoChain: TrackChain | undefined;
  let audioChain: TrackChain | undefined;
  const closePipeline = () => {
    logger.debug("Closing the pipeline");
    demuxer.close();
    probeWrapper?.destroy();
    if (typeof input !== "string") input.destroy();
    closeChain(videoChain);
    closeChain(audioChain);
  };

  try {
    const videoStreams = demuxer.streams.filter(
      (s) => s.codecpar.codecType === AVMEDIA_TYPE_VIDEO,
    );
    const audioStreams = demuxer.streams.filter(
      (s) => s.codecpar.codecType === AVMEDIA_TYPE_AUDIO,
    );
    const vStream = videoStream(videoStreams);
    const aStream = audioStream(audioStreams);

    logger.info(
      {
        format: demuxer.formatName,
        duration: demuxer.duration,
        bitRate: demuxer.bitRate * 1000,
        streams: demuxer.streams.map(describeStream),
      },
      "Opened demuxer",
    );
    logger.debug(
      {
        videoStreams: videoStreams.map((s) => s.index),
        audioStreams: audioStreams.map((s) => s.index),
        selected: { video: vStream?.index, audio: aStream?.index },
      },
      "Selected streams",
    );

    if (!vStream) {
      throw new Error(
        videoStreams.length === 0
          ? "No video stream in media"
          : "Video output cannot be disabled",
      );
    }

    if (startPosition > 0) {
      logger.info({ startPosition }, "Seeking to the start position");
      try {
        await seekTo(demuxer, startPosition);
      } catch (e) {
        throw new Error("Failed to seek to the given start position", {
          cause: e,
        });
      }
    }

    if (noTranscoding && !allowedVideoCodec.has(vStream.codecpar.codecId)) {
      throw new Error(
        `Video codec ${codecName(vStream.codecpar.codecId)} is not allowed`,
      );
    }

    // with transcoding the packets sent to Discord are the encoder's output,
    // without it the input's own packets are passed through untouched
    const outputCodec = noTranscoding
      ? vStream.codecpar.codecId
      : preparedVideoCodecMap[videoCodec];

    const codecpar = vStream.codecpar;
    const inWidth = codecpar.width ?? 0;
    const inHeight = codecpar.height ?? 0;
    const sourceFramerate = streamFrameRate(vStream);
    const outputSize = computeScaledDims(inWidth, inHeight, width, height);

    const vInfo: VideoStreamInfo = {
      index: vStream.index,
      codec: outputCodec,
      codecpar,
      width: noTranscoding ? inWidth : outputSize.width,
      height: noTranscoding ? inHeight : outputSize.height,
      framerate_num:
        noTranscoding || !frameRate ? sourceFramerate.num : frameRate,
      framerate_den: noTranscoding || !frameRate ? sourceFramerate.den : 1,
      avStream: vStream,
    };
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

    const state: PlaybackState = { position: undefined, volume };

    logger.debug(
      {
        transcode: !noTranscoding,
        videoCodec,
        outputCodec: codecName(outputCodec),
        outputSize,
        sourceFramerate: describeRational(sourceFramerate),
        frameRate,
      },
      "Creating the video chain",
    );
    videoChain = noTranscoding
      ? // no transcode stage: the demuxer's packets are the output, they
        // only need the annexb conversion
        newTrackChain(
          "video",
          null,
          createVideoBitStreamFilters(vStream, outputCodec),
        )
      : await createVideoChain({
          stream: vStream,
          codec: outputCodec,
          options: resolved,
          sourceFramerate,
          outputSize,
          signal: cancelSignal,
        });

    if (aInfo) {
      audioChain = await createAudioChain({
        stream: aInfo.avStream,
        bitrate: bitrateAudio,
        getVolume: () => state.volume,
        signal: cancelSignal,
      });
    }

    const totalDuration =
      demuxer.duration > 0 && Number.isFinite(demuxer.duration)
        ? demuxer.duration
        : undefined;

    logger.info(
      {
        video: {
          stream: vInfo.index,
          codec: codecName(outputCodec),
          width: vInfo.width,
          height: vInfo.height,
          framerate: `${vInfo.framerate_num}/${vInfo.framerate_den}`,
          transcode: !noTranscoding,
        },
        audio: aInfo
          ? {
              stream: aInfo.index,
              codec: codecName(aInfo.codec),
              sampleRate: aInfo.sample_rate,
            }
          : undefined,
        duration: totalDuration,
      },
      "Pipeline ready",
    );

    // track the position from the video packets on their way out
    const trackPosition = (packet: Packet) => {
      const secs = packetSecs(packet);
      if (secs !== undefined) state.position = secs;
    };

    const videoOut = Readable.from(
      pumpTrack(
        demuxer.packets(vStream.index),
        videoChain,
        cancelSignal,
        trackPosition,
      ),
      { objectMode: true },
    );
    const audioOut =
      audioChain && aInfo
        ? Readable.from(
            pumpTrack(demuxer.packets(aInfo.index), audioChain, cancelSignal),
            { objectMode: true },
          )
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
      controller: createController({
        demuxer,
        state,
        videoChain,
        audioChain,
        duration: totalDuration,
      }),
    };
  } catch (e) {
    closePipeline();
    throw e;
  }
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
