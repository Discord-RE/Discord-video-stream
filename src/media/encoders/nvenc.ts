import {
  FF_ENCODER_AV1_NVENC,
  FF_ENCODER_H264_NVENC,
  FF_ENCODER_HEVC_NVENC,
} from "node-av";
import type { EncoderSettingsGetter } from "./index.js";

type NvencPreset = "p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7";

type NvencSettings = {
  preset: NvencPreset;
  spatialAq: boolean;
  temporalAq: boolean;
  gpu: number;
};

export function nvenc({
  preset = "p4",
  spatialAq = false,
  temporalAq = false,
  gpu,
}: Partial<NvencSettings> = {}) {
  const options = {
    preset,
    "spatial-aq": spatialAq ? "1" : "0",
    "temporal-aq": temporalAq ? "1" : "0",
    ...(gpu !== undefined ? { gpu: String(gpu) } : {}),
  };
  return (() => ({
    H264: {
      name: FF_ENCODER_H264_NVENC,
      options,
    },
    H265: {
      name: FF_ENCODER_HEVC_NVENC,
      options,
    },
    AV1: {
      name: FF_ENCODER_AV1_NVENC,
      options,
    },
  })) as EncoderSettingsGetter;
}
