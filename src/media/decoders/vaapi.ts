import type { DecoderSettings } from "./index.js";

type VaapiSettings = {
  device?: string;
};

export function vaapi({
  device = "/dev/dri/renderD128",
}: Partial<VaapiSettings> = {}) {
  return {
    scaler: (w, h) => [
      "format=nv12|vaapi",
      "hwupload",
      `scale_vaapi=w=${w}:h=${h}`,
    ],
    globalOptions: ["-hwaccel", "vaapi"],
    inputOptions: [
      "-hwaccel_device",
      device,
      "-hwaccel_output_format",
      "vaapi",
    ],
  } satisfies DecoderSettings;
}
