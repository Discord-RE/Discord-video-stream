import type { EncoderSettingsGetter } from "./index.js"

type DeepPartial<T> = T extends unknown[] ? T : { [P in keyof T]?: DeepPartial<T[P]> }
type x26xPreset = "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow" | "placebo";

export type SoftwareEncoderSettings = {
    x264: {
        preset: x26xPreset,
        tune: "film" | "animation" | "grain" | "stillimage" | "fastdecode" | "zerolatency" | "psnr" | "ssim"
    },
    x265: {
        preset: x26xPreset,
        tune: "psnr" | "ssim" | "grain" | "fastdecode" | "zerolatency" | "animation"
    }
}

export const software = ({
    x264, x265
}: DeepPartial<SoftwareEncoderSettings> = {}) => {
    const {
        preset: x264Preset = "ultrafast",
        tune: x264Tune = "film"
    } = x264 ?? {};
    const {
        preset: x265Preset = "ultrafast",
        tune: x265Tune
    } = x265 ?? {};
    return (() => ({
        H264: {
            name: "libx264",
            options: [
                "-forced-idr 1",
                `-tune ${x264Tune}`,
                `-preset ${x264Preset}`,
            ]
        },
        H265: {
            name: "libx265",
            options: [
                "-forced-idr 1",
                ...(x265Tune ? [`-tune ${x265Tune}`] : []),
                `-preset ${x265Preset}`,
            ]
        },
        VP8: {
            name: "libvpx",
            options: [
                "-deadline 20000"
            ]
        },
        VP9: {
            name: "libvpx-vp9",
            options: [
                "-deadline 20000"
            ]
        },
        AV1: {
            name: "libsvtav1",
            options: []
        }
    })) as EncoderSettingsGetter
}
