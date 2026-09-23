import type { WebRtcConnWrapper } from "../client/voice/WebRtcWrapper.js";
import {
  BaseMediaStream,
  type BaseMediaStreamOptions,
} from "./BaseMediaStream.js";

// Static highWaterMark ceiling (packets): absolute cap on queued media.
// The dynamic HWM never exceeds this.
const HWM_MAX_FRAMES = 64;
// Headroom above the jitter target before throttling upstream. Video
// bursts are burstier (keyframes), and a stalled video pipe
// head-of-line-blocks audio in the shared demux loop.
const HWM_HEADROOM_MS = 400;

export class VideoStream extends BaseMediaStream {
  private _conn: WebRtcConnWrapper;
  constructor(conn: WebRtcConnWrapper, options: BaseMediaStreamOptions = {}) {
    super("video", options, {
      hwmMaxFrames: HWM_MAX_FRAMES,
      bufferHeadroomMs: HWM_HEADROOM_MS,
    });
    this._conn = conn;
  }

  protected override async _sendFrame(
    frame: Buffer,
    frametime: number,
  ): Promise<void> {
    this._conn.sendVideoFrame(frame, frametime);
  }
}
