import { BaseMediaPacketizer } from "./BaseMediaPacketizer.js";
import { RtpPacket } from "werift-rtp";
import type { MediaStreamTrack } from "werift";
import type { BaseMediaConnection } from "../voice/BaseMediaConnection.js"

export class AudioPacketizer extends BaseMediaPacketizer {
    constructor(audioTrack: MediaStreamTrack, mediaConn: BaseMediaConnection) {
        super(audioTrack, mediaConn);
    }

    public override async sendFrame(frame: Buffer, frametime: number): Promise<void> {
        super.sendFrame(frame, frametime);
        const { daveReady, daveSession } = this._mediaConn;
        if (daveReady)
            frame = daveSession!.encryptOpus(frame);
        const packet = this.createPacket(frame);
        const bytesSent = this.sendPacket(packet);
        this.onFrameSent(bytesSent, frametime);
    }

    public createPacket(chunk: Buffer) {
        const header = this.makeRtpHeader();
        const packet = new RtpPacket(header, chunk)
        return packet;
    }

    public override async onFrameSent(bytesSent: number, frametime: number): Promise<void> {
        await super.onFrameSent(1, bytesSent, frametime);
        this.incrementTimestamp(frametime * (48000 / 1000));
    }
}