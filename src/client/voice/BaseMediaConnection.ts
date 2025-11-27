import Davey from "@snazzah/davey"
import EventEmitter from "node:events";
import WebSocket from 'ws';
import { Log } from "debug-level";
import { v4 as uuidv4 } from "uuid";
import { CodecPayloadType } from "./CodecPayloadType.js";
import { WebRtcConnWrapper } from "./WebRtcWrapper.js";
import { VoiceOpCodes, VoiceOpCodesBinary } from "./VoiceOpCodes.js";
import { STREAMS_SIMULCAST, SupportedEncryptionModes } from "../../utils.js";
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

export abstract class BaseMediaConnection extends EventEmitter {
    private interval: NodeJS.Timeout | null = null;
    public guildId: string | null = null;
    public channelId: string;
    public botId: string;
    public ws: WebSocket | null = null;
    public status: VoiceConnectionStatus;
    public server: string | null = null; //websocket url
    public token: string | null = null;
    public session_id: string | null = null;

    private _webRtcWrapper;
    private _webRtcParams: WebRtcParameters | null = null;
    public ready: (conn: WebRtcConnWrapper) => void;

    private _streamer: Streamer;
    private _sequenceNumber = -1;

    private _daveSession: Davey.DaveSession | undefined;
    private _connectedUsers = new Set<string>();
    private _daveProtocolVersion = 0;
    private _davePendingTransitions = new Map<number, number>();
    private _daveDowngraded = false;

    private _logger = new Log("conn");
    private _loggerDave = new Log("conn:dave");
    constructor(
        streamer: Streamer,
        guildId: string | null,
        botId: string,
        channelId: string,
        callback: (conn: WebRtcConnWrapper) => void
    ) {
        super();
        this._webRtcWrapper = new WebRtcConnWrapper(this);
        this._streamer = streamer;
        this.status = {
            hasSession: false,
            hasToken: false,
            started: false,
            resuming: false
        }

        this.guildId = guildId;
        this.channelId = channelId;
        this.botId = botId;
        this.ready = callback;
    }

    public abstract get serverId(): string | null;

    public get type(): "guild" | "call" {
        return this.guildId ? "guild" : "call";
    }

    public get webRtcConn() {
        return this._webRtcWrapper;
    }

    public get webRtcParams() {
        return this._webRtcParams;
    }

    public get streamer() {
        return this._streamer;
    }

    public abstract get daveChannelId(): string;

    stop(): void {
        this.ws?.close();
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

                this.interval && clearInterval(this.interval);
                this.status.started = false;
                this._webRtcWrapper?.close();

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
        this._webRtcParams = {
            address: d.ip,
            port: d.port,
            audioSsrc: d.ssrc,
            videoSsrc: stream.ssrc,
            rtxSsrc: stream.rtx_ssrc,
            supportedEncryptionModes: d.modes
        }
    }

    async handleProtocolAck(d: Message.SelectProtocolAck) {
        if (!("sdp" in d))
            throw new Error("Only WebRTC connections are allowed");
        this._daveProtocolVersion = d.dave_protocol_version;
        this.initDave();
        // Discord's SDP is absolute garbage...Generate one ourselves
        let ip, port, iceUsername, icePassword, fingerprint, candidate;
        for (const line of d.sdp.split("\n")) {
            if (line.startsWith("c="))
                ip = line;
            else if (line.startsWith("a=rtcp"))
                port = line.split(":")[1];
            else if (line.startsWith("a=ice-ufrag"))
                iceUsername = line;
            else if (line.startsWith("a=ice-pwd"))
                icePassword = line;
            else if (line.startsWith("a=fingerprint"))
                fingerprint = line;
            else if (line.startsWith("a=candidate"))
                candidate = line;
        }
        const audioPayloadType = CodecPayloadType.opus.payload_type;
        const audioSection = `
m=audio ${port} UDP/TLS/RTP/SAVPF ${audioPayloadType}
${ip}
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=setup:passive
a=mid:0
a=maxptime:60
a=inactive
${iceUsername}
${icePassword}
${fingerprint}
${candidate}
a=rtcp-mux
a=rtpmap:${audioPayloadType} opus/48000/2
a=fmtp:${audioPayloadType} minptime=10;useinbandfec=1;usedtx=1
a=rtcp-fb:${audioPayloadType} transport-cc
a=rtcp-fb:${audioPayloadType} nack
a=ice-lite
`.trim();
        const videoPayloads = Object.values(CodecPayloadType)
            .filter(el => el.type === "video")
        const videoPayloadTypes = videoPayloads.flatMap(el => [el.payload_type, el.rtx_payload_type]);
        const videoSection = `
m=video ${port} UDP/TLS/RTP/SAVPF ${videoPayloadTypes.join(" ")}
${ip}
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=extmap:14 urn:ietf:params:rtp-hdrext:toffset
a=extmap:13 urn:3gpp:video-orientation
a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay
a=setup:passive
a=mid:1
a=inactive
${iceUsername}
${icePassword}
${fingerprint}
${candidate}
a=rtcp-mux
a=ice-lite
`.trim();
        const videoRtpMap = videoPayloads.flatMap(el => [
            `a=rtpmap:${el.payload_type} ${el.name}/90000`,
            `a=rtpmap:${el.rtx_payload_type} rtx/90000`,
            `a=fmtp:${el.rtx_payload_type} apt=${el.payload_type}`,
            `a=rtcp-fb:${el.payload_type} ccm fir`,
            `a=rtcp-fb:${el.payload_type} nack`,
            `a=rtcp-fb:${el.payload_type} nack pli`,
            `a=rtcp-fb:${el.payload_type} goog-remb`,
            `a=rtcp-fb:${el.payload_type} transport-cc`
        ]).join('\n');
        await this._webRtcWrapper.webRtcConn.setRemoteDescription({
            sdp: [audioSection,videoSection,videoRtpMap].join("\n").replaceAll("\n", "\r\n"),
            type: "answer"
        });
        setInterval(async () => {
            console.log(await this._webRtcWrapper.webRtcConn.getStats())
        }, 1000);
        this.emit("select_protocol_ack");
    }

    initDave() {
        if (this._daveProtocolVersion) {
            if (this._daveSession) {
                this._daveSession.reinit(this._daveProtocolVersion, this.botId, this.daveChannelId);
                this._loggerDave.debug(`Reinitialized DAVE`, { user_id: this.botId, channel_id: this.daveChannelId });
            }
            else {
                this._daveSession = new Davey.DAVESession(this._daveProtocolVersion, this.botId, this.daveChannelId);
                this._loggerDave.debug(`Initialized DAVE`, { user_id: this.botId, channel_id: this.daveChannelId });
            }
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
                if (data instanceof Buffer)
                    this.handleBinaryMessages(data)
                else if (data instanceof ArrayBuffer)
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
                this.ready(this._webRtcWrapper);
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
        this._logger.trace(`Handling binary message with op ${op}`, { op })
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
                    break;
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
                    break;
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
    public async setProtocols(videoCodec: string): Promise<void> {
        // select encryption mode
        // From Discord docs: 
        // You must support aead_xchacha20_poly1305_rtpsize. You should prefer to use aead_aes256_gcm_rtpsize when it is available.
        // let encryptionMode: SupportedEncryptionModes;
        if (!this._webRtcParams)
            throw new Error("WebRTC parameters not set");
        // if (
        //     this._webRtcParams.supportedEncryptionModes.includes(SupportedEncryptionModes.AES256) &&
        //     !this._streamer.opts.forceChacha20Encryption
        // ) {
        //     encryptionMode = SupportedEncryptionModes.AES256
        // } else {
        //     encryptionMode = SupportedEncryptionModes.XCHACHA20
        // }
        const { webRtcConn } = this._webRtcWrapper;
        this._webRtcWrapper.setPacketizer(videoCodec);
        const offer = await webRtcConn.createOffer();
        await webRtcConn.setLocalDescription(offer);
        const sdp = offer.sdp.replaceAll("\r\n", "\n");
            const rtc_connection_id = uuidv4();
            this.sendOpcode(VoiceOpCodes.SELECT_PROTOCOL, {
                protocol: "webrtc",
                codecs: Object.values(CodecPayloadType) as ValueOf<typeof CodecPayloadType>[],
                data: sdp,
                sdp: sdp,
                rtc_connection_id
            });
        return new Promise((resolve) => {
            this.once("select_protocol_ack", () => resolve());
        });
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
        if (!this._webRtcParams)
            throw new Error("WebRTC parameters not set");
        const { audioSsrc, videoSsrc, rtxSsrc } = this._webRtcParams;
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
        if (!this._webRtcParams)
            throw new Error("WebRTC connection not ready");
        this.sendOpcode(VoiceOpCodes.SPEAKING, {
            delay: 0,
            speaking: speaking ? 1 : 0,
            ssrc: this._webRtcParams.audioSsrc
        });
    }
}
