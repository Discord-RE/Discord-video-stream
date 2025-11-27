import { max_int16bit } from "../../utils.js";
import { BaseMediaPacketizer } from "./BaseMediaPacketizer.js";
import { MediaType, Codec } from "@snazzah/davey";
import { RtpPacket } from "werift-rtp";
import type { MediaStreamTrack } from "werift";
import type { BaseMediaConnection } from "../voice/BaseMediaConnection.js";

/**
 * VP8 payload format
 * 
 */
export class VideoPacketizerVP8 extends BaseMediaPacketizer {
    private _pictureId: number;

    constructor(track: MediaStreamTrack, mediaConn: BaseMediaConnection) {
        super(track, mediaConn);
        this._pictureId = 0;
    }

    private incrementPictureId(): void {
        this._pictureId = (this._pictureId + 1) % max_int16bit;
    }

    public override async sendFrame(frame: Buffer, frametime: number): Promise<void> {
        super.sendFrame(frame, frametime);
        const { daveReady, daveSession } = this._mediaConn;
        if (daveReady)
            frame = daveSession!.encrypt(MediaType.VIDEO, Codec.VP8, frame);
        const data = this.partitionDataMTUSizedChunks(frame);

        let bytesSent = 0;
        for (let i = 0; i < data.length; i++)
        {
            const packet = this.createPacket(data[i], i === 0, i === data.length - 1);
            bytesSent += this.sendPacket(packet);
        }
        await this.onFrameSent(data.length, bytesSent, frametime);
    }

    public createPacket(chunk: Buffer, isFirstPacket = true, isLastPacket = true) {
        if (chunk.length > this.mtu) throw Error('error packetizing video frame: frame is larger than mtu');
        const header = this.makeRtpHeader(isLastPacket);
        const payload = this.makeChunk(chunk, isFirstPacket);
        return new RtpPacket(header, payload);
    }

    public override async onFrameSent(packetsSent: number, bytesSent: number, frametime: number): Promise<void> {
        await super.onFrameSent(packetsSent, bytesSent, frametime);
        // video RTP packet timestamp incremental value = 90,000Hz / fps
        this.incrementTimestamp(90000 / 1000 * frametime);
        this.incrementPictureId();
    }

    private makeChunk(frameData: Buffer, isFirstPacket: boolean): Buffer {
        // vp8 payload descriptor
        const payloadDescriptorBuf = Buffer.alloc(2);

        payloadDescriptorBuf[0] = 0x80;
        payloadDescriptorBuf[1] = 0x80;
        if (isFirstPacket) {
            payloadDescriptorBuf[0] |= 0b00010000; // mark S bit, indicates start of frame
        }

        // vp8 pictureid payload extension
        const pictureIdBuf = Buffer.alloc(2);

        pictureIdBuf.writeUIntBE(this._pictureId, 0, 2);
        pictureIdBuf[0] |= 0b10000000;

        return Buffer.concat([payloadDescriptorBuf, pictureIdBuf, frameData]);
    }
}
