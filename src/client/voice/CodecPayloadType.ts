export const CodecPayloadType = {
  "opus": {
    name: "opus", type: "audio", clockRate: 48000, priority: 1000, payload_type: 120
  },
  "H264": {
    name: "H264", type: "video", clockRate: 90000, priority: 1000, payload_type: 101, rtx_payload_type: 102, encode: true, decode: true
  },
  "H265": {
    name: "H265", type: "video", clockRate: 90000, priority: 1000, payload_type: 103, rtx_payload_type: 104, encode: true, decode: true
  },
  "VP8": {
    name: "VP8", type: "video", clockRate: 90000, priority: 1000, payload_type: 105, rtx_payload_type: 106, encode: true, decode: true
  },
  "VP9": {
    name: "VP9", type: "video", clockRate: 90000, priority: 1000, payload_type: 107, rtx_payload_type: 108, encode: true, decode: true
  },
  "AV1": {
    name: "AV1", type: "video", clockRate: 90000, priority: 1000, payload_type: 109, rtx_payload_type: 110, encode: true, decode: true
  }
} as const;
