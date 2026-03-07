export type DecoderSettings = {
  scaler: (w: number, h: number) => string[];
  globalOptions?: string[];
  inputOptions: string[];
};

import { vaapi } from "./vaapi.js";

export const HardwareDecoders = {
  vaapi,
};
