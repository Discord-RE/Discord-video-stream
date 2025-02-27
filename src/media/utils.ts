import LibAV from "@lng2004/libav.js-variant-webcodecs-avf-with-decoders";

export function combineLoHi(hi: number, lo: number): number
{
    return LibAV.i64tof64(lo, hi);
}
