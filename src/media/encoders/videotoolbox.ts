import {
  FF_ENCODER_H264_VIDEOTOOLBOX,
  FF_ENCODER_HEVC_VIDEOTOOLBOX,
} from "node-av";
import type { EncoderSettingsGetter } from "./index.js";

export function videotoolbox() {
  return (() => ({
    H264: {
      name: FF_ENCODER_H264_VIDEOTOOLBOX,
      options: {},
    },
    H265: {
      name: FF_ENCODER_HEVC_VIDEOTOOLBOX,
      options: {},
    },
  })) as EncoderSettingsGetter;
}
