import type {
  AVHWDeviceType,
  FFEncoderCodec,
  UnknownEncoderOptions,
} from "node-av";
import {
  AV_HWDEVICE_TYPE_AMF,
  AV_HWDEVICE_TYPE_CUDA,
  AV_HWDEVICE_TYPE_D3D11VA,
  AV_HWDEVICE_TYPE_QSV,
  AV_HWDEVICE_TYPE_VAAPI,
  AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
  AV_HWDEVICE_TYPE_VULKAN,
} from "node-av";
import type { SupportedVideoCodec } from "../../utils.js";

export type EncoderSettings = {
  name: FFEncoderCodec;
  options: UnknownEncoderOptions;
  /**
   * Hardware device used for encoding, e.g. "/dev/dri/renderD129" for VAAPI.
   * The hardware type itself is deduced from the encoder name; leave unset to
   * use the system default device.
   */
  device?: string;
  outFilters?: string[];
};

/**
 * Hardware info deduced from the encoder name suffix, e.g. "h264_vaapi" ->
 * VAAPI, "hevc_nvenc" -> CUDA. Encoders not listed here accept system memory
 * frames and self-manage their hardware contexts.
 */
export type HardwareEncoderInfo = {
  /** Hardware device type used for the device context */
  deviceType: AVHWDeviceType;
  /** Hardware scale filter, when the encoder has one */
  scaleFilter?: string;
};

const hardwareBySuffix: Record<string, HardwareEncoderInfo> = {
  vaapi: { deviceType: AV_HWDEVICE_TYPE_VAAPI, scaleFilter: "scale_vaapi" },
  vulkan: { deviceType: AV_HWDEVICE_TYPE_VULKAN, scaleFilter: "scale_vulkan" },
  nvenc: { deviceType: AV_HWDEVICE_TYPE_CUDA, scaleFilter: "scale_cuda" },
  cuda: { deviceType: AV_HWDEVICE_TYPE_CUDA, scaleFilter: "scale_cuda" },
  qsv: { deviceType: AV_HWDEVICE_TYPE_QSV, scaleFilter: "scale_qsv" },
  videotoolbox: {
    deviceType: AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
    scaleFilter: "scale_vt",
  },
  amf: { deviceType: AV_HWDEVICE_TYPE_AMF, scaleFilter: "vpp_amf" },
  d3d11va: { deviceType: AV_HWDEVICE_TYPE_D3D11VA },
};

export function hardwareForEncoder(name: string): HardwareEncoderInfo | null {
  const suffix = name.split("_").at(-1);
  return (suffix && hardwareBySuffix[suffix]) || null;
}

export type EncoderSettingsGetter = (
  bitrate: number,
  bitrateMax: number,
) => Partial<Record<SupportedVideoCodec, EncoderSettings>>;

import { amf } from "./amf.js";
import { merge } from "./merge.js";
import { nvenc } from "./nvenc.js";
import { qsv } from "./qsv.js";
import { software } from "./software.js";
import { v4l2m2m } from "./v4l2m2m.js";
import { vaapi } from "./vaapi.js";
import { videotoolbox } from "./videotoolbox.js";

const Encoders = {
  software,
  nvenc,
  vaapi,
  qsv,
  videotoolbox,
  amf,
  v4l2m2m,
  merge,
};

export { Encoders };
