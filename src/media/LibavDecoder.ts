import { Decoder, FilterAPI, Frame, Packet, Stream } from "node-av";

export async function createDecoder(stream: Stream) {
  const decoder = await Decoder.create(stream);
  let freed = false;
  let serializer: Promise<unknown> | null = null;
  const serialize = <T>(f: () => Promise<T>) => {
    let p: Promise<T>;
    if (serializer) {
      p = serializer.catch(() => {}).then(() => f());
    } else {
      p = f();
    }
    serializer = p = p.finally(() => {
      if (serializer === p) serializer = null;
    });
    return p;
  };
  const filter = FilterAPI.create("format=pix_fmts=rgba");
  return {
    decode: async (packets: Packet) => {
      if (freed) return [];

      return serialize(async () => {
        const frames = await decoder.decodeAll(packets);
        let filtered: Frame[] = [];
        for (const frame of frames)
        {
          filtered = [...filtered, ...await filter.processAll(frame)];
        }
        return filtered;
      });
    },
    free: () => {
      freed = true;
      return serialize(async () => {
        decoder.close();
        filter.close();
      });
    },
  };
}
