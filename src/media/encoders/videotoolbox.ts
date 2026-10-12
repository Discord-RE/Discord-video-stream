import {
  FF_ENCODER_H264_VIDEOTOOLBOX,
  FF_ENCODER_HEVC_VIDEOTOOLBOX,
} from "node-av";
import type { EncoderSettingsGetter } from "./index.js";
import { assertPlatformSupported } from "./platform.js";

export function videotoolbox() {
  return (() => {
    assertPlatformSupported("videotoolbox", "darwin");
    return {
      H264: {
        name: FF_ENCODER_H264_VIDEOTOOLBOX,
        options: {},
      },
      H265: {
        name: FF_ENCODER_HEVC_VIDEOTOOLBOX,
        options: {},
      },
    };
  }) as EncoderSettingsGetter;
}
