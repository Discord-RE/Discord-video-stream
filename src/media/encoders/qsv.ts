import { FF_ENCODER_AV1_QSV, FF_ENCODER_H264_QSV, FF_ENCODER_HEVC_QSV, FF_ENCODER_VP9_QSV } from "node-av";
import type { EncoderSettingsGetter } from "./index.js";

export function qsv() {
  return (() => ({
    H264: {
      name: FF_ENCODER_H264_QSV,
      options: {},
    },
    H265: {
      name: FF_ENCODER_HEVC_QSV,
      options: {},
    },
    VP9: {
      name: FF_ENCODER_VP9_QSV,
      options: {},
    },
    AV1: {
      name: FF_ENCODER_AV1_QSV,
      options: {},
    },
  })) as EncoderSettingsGetter;
}
