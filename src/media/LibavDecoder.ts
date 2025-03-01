import { AV_PIX_FMT_RGBA, AVMEDIA_TYPE_VIDEO } from "@lng2004/libav.js-variant-webcodecs-avf-with-decoders";
import LibAV from "@lng2004/libav.js-variant-webcodecs-avf-with-decoders";

let libavInstance: Promise<LibAV.LibAV>;

// @ts-expect-error
const isDeno = typeof Deno !== "undefined";
// @ts-expect-error
const isBun = typeof Bun !== "undefined";

export async function createDecoder(id: number, codecpar: LibAV.CodecParameters)
{
    if (isDeno || isBun)
    {
        console.error(
            "The decoder currently doesn't work with Deno and Bun, due to " +
            "various issues with Emscripten's pthread support leading to "  +
            "crashes. The decoder will not be initialized"
        );
        return null;
    }
    libavInstance ??= LibAV.LibAV({ yesthreads: true });
    let freed = false;
    let serializer: Promise<unknown> | null = null
    const serialize = <T>(f: () => Promise<T>) => {
        let p: Promise<T>;
        if (serializer)
        {
            p = serializer.catch(() => {}).then(() => f());
        }
        else
        {
            p = f();
        }
        serializer = p = p.finally(() => {
            if (serializer === p)
                serializer = null;
        });
        return p;
    }
    const libav = await libavInstance;
    const [, c, pkt, frame] = await libav.ff_init_decoder(id, {
        codecpar
    });
    const { width, height, format } = codecpar;
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
        decode: async (packets: (LibAV.Packet | number)[]) => {
            if (freed)
                return [];
            return serialize(
                () => libav.ff_decode_filter_multi(
                    c, src_ctx, sink_ctx, pkt, frame, packets, { ignoreErrors: true }
                )
            )
        },
        free: () => {
            freed = true;
            serialize(() => libav.ff_decode_filter_multi(
                c, src_ctx, sink_ctx, pkt, frame, [], { fin: true, ignoreErrors: true }
            ));
            return serialize(async() => {
                libav.ff_free_decoder(c, pkt, frame);
                libav.avfilter_graph_free_js(graph);  
            });
        }
    }
}
