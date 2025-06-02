import type { MediaUdp } from "../client/voice/MediaUdp.js";
import { BaseMediaStream } from "./BaseMediaStream.js";

export class AudioStream extends BaseMediaStream {
    public udp: MediaUdp;
    private _isMuted: boolean; // Internal state for muting

    constructor(udp: MediaUdp, noSleep = false, initialMuted: boolean = false) {
        super("audio", noSleep);
        this.udp = udp;
        this._isMuted = initialMuted; // Initialize mute state
    }

    /**
     * Mutes the audio stream. No audio frames will be sent.
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
            // If muted, just return without sending the frame
            return;
        }
        await this.udp.sendAudioFrame(frame, frametime);
    }
}
