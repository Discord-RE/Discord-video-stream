import { Log } from "debug-level";
import { VoiceOpCodes, VoiceOpCodesBinary } from "./VoiceOpCodes.js";
import { MediaUdp } from "./MediaUdp.js";
import {
    AES256TransportEncryptor,
    Chacha20TransportEncryptor,
    type TransportEncryptor
} from "../encryptor/TransportEncryptor.js";
import { STREAMS_SIMULCAST, SupportedEncryptionModes } from "../../utils.js";
import Davey from "@snazzah/davey"
import WebSocket from 'ws';
import EventEmitter from "node:events";
import type { Message, GatewayRequest, GatewayResponse } from "./VoiceMessageTypes.js";
import type { Streamer } from "../Streamer.js";

type VoiceConnectionStatus = {
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

    private _daveSession: Davey.DaveSession | undefined;
    private _connectedUsers = new Set<string>();
    private _daveProtocolVersion = 0;
    private _davePendingTransitions = new Map<number, number>();
    private _daveDowngraded = false;

    private _loggerDave = new Log("conn:dave");
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
                if (this.status.resuming) {
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
        switch (d.mode) {
            case SupportedEncryptionModes.AES256:
                this._transportEncryptor = new AES256TransportEncryptor(secretKey);
                break;
            case SupportedEncryptionModes.XCHACHA20:
                this._transportEncryptor = new Chacha20TransportEncryptor(secretKey);
                break;
        }
        this._daveProtocolVersion = d.dave_protocol_version;
        this.initDave();
        this.emit("select_protocol_ack");
    }

    initDave() {
        if (this._daveProtocolVersion) {
            if (this._daveSession)
                this._daveSession.reinit(this._daveProtocolVersion, this.botId, this.channelId);
            else
                this._daveSession = new Davey.DAVESession(this._daveProtocolVersion, this.botId, this.channelId);
            this.sendOpcodeBinary(VoiceOpCodesBinary.MLS_KEY_PACKAGE, this._daveSession.getSerializedKeyPackage());
        }
        else if (this._daveSession) {
            this._daveSession.reset();
            this._daveSession.setPassthroughMode(true, 10);
        }
    }

    processInvalidCommit(transitionId: number) {
        this._loggerDave.debug("Invalid commit received, reinitializing DAVE", { transitionId });
        this.sendOpcode(VoiceOpCodes.MLS_INVALID_COMMIT_WELCOME, { transition_id: transitionId });
        this.initDave();
    }

    executePendingTransition(transitionId: number) {
        const newVersion = this._davePendingTransitions.get(transitionId);
        if (newVersion === undefined) {
            this._loggerDave.error("Unrecognized transition ID", { transitionId });
            return;
        }
        const oldVersion = this._daveProtocolVersion;
        this._daveProtocolVersion = newVersion;

        if (oldVersion !== newVersion && newVersion === 0) {
            // Downgraded
            this._daveDowngraded = true;
            this._loggerDave.debug("Downgraded to non-E2E voice call");
        }
        else if (transitionId > 0 && this._daveDowngraded) {
            this._daveDowngraded = false;
            this._daveSession?.setPassthroughMode(true, 10);
            this._loggerDave.debug("Upgraded to E2E voice call");
        }

        this._davePendingTransitions.delete(transitionId);
        this._loggerDave.debug(`Pending transition ID ${transitionId} executed`, { transitionId });
    }

    setupEvents(): void {
        this.ws?.on('message', (data, isBinary) => {
            if (isBinary) {
                if (data instanceof ArrayBuffer)
                    this.handleBinaryMessages(Buffer.from(data))
                else if (Array.isArray(data))
                    this.handleBinaryMessages(Buffer.concat(data))
                return;
            }
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
            else if (op === VoiceOpCodes.CLIENTS_CONNECT) {
                d.user_ids.forEach(id => this._connectedUsers.add(id));
            }
            else if (op === VoiceOpCodes.CLIENT_DISCONNECT) {
                this._connectedUsers.delete(d.user_id)
            }
            else if (op === VoiceOpCodes.DAVE_PREPARE_TRANSITION) {
                this._loggerDave.debug("Preparing for DAVE transition", d);
                this._davePendingTransitions.set(d.transition_id, d.protocol_version);
                if (d.transition_id === 0) {
                    this.executePendingTransition(d.transition_id);
                }
                else {
                    if (d.protocol_version === 0)
                        this._daveSession?.setPassthroughMode(true, 120);
                    this.sendOpcode(VoiceOpCodes.DAVE_TRANSITION_READY, { transition_id: d.transition_id });
                }
            }
            else if (op === VoiceOpCodes.DAVE_EXECUTE_TRANSITION) {
                this.executePendingTransition(d.transition_id);
            }
            else if (op === VoiceOpCodes.DAVE_PREPARE_EPOCH) {
                this._loggerDave.debug("Preparing for DAVE epoch", d);
                if (d.epoch === 1) {
                    this._daveProtocolVersion = d.protocol_version;
                    this.initDave();
                }
            }
            else {
                //console.log("unhandled voice event", {op, d});
            }
        });
    }

    handleBinaryMessages(msg: Buffer) {
        this._sequenceNumber = msg.readUint16BE(0);
        const op = msg.readUint8(2);
        switch (op) {
            case VoiceOpCodesBinary.MLS_EXTERNAL_SENDER:
                {
                    this._daveSession?.setExternalSender(msg.subarray(3));
                    this._loggerDave.debug("Set MLS external sender");
                    break;
                }
            case VoiceOpCodesBinary.MLS_PROPOSALS:
                {
                    const optype = msg.readUint8(3);
                    const { commit, welcome } = this._daveSession!.processProposals(
                        optype, msg.subarray(4), [...this._connectedUsers]
                    );
                    if (commit) {
                        this.sendOpcodeBinary(
                            VoiceOpCodesBinary.MLS_COMMIT_WELCOME, welcome ? Buffer.concat([commit, welcome]) : commit
                        );
                    }
                    this._loggerDave.debug("Processed MLS proposal");
                    break;
                }
            case VoiceOpCodesBinary.MLS_ANNOUNCE_COMMIT_TRANSITION:
                {
                    const transitionId = msg.readUInt16BE(3);
                    try {
                        this._daveSession!.processCommit(msg.subarray(5));
                        if (transitionId) {
                            this._davePendingTransitions.set(transitionId, this._daveProtocolVersion);
                            this.sendOpcode(VoiceOpCodes.DAVE_TRANSITION_READY, { transition_id: transitionId });
                        }
                        this._loggerDave.debug("MLS commit processed", { transitionId });
                    }
                    catch (e) {
                        this._loggerDave.debug("MLS commit errored", e);
                        this.processInvalidCommit(transitionId);
                    }
                }
            case VoiceOpCodesBinary.MLS_WELCOME:
                {
                    const transitionId = msg.readUInt16BE(3);
                    try {
                        this._daveSession!.processWelcome(msg.subarray(5));
                        if (transitionId) {
                            this._davePendingTransitions.set(transitionId, this._daveProtocolVersion);
                            this.sendOpcode(VoiceOpCodes.DAVE_TRANSITION_READY, { transition_id: transitionId });
                        }
                        this._loggerDave.debug("MLS welcome processed", { transitionId });
                    }
                    catch (e) {
                        this._loggerDave.debug("MLS welcome errored", e);
                        this.processInvalidCommit(transitionId);
                    }
                }
        }
    }

    public get daveReady() {
        return this._daveProtocolVersion && this._daveSession?.ready
    }

    public get daveSession() {
        return this._daveSession;
    }

    setupHeartbeat(interval: number): void {
        if (this.interval) {
            clearInterval(this.interval);
        }
        this.interval = setInterval(() => {
            try {
                this.sendOpcode(VoiceOpCodes.HEARTBEAT, {
                    t: Date.now(),
                    seq_ack: this._sequenceNumber
                });
            }
            catch { }
        }, interval);
    }

    sendOpcode<T extends GatewayRequest>(code: T["op"], data: T["d"]): void {
        if (this.ws?.readyState !== WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify({
            op: code,
            d: data
        }));
    }
    sendOpcodeBinary(code: VoiceOpCodesBinary, data: Buffer) {
        if (this.ws?.readyState !== WebSocket.OPEN)
            return;
        const buf = Buffer.allocUnsafe(data.length + 1);
        buf.writeUInt8(code);
        data.copy(buf, 1);
        this.ws.send(buf);
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
            streams: STREAMS_SIMULCAST,
            max_dave_protocol_version: Davey.DAVE_PROTOCOL_VERSION ?? 0,
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
                        type: "video",
                        rid: "100",
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