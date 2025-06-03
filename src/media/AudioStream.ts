import type { MediaUdp } from "../client/index.js";
import { BaseMediaStream } from "./BaseMediaStream.js";

export class AudioStream extends BaseMediaStream {
    public udp: MediaUdp;
    private _isMuted = false;

    constructor(udp: MediaUdp, noSleep = false) {
        super("audio", noSleep);
        this.udp = udp;
    }

    /**
     * Mutes the audio stream. No audible audio frames will be sent, but empty frames will be sent for synchronization.
     */
    public mute(): void {
        this._isMuted = true;
    }

    /**
     * Unmutes the audio stream. Audio frames will resume sending.
     */
    public unmute(): void {
        this._isMuted = false;
    }

    /**
     * Checks if the audio stream is currently muted.
     * @returns True if muted, false otherwise.
     */
    public isMuted(): boolean {
        return this._isMuted;
    }

    protected override async _sendFrame(frame: Buffer, frametime: number): Promise<void> {
        if (this._isMuted) {
            // If muted, send an empty audio frame for synchronization.
            // The empty audio frame is 0xF8 0xFF 0xFE.
            const emptyFrame = Buffer.from([0xF8, 0xFF, 0xFE]);
            await this.udp.sendAudioFrame(emptyFrame, frametime);
            return;
        }
        await this.udp.sendAudioFrame(frame, frametime);
    }
}
