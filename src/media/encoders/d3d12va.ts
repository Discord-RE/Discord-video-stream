import {
  FF_ENCODER_AV1_D3D12VA,
  FF_ENCODER_H264_D3D12VA,
  FF_ENCODER_HEVC_D3D12VA,
} from "node-av";
import type { EncoderSettingsGetter } from "./index.js";
import { assertPlatformSupported } from "./platform.js";

type D3D12VASettings = {
  /**
   * Index of the D3D12 adapter to use, as reported by the Windows display
   * adapter ordering. Leave unset to use the system default adapter.
   */
  device?: string;
};

export function d3d12va({ device }: Partial<D3D12VASettings> = {}) {
  const props = {
    options: {},
    device,
    outFilters: ["format=nv12|d3d12", "hwupload"],
  };
  return (() => {
    assertPlatformSupported("d3d12va", "win32");
    return {
      H264: {
        name: FF_ENCODER_H264_D3D12VA,
        ...props,
      },
      H265: {
        name: FF_ENCODER_HEVC_D3D12VA,
        ...props,
      },
      AV1: {
        name: FF_ENCODER_AV1_D3D12VA,
        ...props,
      },
    };
  }) as EncoderSettingsGetter;
}
