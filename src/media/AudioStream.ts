import type { WebRtcConnWrapper } from "../client/voice/WebRtcWrapper.js";
import {
  BaseMediaStream,
  type BaseMediaStreamOptions,
} from "./BaseMediaStream.js";

export class AudioStream extends BaseMediaStream {
  private _conn: WebRtcConnWrapper;

  constructor(conn: WebRtcConnWrapper, options: BaseMediaStreamOptions = {}) {
    super("audio", options);
    this._conn = conn;
  }

  protected override async _sendFrame(
    frame: Buffer,
    frametime: number,
  ): Promise<void> {
    this._conn.sendAudioFrame(frame, frametime);
  }
}
