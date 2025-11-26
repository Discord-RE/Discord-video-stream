import { Log } from "debug-level";
import { max_int16bit, max_int32bit } from "../../utils.js";
import { RtpHeader, Extension, RtpPacket, type MediaStreamTrack } from "werift";
import type { BaseMediaConnection } from "../voice/BaseMediaConnection.js";

const ntpEpoch = new Date("Jan 01 1900 GMT").getTime();

export class BaseMediaPacketizer {
    protected static extensions = [
        this.createPlayoutDelayExtPayload(0, 0)
    ];
    private _loggerRtcpSr = new Log("packetizer:rtcp-sr");

    private _mtu: number;
    private _sequence: number;
    private _timestamp: number;

    private _totalBytes: number;
    private _totalPackets: number;
    private _lastPacketTime: number;
    private _lastRtcpTime: number;
    private _currentMediaTimestamp: number;
    private _srInterval: number;

    protected _track: MediaStreamTrack;
    protected _mediaConn: BaseMediaConnection;

    constructor(track: MediaStreamTrack, mediaConn: BaseMediaConnection) {
        this._track = track;
        this._mediaConn = mediaConn;
        this._sequence = 0;
        this._timestamp = 0;
        this._totalBytes = 0;
        this._totalPackets = 0;
        this._lastPacketTime = 0;
        this._lastRtcpTime = 0;
        this._currentMediaTimestamp = 0;
        this._mtu = 1200;
        this._srInterval = 1000;
    }

    public get ssrc(): number | undefined {
        return this._track.ssrc
    }

    public set ssrc(value: number) {
        this._track.ssrc = value;
        this._totalBytes = this._totalPackets = 0;
    }

    /**
     * The interval between 2 consecutive RTCP Sender Report packets in ms
     */
    public get srInterval(): number {
        return this._srInterval;
    }

    public set srInterval(interval: number) {
        this._srInterval = interval;
    }

    public async sendFrame(frame: Buffer, frametime: number): Promise<void> {
        // override this
        this._lastPacketTime = Date.now();
    }

    public async onFrameSent(packetsSent: number, bytesSent: number, frametime: number): Promise<void> {

        if (this._mediaUdp.mediaConnection.streamer.opts.rtcpSenderReportEnabled) {
            this._totalPackets = this._totalPackets + packetsSent;
            this._totalBytes = (this._totalBytes + bytesSent) % max_int32bit;

            /**
             * Not using modulo here, since the timestamp might not be an exact
             * multiple of the interval
             */
            if (Math.floor(this._currentMediaTimestamp / this._srInterval) - Math.floor(this._lastRtcpTime / this._srInterval) > 0) {
                const senderReport = await this.makeRtcpSenderReport();
                this._mediaUdp.sendPacket(senderReport);
                this._lastRtcpTime = this._currentMediaTimestamp;
                this._loggerRtcpSr.debug({
                    stats: {
                        ssrc: this._ssrc,
                        timestamp: this._timestamp,
                        totalPackets: this._totalPackets,
                        totalBytes: this._totalBytes
                    }
                }, `Sent RTCP sender report for SSRC ${this._ssrc}`);
            }
        }
        this._currentMediaTimestamp += frametime;
    }

    protected sendPacket(packet: RtpPacket) {
        this._track.writeRtp(packet);
        return packet.serializeSize;
    }

    /**
     * Partitions a buffer into chunks of length this.mtu
     * @param data buffer to be partitioned
     * @returns array of chunks
     */
    public partitionDataMTUSizedChunks(data: Buffer): Buffer[] {
        let i = 0;
        let len = data.length;

        const out = [];

        while (len > 0) {
            const size = Math.min(len, this._mtu);
            out.push(data.subarray(i, i + size));
            len -= size;
            i += size;
        }

        return out;
    }

    public getNewSequence(): number {
        this._sequence = (this._sequence + 1) % max_int16bit;
        return this._sequence;
    }

    public incrementTimestamp(incrementBy: number): void {
        this._timestamp = (this._timestamp + incrementBy) % max_int32bit;
    }

    public makeRtpHeader(isLastPacket = true): RtpHeader {
        const header = new RtpHeader({
            extension: true,
            extensionLength: BaseMediaPacketizer.extensions.length,
            extensions: BaseMediaPacketizer.extensions,
            marker: isLastPacket,
            sequenceNumber: this.getNewSequence(),
            timestamp: Math.round(this._timestamp),
            ssrc: this.ssrc
        })
        return header;
    }

    public async makeRtcpSenderReport(): Promise<Buffer> {
        const packetHeader = Buffer.allocUnsafe(8);

        packetHeader[0] = 0x80; // RFC1889 v2, no padding, no reception report count
        packetHeader[1] = 0xc8; // Type: Sender Report (200)

        // Packet length (always 0x06 for some reason)
        packetHeader[2] = 0x00;
        packetHeader[3] = 0x06;
        packetHeader.writeUInt32BE(this._ssrc, 4);

        const senderReport = Buffer.allocUnsafe(20);

        // Convert from floating point to 32.32 fixed point
        // Convert each part separately to reduce precision loss
        const ntpTimestamp = (this._lastPacketTime - ntpEpoch) / 1000;
        const ntpTimestampMsw = Math.floor(ntpTimestamp);
        const ntpTimestampLsw = Math.round((ntpTimestamp - ntpTimestampMsw) * max_int32bit);

        senderReport.writeUInt32BE(ntpTimestampMsw, 0);
        senderReport.writeUInt32BE(ntpTimestampLsw, 4);
        senderReport.writeUInt32BE(Math.round(this._timestamp), 8);
        senderReport.writeUInt32BE(this._totalPackets % max_int32bit, 12);
        senderReport.writeUInt32BE(this._totalBytes, 16);

        const [ciphertext, nonceBuffer] = await this.encryptData(senderReport, packetHeader);
        return Buffer.concat([
            packetHeader, ciphertext,
            nonceBuffer.subarray(0, 4)
        ]);
    }

    /**
     * Create a playoutDelay extension payload
     * 
     * https://webrtc.googlesource.com/src/+/refs/heads/main/docs/native-code/rtp-hdrext/playout-delay
     */
    public static createPlayoutDelayExtPayload(min: number, max: number): Extension {
        /** Specific to type playout-delay
         *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3
            +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
            |       MIN delay       |       MAX delay       |
            +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
        */
        const data = Buffer.allocUnsafe(3);
        const delay = (min & 0xFFF) << 12 || (max & 0xFFF);
        data.writeUIntBE(delay, 0, 3);
        const ext: Extension = {
            id: 5,
            payload: data
        }

        return ext;
    }

    public get mtu(): number {
        return this._mtu;
    }
}