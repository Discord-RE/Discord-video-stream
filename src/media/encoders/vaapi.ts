import type { EncoderSettingsGetter } from "./index.js";

type VaapiSettings = {
  device?: string
};

export function vaapi({
  device = "/dev/dri/renderD128"
}: Partial<VaapiSettings> = {}) {
  const props = {
    options: [],
    globalOptions: ["-vaapi_device", device],
    outFilters: ["format=nv12|vaapi", "hwupload"]
  }
  return (() => ({
    H264: {
      name: "h264_vaapi",
      ...props,
    },
    H265: {
      name: "hevc_vaapi",
      ...props
    },
    AV1: {
      name: "av1_vaapi",
      ...props
    },
  })) as EncoderSettingsGetter;
}
