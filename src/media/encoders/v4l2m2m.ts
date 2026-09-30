import {
  FF_ENCODER_H264_V4L2M2M,
  FF_ENCODER_HEVC_V4L2M2M,
  FF_ENCODER_VP8_V4L2M2M,
} from "node-av";
import type { EncoderSettingsGetter } from "./index.js";

export function v4l2m2m() {
  return (() => ({
    H264: {
      name: FF_ENCODER_H264_V4L2M2M,
      options: {},
    },
    H265: {
      name: FF_ENCODER_HEVC_V4L2M2M,
      options: {},
    },
    VP8: {
      name: FF_ENCODER_VP8_V4L2M2M,
      options: {},
    },
  })) as EncoderSettingsGetter;
}
