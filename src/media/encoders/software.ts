import {
  FF_ENCODER_LIBSVTAV1,
  FF_ENCODER_LIBVPX_VP8,
  FF_ENCODER_LIBVPX_VP9,
  FF_ENCODER_LIBX264,
  FF_ENCODER_LIBX265,
} from "node-av";
import type { EncoderSettingsGetter } from "./index.js";

type DeepPartial<T> = T extends unknown[]
  ? T
  : { [P in keyof T]?: DeepPartial<T[P]> };
type x26xPreset =
  | "ultrafast"
  | "superfast"
  | "veryfast"
  | "faster"
  | "fast"
  | "medium"
  | "slow"
  | "slower"
  | "veryslow"
  | "placebo";

export type SoftwareEncoderSettings = {
  x264: {
    preset: x26xPreset;
    tune:
      | "film"
      | "animation"
      | "grain"
      | "stillimage"
      | "fastdecode"
      | "zerolatency"
      | "psnr"
      | "ssim";
  };
  x265: {
    preset: x26xPreset;
    tune:
      | "psnr"
      | "ssim"
      | "grain"
      | "fastdecode"
      | "zerolatency"
      | "animation";
  };
};

export const software = ({
  x264,
  x265,
}: DeepPartial<SoftwareEncoderSettings> = {}) => {
  const { preset: x264Preset = "superfast", tune: x264Tune = "film" } =
    x264 ?? {};
  const { preset: x265Preset = "superfast", tune: x265Tune } = x265 ?? {};
  return (() => ({
    H264: {
      name: FF_ENCODER_LIBX264,
      options: { "forced-idr": "1", tune: x264Tune, preset: x264Preset },
    },
    H265: {
      name: FF_ENCODER_LIBX265,
      options: {
        "forced-idr": "1",
        ...(x265Tune ? { tune: x265Tune } : {}),
        preset: x265Preset,
      },
    },
    VP8: {
      name: FF_ENCODER_LIBVPX_VP8,
      options: { deadline: "20000" },
    },
    VP9: {
      name: FF_ENCODER_LIBVPX_VP9,
      options: { deadline: "20000" },
    },
    AV1: {
      name: FF_ENCODER_LIBSVTAV1,
      options: {},
    },
  })) as EncoderSettingsGetter;
};
