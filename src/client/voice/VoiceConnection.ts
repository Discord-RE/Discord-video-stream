import type { StreamConnection } from './StreamConnection.js';
import { BaseMediaConnection } from './BaseMediaConnection.js';

export class VoiceConnection extends BaseMediaConnection {
    public streamConnection?: StreamConnection;

    public override get serverId(): string {
        return this.guildId ?? this.channelId; // for guild vc it is the guild id, for dm voice it is the channel id
    }

    public override stop(): void {
        super.stop();
        this.streamConnection?.stop();
    }
}
