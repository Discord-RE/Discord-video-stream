import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { Log } from "debug-level";
import {
  avGetCodecName,
  BitStreamFilterAPI,
  type CodecParameters,
  Demuxer,
  type Packet,
  type Rational,
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

export const allowedVideoCodec = new Set([
  AVCodecID.AV_CODEC_ID_H264,
  AVCodecID.AV_CODEC_ID_H265,
  AVCodecID.AV_CODEC_ID_VP8,
  AVCodecID.AV_CODEC_ID_VP9,
  AVCodecID.AV_CODEC_ID_AV1,
]);

const allowedAudioCodec = new Set([AVCodecID.AV_CODEC_ID_OPUS]);

/**
 * Frame rate of the stream. `codecpar.frameRate` is often missing (0/0), so
 * it falls back to the stream's average and real base frame rates.
 */
export function streamFrameRate(stream: Stream): Rational {
  const codecpar = stream.codecpar.frameRate;
  if (codecpar.num > 0 && codecpar.den > 0) return codecpar;
  if (stream.avgFrameRate.num > 0 && stream.avgFrameRate.den > 0) {
    return stream.avgFrameRate;
  }
  return stream.rFrameRate;
}

export function parseOpusPacketDuration(frame: Uint8Array) {
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

/**
 * Build the bitstream filter chain that turns video packets into the annexb
 * format expected by Discord's RTP packetizer. The mp4 -> annexb filters
 * detect already-annexb input on their own and pass it through untouched.
 */
export function createVideoBitStreamFilters(
  vStream: Stream,
): BitStreamFilterAPI[] {
  switch (vStream.codecpar.codecId) {
    case AVCodecID.AV_CODEC_ID_H264: {
      const mp4ToAnnexb = BitStreamFilterAPI.create("h264_mp4toannexb", vStream);
      // filter_units only inspects NAL headers (no CBS RBSP parsing),
      // so AUD removal stays tolerant of malformed filler.
      const removeAud = BitStreamFilterAPI.create("filter_units", mp4ToAnnexb, {
        options: {
          remove_types: String(H264NalUnitTypes.AccessUnitDelimiter),
        },
      });
      const dumpExtra = BitStreamFilterAPI.create("dump_extra", removeAud);
      return [mp4ToAnnexb, removeAud, dumpExtra];
    }
    case AVCodecID.AV_CODEC_ID_HEVC: {
      const mp4ToAnnexb = BitStreamFilterAPI.create("hevc_mp4toannexb", vStream);
      const removeAud = BitStreamFilterAPI.create("filter_units", mp4ToAnnexb, {
        options: {
          remove_types: String(H265NalUnitTypes.AUD_NUT),
        },
      });
      const dumpExtra = BitStreamFilterAPI.create("dump_extra", removeAud);
      return [mp4ToAnnexb, removeAud, dumpExtra];
    }
    default:
      return [BitStreamFilterAPI.create("null", vStream)];
  }
}

export async function applyBitStreamFilters(
  packet: Packet | null,
  filters: BitStreamFilterAPI[],
) {
  let packets = [packet];
  for (const filter of filters) {
    const newPackets: (Packet | null)[] = [];
    for (const p of packets) {
      newPackets.push(...(await filter.filterAll(p)));
      p?.free();
    }
    if (!packet) newPackets.push(null);
    packets = newPackets;
  }
  return packets;
}

export async function demux(input: Readable, { format }: DemuxerOptions) {
  const loggerFormat = new Log("demux:format");
  const loggerFrameCommon = new Log("demux:frame:common");
  const loggerFrameVideo = new Log("demux:frame:video");
  const loggerFrameAudio = new Log("demux:frame:audio");

  const filename = randomUUID();
  const demuxer = await Demuxer.open(input, {
    options: {
      fflags: "nobuffer",
    },
    format,
    bufferSize: 8192,
  });

  const vStream = demuxer.video();
  const aStream = demuxer.audio();

  let vInfo: VideoStreamInfo | undefined;
  let aInfo: AudioStreamInfo | undefined;
  const vPipe = new PassThrough({
    objectMode: true,
    writableHighWaterMark: 128,
  });
  const aPipe = new PassThrough({
    objectMode: true,
    writableHighWaterMark: 128,
  });

  const vbsf: BitStreamFilterAPI[] = [];

  const packetIterator = demuxer.packets();
  const readFrame = pDebounce.promise(async () => {
    let resume = true;
    while (resume) {
      try {
        const { value: inPacket, done } = await packetIterator.next();
        if (done) {
          loggerFrameCommon.info("Reached end of stream. Stopping");
          const packets = await applyBitStreamFilters(null, vbsf);
          for (const packet of packets) {
            if (packet) vPipe.write(packet);
          }
          cleanup();
          return;
        }
        if (inPacket) {
          const streamIndex = inPacket.streamIndex;
          if (vInfo && vInfo.index === streamIndex) {
            loggerFrameVideo.trace("Received a video packet");
            const packets = await applyBitStreamFilters(inPacket.clone(), vbsf);
            for (const packet of packets) {
              if (packet) resume &&= vPipe.write(packet);
            }
          } else if (aInfo && aInfo.index === streamIndex) {
            const packet = inPacket.clone()!;
            packet.duration ||= BigInt(parseOpusPacketDuration(packet.data!));
            resume &&= aPipe.write(packet);
          }
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

  const cleanup = () => {
    input.destroy();
    demuxer.close();
    vPipe.off("drain", readFrame);
    aPipe.off("drain", readFrame);
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
      vbsf.push(...createVideoBitStreamFilters(vStream));
    } catch (e) {
      cleanup();
      throw new Error("Failed to construct bitstream filterchain", {
        cause: (e as Error).cause,
      });
    }

    const codecpar = vStream.codecpar;
    const framerate = streamFrameRate(vStream);
    vInfo = {
      index: vStream.index,
      codec: codecId,
      codecpar,
      width: codecpar.width ?? 0,
      height: codecpar.height ?? 0,
      framerate_num: framerate.num,
      framerate_den: framerate.den,
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
    video: vInfo ? { ...vInfo, stream: vPipe } : undefined,
    audio: aInfo ? { ...aInfo, stream: aPipe } : undefined,
  };
}
