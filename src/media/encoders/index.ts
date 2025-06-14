import type { SupportedVideoCodec } from "../../utils.js"

export type EncoderSettings = {
    name: string,
    options: string[]
}

export type EncoderSettingsGetter = (bitrate: number, bitrateMax: number) => Partial<
    Record<SupportedVideoCodec, EncoderSettings>
>;

import { software } from "./software.js";
import { nvenc } from "./nvenc.js";
import { merge } from "./merge.js";

const Encoders = {
    software, nvenc, merge
}

export { Encoders }
