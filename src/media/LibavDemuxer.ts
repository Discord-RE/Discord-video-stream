import pDebounce from "p-debounce";
import { BitStreamFilterAPI, Demuxer, avGetCodecName } from "node-av";
import { Log } from "debug-level";
import { randomUUID } from "node:crypto";
import { AVCodecID } from "./LibavCodecId.js";
import { PassThrough } from "node:stream";
import type { CodecParameters } from "node-av";
import type { Readable } from "node:stream";

type MediaStreamInfoCommon = {
  index: number;
  codec: AVCodecID;
  codecpar: CodecParameters;
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
  const loggerInput = new Log("demux:input");
  const loggerFormat = new Log("demux:format");
  const loggerFrameCommon = new Log("demux:frame:common");
  const loggerFrameVideo = new Log("demux:frame:video");
  const loggerFrameAudio = new Log("demux:frame:audio");

  const filename = randomUUID();
  const inputIterator = input.iterator();
  const demuxer = await Demuxer.open(
    {
      async read() {
        try {
          const { value, done } = await inputIterator.next();
          if (done) {
            loggerInput.trace(`Reached the end of input ${filename}`);
            return null;
          }
          const buf = value as Buffer;
          loggerInput.trace(
            `Received ${buf.length} bytes of data for input ${filename}`,
          );
          return buf;
        } catch (e) {
          loggerInput.trace(`An error occurred on input ${filename}`, e);
          return null;
        }
      },
    },
    {
      options: {
        fflags: "nobuffer",
      },
      format,
    },
  );

  const cleanup = () => {
    input.destroy();
    demuxer.close();
    vPipe.off("drain", readFrame);
    aPipe.off("drain", readFrame);
    vPipe.end();
    aPipe.end();
    vbsf.forEach((e) => {
      e.close();
    });
  };

  const vStream = demuxer.video();
  const aStream = demuxer.audio();

  let vInfo: VideoStreamInfo | undefined;
  let aInfo: AudioStreamInfo | undefined;
  const vPipe = new PassThrough({
    objectMode: true,
    writableHighWaterMark: 8,
  });
  const aPipe = new PassThrough({
    objectMode: true,
    writableHighWaterMark: 8,
  });

  const vbsf: BitStreamFilterAPI[] = [];
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
          vbsf.push(
            BitStreamFilterAPI.create("h264_metadata", vStream, {
              options: {
                aud: "remove",
              },
            }),
          );
          vbsf.push(BitStreamFilterAPI.create("dump_extra", vStream));
          break;
        case AVCodecID.AV_CODEC_ID_HEVC:
          vbsf.push(BitStreamFilterAPI.create("hevc_mp4toannexb", vStream));
          vbsf.push(
            BitStreamFilterAPI.create("hevc_metadata", vStream, {
              options: {
                aud: "remove",
              },
            }),
          );
          vbsf.push(BitStreamFilterAPI.create("dump_extra", vStream));
          break;
        default:
          vbsf.push(BitStreamFilterAPI.create("null", vStream));
          break;
      }
      for (let i = 1; i < vbsf.length; ++i) vbsf[i - 1].pipeTo(vbsf[i]);
    } catch (e) {
      cleanup();
      throw new Error(`Failed to construct bitstream filterchain`, {
        cause: (e as Error).cause,
      });
    }

    const codecpar = vbsf.at(-1)?.outputCodecParameters ?? vStream.codecpar;
    vInfo = {
      index: vStream.index,
      codec: codecId,
      codecpar,
      width: codecpar.width ?? 0,
      height: codecpar.height ?? 0,
      framerate_num: codecpar.frameRate.num,
      framerate_den: codecpar.frameRate.den,
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
    };
    loggerFormat.info(
      {
        info: aInfo,
      },
      `Found audio stream in input ${filename}`,
    );
  }

  const packetIterator = demuxer.packets();
  const readFrame = pDebounce.promise(async () => {
    const filterIn = vbsf.at(0)!;
    const filterOut = vbsf.at(-1)!;
    let resume = true;
    while (resume) {
      try {
        const { value: inPacket, done } = await packetIterator.next();
        if (done) {
          loggerFrameCommon.info("Reached end of stream. Stopping");
          filterIn.sendToQueue(null);
          while (true) {
            const packet = await filterOut.receiveFromQueue();
            if (!packet) break;
            vPipe.write(packet.clone());
            packet.free();
          }
          cleanup();
          return;
        } else if (inPacket) {
          const streamIndex = inPacket.streamIndex;
          if (vInfo && vInfo.index === streamIndex) {
            loggerFrameVideo.trace("Received a video packet");
            filterIn.sendToQueue(inPacket);
            while (true) {
              const packet = await filterOut.receiveFromQueue();
              if (!packet) break;
              resume &&= vPipe.write(packet.clone());
              packet.free();
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
    audio: aInfo ? { ...aInfo, stream: aPipe as Readable } : undefined,
  };
}
