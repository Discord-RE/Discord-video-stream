import type { AVHWDeviceType, FFEncoderCodec, UnknownEncoderOptions } from "node-av";
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
 * Hardware device types deduced from the encoder name suffix, e.g.
 * "h264_vaapi" -> VAAPI, "hevc_nvenc" -> CUDA. Encoders not listed here
 * accept system memory frames and self-manage their hardware contexts.
 */
const hardwareTypeBySuffix: Record<string, AVHWDeviceType> = {
  vaapi: AV_HWDEVICE_TYPE_VAAPI,
  vulkan: AV_HWDEVICE_TYPE_VULKAN,
  nvenc: AV_HWDEVICE_TYPE_CUDA,
  cuda: AV_HWDEVICE_TYPE_CUDA,
  qsv: AV_HWDEVICE_TYPE_QSV,
  videotoolbox: AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
  amf: AV_HWDEVICE_TYPE_AMF,
  d3d11va: AV_HWDEVICE_TYPE_D3D11VA,
};

export function hardwareTypeForEncoder(name: string): AVHWDeviceType | null {
  const suffix = name.split("_").at(-1);
  return (suffix && hardwareTypeBySuffix[suffix]) || null;
}

export type EncoderSettingsGetter = (
  bitrate: number,
  bitrateMax: number,
) => Partial<Record<SupportedVideoCodec, EncoderSettings>>;

import { merge } from "./merge.js";
import { nvenc } from "./nvenc.js";
import { software } from "./software.js";
import { vaapi } from "./vaapi.js";
import { amf } from "./amf.js";
import { qsv } from "./qsv.js";
import { videotoolbox } from "./videotoolbox.js";
import { v4l2m2m } from "./v4l2m2m.js";

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
