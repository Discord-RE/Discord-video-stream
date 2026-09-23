import type { WebRtcConnWrapper } from "../client/voice/WebRtcWrapper.js";
import {
  BaseMediaStream,
  type BaseMediaStreamOptions,
} from "./BaseMediaStream.js";

// Static highWaterMark ceiling (packets): absolute cap on queued media.
// The dynamic HWM never exceeds this.
const HWM_MAX_FRAMES = 40;
// Headroom above the jitter target before throttling upstream. Audio
// bursts are gentler than video's (no keyframes), so a smaller margin
// keeps audio latency low.
const HWM_HEADROOM_MS = 150;

export class AudioStream extends BaseMediaStream {
  private _conn: WebRtcConnWrapper;

  constructor(conn: WebRtcConnWrapper, options: BaseMediaStreamOptions = {}) {
    super("audio", options, {
      hwmMaxFrames: HWM_MAX_FRAMES,
      bufferHeadroomMs: HWM_HEADROOM_MS,
    });
    this._conn = conn;
  }

  protected override async _sendFrame(
    frame: Buffer,
    frametime: number,
  ): Promise<void> {
    this._conn.sendAudioFrame(frame, frametime);
  }
}
