import {
  FF_ENCODER_AV1_AMF,
  FF_ENCODER_H264_AMF,
  FF_ENCODER_HEVC_AMF,
} from "node-av";
import type { EncoderSettingsGetter } from "./index.js";
import { assertPlatformSupported } from "./platform.js";

export function amf() {
  return (() => {
    assertPlatformSupported("amf", "linux", "win32");
    return {
      H264: {
        name: FF_ENCODER_H264_AMF,
        options: {},
      },
      H265: {
        name: FF_ENCODER_HEVC_AMF,
        options: {},
      },
      AV1: {
        name: FF_ENCODER_AV1_AMF,
        options: {},
      },
    };
  }) as EncoderSettingsGetter;
}
