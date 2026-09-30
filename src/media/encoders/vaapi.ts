import {
  FF_ENCODER_AV1_VAAPI,
  FF_ENCODER_H264_VAAPI,
  FF_ENCODER_HEVC_VAAPI,
  FF_ENCODER_VP8_VAAPI,
  FF_ENCODER_VP9_VAAPI,
} from "node-av";
import type { EncoderSettingsGetter } from "./index.js";

type VaapiSettings = {
  device?: string;
};

export function vaapi({
  device = "/dev/dri/renderD128",
}: Partial<VaapiSettings> = {}) {
  const props = {
    options: {},
    device,
    outFilters: ["format=nv12|vaapi", "hwupload"],
  };
  return (() => ({
    H264: {
      name: FF_ENCODER_H264_VAAPI,
      ...props,
    },
    H265: {
      name: FF_ENCODER_HEVC_VAAPI,
      ...props,
    },
    VP8: {
      name: FF_ENCODER_VP8_VAAPI,
      ...props,
    },
    VP9: {
      name: FF_ENCODER_VP9_VAAPI,
      ...props,
    },
    AV1: {
      name: FF_ENCODER_AV1_VAAPI,
      ...props,
    },
  })) as EncoderSettingsGetter;
}
