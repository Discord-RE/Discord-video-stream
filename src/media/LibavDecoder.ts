import { AV_PIX_FMT_RGBA, AVMEDIA_TYPE_VIDEO } from "@lng2004/libav.js-variant-webcodecs-avf-with-decoders";
import { libavInstance } from "./LibavInstance.js";
import type LibAV from "@lng2004/libav.js-variant-webcodecs-avf-with-decoders";

export async function createDecoder(id: number, codecpar: number)
{
    let serializer = Promise.resolve([] as LibAV.Frame[]);
    const libav = await libavInstance;
    const [, c, pkt, frame] = await libav.ff_init_decoder(id, {
        codecpar
    });
    const { width, height, format } = await libav.ff_copyout_codecpar(codecpar);
    const [graph, src_ctx, sink_ctx] = await libav.ff_init_filter_graph(
        "format=pix_fmts=rgba",
        {
            type: AVMEDIA_TYPE_VIDEO,
            width: width ?? 0,
            height: height ?? 0,
            pix_fmt: format ?? 0
        },
        {
            type: AVMEDIA_TYPE_VIDEO,
            width: width ?? 0,
            height: height ?? 0,
            pix_fmt: AV_PIX_FMT_RGBA
        }
    );
    return {
        decode: (packets: (LibAV.Packet | number)[]) => {
            serializer = serializer.then(
                () => libav.ff_decode_filter_multi(
                    c, src_ctx, sink_ctx, pkt, frame, packets, { ignoreErrors: true }
                )
            )
            return serializer;
        },
        free: () => {
            libav.ff_free_decoder(c, pkt, frame);
        }
    }
}
