export type DecoderSettings = {
  scaler: string;
  globalOptions?: string[];
  inputOptions: string[];
};

import { vaapi } from "./vaapi.js";

export const HardwareDecoders = {
  vaapi,
};
