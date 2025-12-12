import { VoiceOpCodes } from "../voice/VoiceOpCodes.js";
import { BaseMediaConnection } from "./BaseMediaConnection.js";

export class StreamConnection extends BaseMediaConnection
{
    private _streamKey: string | null = null;
    private _serverId: string | null = null;

    public override setSpeaking(speaking: boolean): void {
        if (!this.webRtcParams)
            throw new Error("WebRTC connection not ready");
        this.sendOpcode(VoiceOpCodes.SPEAKING, {
            delay: 0,
            speaking: speaking ? 2 : 0,
            ssrc: this.webRtcParams.audioSsrc
        });
    }

    public override get daveChannelId() {
        if (this._serverId === null)
            throw new Error("Server ID not set (this shouldn't happen)");
        const channelId = BigInt(this._serverId) - 1n;
        return channelId.toString();
    }

    public override get serverId(): string | null {
        return this._serverId;
    }

    public set serverId(id: string) {
        this._serverId = id;
    }

    public get streamKey(): string | null {
        return this._streamKey;
    }
    public set streamKey(value: string) {
        this._streamKey = value;
    }
}