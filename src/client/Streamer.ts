import { EventEmitter } from "node:events";
import { VoiceConnection } from "./voice/VoiceConnection.js";
import { StreamConnection } from "./voice/StreamConnection.js";
import { GatewayOpCodes } from "./GatewayOpCodes.js";
import type TypedEmitter from "typed-emitter";
import type { Client } from 'discord.js-selfbot-v13';
import type { MediaUdp } from "./voice/MediaUdp.js";
import type { StreamOptions } from "./voice/index.js";
import type { GatewayEvent } from "./GatewayEvents.js";

type EmitterEvents = {
    [K in GatewayEvent["t"]]: (data: Extract<GatewayEvent, { t: K }>["d"]) => void
}

export class Streamer {
    private _voiceConnection?: VoiceConnection;
    private _client: Client;
    private _gatewayEmitter = new EventEmitter() as TypedEmitter.default<EmitterEvents>

    constructor(client: Client) {
        this._client = client;

        //listen for messages
        this.client.on('raw', (packet: GatewayEvent) => {
            // @ts-expect-error I don't know how to make this work with TypeScript, so whatever
            this._gatewayEmitter.emit(packet.t, packet.d);
        });
    }

    public get client(): Client {
        return this._client;
    }

    public get voiceConnection(): VoiceConnection | undefined {
        return this._voiceConnection;
    }

    public sendOpcode(code: number, data: unknown): void {
        // @ts-expect-error Please make this public
        this.client.ws.broadcast({
            op: code,
            d: data,
        });
    }

    public joinVoice(guild_id: string, channel_id: string, options?: Partial<StreamOptions>): Promise<MediaUdp> {
        return new Promise<MediaUdp>((resolve, reject) => {
            if (!this.client.user) {
                reject("Client not logged in");
                return;
            }
            const user_id = this.client.user.id;
            const voiceConn = new VoiceConnection(
                guild_id,
                user_id,
                channel_id,
                options ?? {},
                (udp) => {
                    () => resolve(udp)
                }
            );
            this._voiceConnection = voiceConn;
            this._gatewayEmitter.on("VOICE_STATE_UPDATE", (d) => {
                if (user_id !== d.user_id) return;
                voiceConn.setSession(d.session_id);
            });
            this._gatewayEmitter.on("VOICE_SERVER_UPDATE", (d) => {
                if (guild_id !== d.guild_id) return;
                voiceConn.setTokens(d.endpoint, d.token);
            })
            this.signalVideo(false);
        });
    }

    public createStream(options?: Partial<StreamOptions>): Promise<MediaUdp> {
        return new Promise<MediaUdp>((resolve, reject) => {
            if (!this.client.user) {
                reject("Client not logged in");
                return;
            }
            if (!this.voiceConnection) {
                reject("cannot start stream without first joining voice channel");
                return;
            }

            this.signalStream();
            const {
                guildId: clientGuildId,
                channelId: clientChannelId,
                session_id
            } = this.voiceConnection;
            const {
                id: clientUserId
            } = this.client.user;

            if (!session_id)
                throw new Error("Session doesn't exist yet");
            const streamConn = new StreamConnection(
                clientGuildId,
                clientUserId,
                clientChannelId,
                options ?? {},
                (udp) => {
                    () => resolve(udp)
                }
            );
            this.voiceConnection.streamConnection = streamConn;
            this._gatewayEmitter.on("STREAM_CREATE", (d) => {
                const [type, guildId, channelId, userId] = d.stream_key.split(":");

                if (
                    clientGuildId !== guildId ||
                    clientChannelId !== channelId ||
                    clientUserId !== userId
                )
                    return;

                streamConn.serverId = d.rtc_server_id;
                streamConn.streamKey = d.stream_key;
                streamConn.setSession(session_id);
            });
            this._gatewayEmitter.on("STREAM_SERVER_UPDATE", (d) => {
                const [type, guildId, channelId, userId] = d.stream_key.split(":");

                if (
                    clientGuildId !== guildId ||
                    clientChannelId !== channelId ||
                    clientUserId !== userId
                )
                    return;

                streamConn.setTokens(d.endpoint, d.token);
            })
        });
    }

    public stopStream(): void {
        const stream = this.voiceConnection?.streamConnection;

        if (!stream) return;

        stream.stop();

        this.signalStopStream();

        this.voiceConnection.streamConnection = undefined;
        this._gatewayEmitter.removeAllListeners("STREAM_CREATE");
        this._gatewayEmitter.removeAllListeners("STREAM_SERVER_UPDATE");
    }

    public leaveVoice(): void {
        this.voiceConnection?.stop();

        this.signalLeaveVoice();

        this._voiceConnection = undefined;
        this._gatewayEmitter.removeAllListeners("VOICE_STATE_UPDATE");
        this._gatewayEmitter.removeAllListeners("VOICE_SERVER_UPDATE");
    }

    public signalVideo(video_enabled: boolean): void {
        if (!this.voiceConnection)
            return;
        const {
            guildId: guild_id,
            channelId: channel_id,
        } = this.voiceConnection;
        this.sendOpcode(GatewayOpCodes.VOICE_STATE_UPDATE, {
            guild_id,
            channel_id,
            self_mute: false,
            self_deaf: true,
            self_video: video_enabled,
        });
    }

    public signalStream(): void {
        if (!this.voiceConnection)
            return;
        const {
            guildId: guild_id,
            channelId: channel_id,
            botId: user_id
        } = this.voiceConnection;
        this.sendOpcode(GatewayOpCodes.STREAM_CREATE, {
            type: "guild",
            guild_id,
            channel_id,
            preferred_region: null,
        });

        this.sendOpcode(GatewayOpCodes.STREAM_SET_PAUSED, {
            stream_key: `guild:${guild_id}:${channel_id}:${user_id}`,
            paused: false,
        });
    }

    public signalStopStream(): void {
        if (!this.voiceConnection)
            return;
        const {
            guildId: guild_id,
            channelId: channel_id,
            botId: user_id
        } = this.voiceConnection;
        this.sendOpcode(GatewayOpCodes.STREAM_DELETE, {
            stream_key: `guild:${guild_id}:${channel_id}:${user_id}`
        });
    }

    public signalLeaveVoice(): void {
        this.sendOpcode(GatewayOpCodes.VOICE_STATE_UPDATE, {
            guild_id: null,
            channel_id: null,
            self_mute: true,
            self_deaf: false,
            self_video: false,
        });
    }
}
