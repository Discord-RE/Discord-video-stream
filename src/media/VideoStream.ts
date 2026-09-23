import type { WebRtcConnWrapper } from "../client/voice/WebRtcWrapper.js";
import {
  BaseMediaStream,
  type BaseMediaStreamOptions,
} from "./BaseMediaStream.js";

export class VideoStream extends BaseMediaStream {
  private _conn: WebRtcConnWrapper;
  constructor(conn: WebRtcConnWrapper, options: BaseMediaStreamOptions = {}) {
    super("video", options);
    this._conn = conn;
  }

  protected override async _sendFrame(
    frame: Buffer,
    frametime: number,
  ): Promise<void> {
    this._conn.sendVideoFrame(frame, frametime);
  }
}
