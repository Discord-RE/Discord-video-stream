import { VoiceOpCodes } from "./VoiceOpCodes.js";
import { MediaUdp } from "./MediaUdp.js";
import {
    AES256TransportEncryptor,
    Chacha20TransportEncryptor,
    type TransportEncryptor
} from "../encryptor/TransportEncryptor.js";
import { STREAMS_SIMULCAST, SupportedEncryptionModes } from "../../utils.js";
import WebSocket from 'ws';
import EventEmitter from "node:events";
import type { Message, GatewayRequest, GatewayResponse } from "./VoiceMessageTypes.js";
import type { Streamer } from "../Streamer.js";

type VoiceConnectionStatus =
{
    hasSession: boolean;
    hasToken: boolean;
    started: boolean;
    resuming: boolean;
}

type WebRtcParameters = {
    address: string,
    port: number,
    audioSsrc: number,
    videoSsrc: number,
    rtxSsrc: number
    supportedEncryptionModes: SupportedEncryptionModes[]
}

type ValueOf<T> =
    T extends (infer U)[] ? U :
    T extends Record<string, infer U> ? U :
    never

export type VideoAttributes = {
    width: number,
    height: number,
    fps: number
}

export const CodecPayloadType = {
    "opus": {
        name: "opus", type: "audio", priority: 1000, payload_type: 120
    },
    "H264": {
        name: "H264", type: "video", priority: 1000, payload_type: 101, rtx_payload_type: 102, encode: true, decode: true
    },
    "H265": {
        name: "H265", type: "video", priority: 1000, payload_type: 103, rtx_payload_type: 104, encode: true, decode: true
    },
    "VP8": {
        name: "VP8", type: "video", priority: 1000, payload_type: 105, rtx_payload_type: 106, encode: true, decode: true
    },
    "VP9": {
        name: "VP9", type: "video", priority: 1000, payload_type: 107, rtx_payload_type: 108, encode: true, decode: true
    },
    "AV1": {
        name: "AV1", type: "video", priority: 1000, payload_type: 109, rtx_payload_type: 110, encode: true, decode: true
    }
} as const;

export abstract class BaseMediaConnection extends EventEmitter {
    private interval: NodeJS.Timeout | null = null;
    public udp: MediaUdp;
    public guildId: string | null = null;
    public channelId: string;
    public botId: string;
    public ws: WebSocket | null = null;
    public ready: (udp: MediaUdp) => void;
    public status: VoiceConnectionStatus;
    public server: string | null = null; //websocket url
    public token: string | null = null;
    public session_id: string | null = null;

    public webRtcParams: WebRtcParameters | null = null;
    private _streamer: Streamer;
    private _transportEncryptor?: TransportEncryptor;
    private _sequenceNumber = -1;

    constructor(
        streamer: Streamer,
        guildId: string | null,
        botId: string,
        channelId: string,
        callback: (udp: MediaUdp) => void
    ) {
        super();
        this._streamer = streamer;
        this.status = {
            hasSession: false,
            hasToken: false,
            started: false,
            resuming: false
        }

        // make udp client
        this.udp = new MediaUdp(this);

        this.guildId = guildId;
        this.channelId = channelId;
        this.botId = botId;
        this.ready = callback;
    }

    public abstract get serverId(): string | null;

    public get type(): "guild" | "call" {
        return this.guildId ? "guild" : "call";
    }

    public get transportEncryptor() {
        return this._transportEncryptor;
    }

    public get streamer() {
        return this._streamer;
    }

    stop(): void {
        this.interval && clearInterval(this.interval);
        this.status.started = false;
        this.ws?.close();
        this.udp?.stop();
    }

    setSession(session_id: string): void {
        this.session_id = session_id;

        this.status.hasSession = true;
        this.start();
    }
    
    setTokens(server: string, token: string): void {
        this.token = token;
        this.server = server;

        this.status.hasToken = true;
        this.start();
    }

    start(): void {
        /*
        ** Connection can only start once both
        ** session description and tokens have been gathered 
        */
        if (this.status.hasSession && this.status.hasToken) {
            if (this.status.started)
                return
            this.status.started = true;

            this.ws = new WebSocket(`wss://${this.server}/?v=8`, {
                followRedirects: true
            });
            this.ws.on("open", () => {
                if(this.status.resuming) {
                    this.status.resuming = false;
                    this.resume();
                } else {
                    this.identify();
                }
            })
            this.ws.on("error", (err) => {
                console.error(err);
            })
            this.ws.on("close", (code) => {
                const wasStarted = this.status.started;

                this.status.started = false;
                this.udp.ready = false;

                const canResume = code === 4_015 || code < 4_000;

                if (canResume && wasStarted) {
                    this.status.resuming = true;
                    this.start();
                }
            })
            this.setupEvents();
        }
    }

    handleReady(d: Message.Ready): void {
        // we hardcoded the STREAMS_SIMULCAST, which will always be array of 1
        const stream = d.streams[0];
        this.webRtcParams = {
            address: d.ip,
            port: d.port,
            audioSsrc: d.ssrc,
            videoSsrc: stream.ssrc,
            rtxSsrc: stream.rtx_ssrc,
            supportedEncryptionModes: d.modes
        }
    }

    handleProtocolAck(d: Message.SelectProtocolAck): void {
        const secretKey = Buffer.from(d.secret_key);
        switch (d.mode)
        {
            case SupportedEncryptionModes.AES256:
                this._transportEncryptor = new AES256TransportEncryptor(secretKey);
                break;
            case SupportedEncryptionModes.XCHACHA20:
                this._transportEncryptor = new Chacha20TransportEncryptor(secretKey);
                break;
        }
        this.emit("select_protocol_ack");
    }

    setupEvents(): void {
        this.ws?.on('message', (data, isBinary) => {
            if (isBinary)
                return;
            const { op, d, seq } = JSON.parse(data.toString()) as GatewayResponse;
            if (seq)
                this._sequenceNumber = seq;

            if (op === VoiceOpCodes.READY) { // ready
                this.handleReady(d);
                this.sendVoice().then(() => this.ready(this.udp));
                this.setVideoAttributes(false);
            }
            else if (op >= 4000) {
                console.error(`Error ${this.constructor.name} connection`, d);
            }
            else if (op === VoiceOpCodes.HELLO) {
                this.setupHeartbeat(d.heartbeat_interval);
            }
            else if (op === VoiceOpCodes.SELECT_PROTOCOL_ACK) { // session description
                this.handleProtocolAck(d);
            }
            else if (op === VoiceOpCodes.SPEAKING) {
                // ignore speaking updates
            }
            else if (op === VoiceOpCodes.HEARTBEAT_ACK) {
                // ignore heartbeat acknowledgements
            }
            else if (op === VoiceOpCodes.RESUMED) {
                this.status.started = true;
                this.udp.ready = true;
            }
            else {
                //console.log("unhandled voice event", {op, d});
            }
        });
    }

    setupHeartbeat(interval: number): void {
        if (this.interval) {
            clearInterval(this.interval);
        }
        this.interval = setInterval(() => {
            this.sendOpcode(VoiceOpCodes.HEARTBEAT, {
                t: Date.now(),
                seq_ack: this._sequenceNumber
            });
        }, interval);
    }

    sendOpcode<T extends GatewayRequest>(code: T["op"], data: T["d"]): void {
        this.ws?.send(JSON.stringify({
            op: code,
            d: data
        }));
    }

    /*
    ** identifies with media server with credentials
    */
    identify(): void {
        if (!this.serverId)
            throw new Error("Server ID is null or empty");
        if (!this.session_id)
            throw new Error("Session ID is null or empty");
        if (!this.token)
            throw new Error("Token is null or empty");
        this.sendOpcode(VoiceOpCodes.IDENTIFY, {
            server_id: this.serverId,
            user_id: this.botId,
            session_id: this.session_id,
            token: this.token,
            video: true,
            streams: STREAMS_SIMULCAST
        });
    }

    resume(): void {
        if (!this.serverId)
            throw new Error("Server ID is null or empty");
        if (!this.session_id)
            throw new Error("Session ID is null or empty");
        if (!this.token)
            throw new Error("Token is null or empty");
        this.sendOpcode(VoiceOpCodes.RESUME, {
            server_id: this.serverId,
            session_id: this.session_id,
            token: this.token,
            seq_ack: this._sequenceNumber
        });
    }

    /*
    ** Sets protocols and ip data used for video and audio.
    ** Uses vp8 for video
    ** Uses opus for audio
    */
    private setProtocols(): Promise<void> {
        const { ip, port } = this.udp;
        if (!ip || !port)
            throw new Error("IP or port is undefined (this shouldn't happen!!!)");
        // select encryption mode
        // From Discord docs: 
        // You must support aead_xchacha20_poly1305_rtpsize. You should prefer to use aead_aes256_gcm_rtpsize when it is available.
        let encryptionMode: SupportedEncryptionModes;
        if (!this.webRtcParams)
            throw new Error("WebRTC connection not ready");
        if (
            this.webRtcParams.supportedEncryptionModes.includes(SupportedEncryptionModes.AES256) &&
            !this._streamer.opts.forceChacha20Encryption
        ) {
            encryptionMode = SupportedEncryptionModes.AES256
        } else {
            encryptionMode = SupportedEncryptionModes.XCHACHA20
        }
        return new Promise((resolve) => {
            this.sendOpcode(VoiceOpCodes.SELECT_PROTOCOL, {
                protocol: "udp",
                codecs: Object.values(CodecPayloadType) as ValueOf<typeof CodecPayloadType>[],
                data: {
                    address: ip,
                    port: port,
                    mode: encryptionMode
                }
            });
            this.once("select_protocol_ack", () => resolve());
        })
    }

    /*
     * Sets video attributes (width, height, frame rate).
     * enabled -> video on or off
     * attr -> video attributes
     * video and rtx sources are set to ssrc + 1 and ssrc + 2
     */
    public setVideoAttributes(enabled: false): void
    public setVideoAttributes(enabled: true, attr: VideoAttributes): void
    public setVideoAttributes(enabled: boolean, attr?: VideoAttributes): void {
        if (!this.webRtcParams)
            throw new Error("WebRTC connection not ready");
        const { audioSsrc, videoSsrc, rtxSsrc } = this.webRtcParams;
        if (!enabled) {
            this.sendOpcode(VoiceOpCodes.VIDEO, {
                audio_ssrc: audioSsrc,
                video_ssrc: 0,
                rtx_ssrc: 0,
                streams: []
            })
        } else {
            if (!attr)
                throw new Error("Need to specify video attributes")
            this.sendOpcode(VoiceOpCodes.VIDEO, {
                audio_ssrc: audioSsrc,
                video_ssrc: videoSsrc,
                rtx_ssrc: rtxSsrc,
                streams: [
                    { 
                        type:"video",
                        rid:"100",
                        ssrc: videoSsrc,
                        active: true,
                        quality: 100,
                        rtx_ssrc: rtxSsrc,
                        // hardcode the max bitrate because we don't really know anyway
                        max_bitrate: 10000 * 1000,
                        max_framerate: enabled ? attr.fps : 0,
                        max_resolution: {
                            type: "fixed",
                            width: attr.width,
                            height: attr.height
                        }
                    }
                ]
            });
        }
    }

    /*
    ** Set speaking status
    ** speaking -> speaking status on or off
    */
    public setSpeaking(speaking: boolean): void {
        if (!this.webRtcParams)
            throw new Error("WebRTC connection not ready");
        this.sendOpcode(VoiceOpCodes.SPEAKING, {
            delay: 0,
            speaking: speaking ? 1 : 0,
            ssrc: this.webRtcParams.audioSsrc
        });
    }

    /*
    ** Start media connection
    */
    public sendVoice(): Promise<void> {
        return this.udp.createUdp().then(() => this.setProtocols());
    }
}