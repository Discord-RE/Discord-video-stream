import type { EncoderSettingsGetter } from "./index.js"

type NvencPreset = "p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7"

type NvencSettings = {
    preset: NvencPreset,
    spatialAq: boolean,
    temporalAq: boolean,
    gpu: number
}

export function nvenc({
    preset = "p4",
    spatialAq = false,
    temporalAq = false,
    gpu,
}: Partial<NvencSettings> = {})
{
    const options = [
        `-preset ${preset}`,
        `-spatial-aq ${spatialAq}`,
        `-temporal-aq ${temporalAq}`,
        ...(gpu !== undefined ? [`-gpu ${gpu}`] : [])
    ]
    return (() => ({
        H264: {
            name: "h264_nvenc",
            options
        },
        H265: {
            name: "hevc_nvenc",
            options
        },
        AV1: {
            name: "av1_nvenc",
            options
        }
    })) as EncoderSettingsGetter
}
