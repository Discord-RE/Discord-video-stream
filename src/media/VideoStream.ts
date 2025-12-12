import { BaseMediaStream } from "./BaseMediaStream.js";
import type { WebRtcConnWrapper } from "../client/voice/WebRtcWrapper.js";

export class VideoStream extends BaseMediaStream {
    private _conn: WebRtcConnWrapper
    constructor(conn: WebRtcConnWrapper, noSleep = false) {
        super("video", noSleep);
        this._conn = conn;
    }

    protected override async _sendFrame(frame: Buffer, frametime: number): Promise<void> {
        await this._conn.sendVideoFrame(frame, frametime);
    }
}
