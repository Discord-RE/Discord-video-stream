import type { VoiceOpCodes } from "./VoiceOpCodes.js"
import type { SupportedEncryptionModes } from "../../utils.js"

type StreamInfo = {
    active: boolean,
    quality: number,
    rid: string,
    ssrc: number,
    rtx_ssrc: number,
    /**
     * always "video" from what I observed
     */
    type: string
}

type SimulcastInfo = {
    type: string,
    rid: string,
    quality: number
}

type CodecPayloadType = {
    name: string,
    type: "audio",
    priority: number,
    payload_type: number
} | {
    name: string,
    type: "video",
    priority: number,
    payload_type: number,
    rtx_payload_type: number,
    encode: boolean,
    decode: boolean
}

export namespace Message {
    // Request messages
    export type Identify = {
        server_id: string,
        user_id: string,
        session_id: string,
        token: string,
        video: boolean,
        streams: SimulcastInfo[],
        max_dave_protocol_version?: number
    }

    export type Resume = {
        server_id: string,
        session_id: string,
        token: string,
        seq_ack: number
    }

    export type Heartbeat = {
        t: number,
        seq_ack?: number
    }

    export type SelectProtocol = {
        protocol: "udp",
        codecs: CodecPayloadType[],
        data: {
            address: string,
            port: number,
            mode: SupportedEncryptionModes
        }
    } | {
        protocol: "webrtc",
        codecs: CodecPayloadType[],
        data: string,
        sdp: string,
        rtc_connection_id: string
    }

    export type Video = {
        audio_ssrc: number,
        video_ssrc: number,
        rtx_ssrc: number,
        streams: {
            type: "video",
            rid: string,
            ssrc: number,
            active: boolean,
            quality: number,
            rtx_ssrc: number,
            max_bitrate: number,
            max_framerate: number,
            max_resolution: {
                type: "fixed",
                width: number,
                height: number
            }
        }[]
    }

    // Response messages
    export type Hello = {
        heartbeat_interval: number
    }

    export type Ready = {
        ssrc: number,
        ip: string,
        port: number,
        modes: SupportedEncryptionModes[],
        experiments: string[],
        streams: StreamInfo[]
    }

    export type Speaking = {
        speaking: 0 | 1 | 2,
        delay: number,
        ssrc: number
    }

    export type SelectProtocolAck = {
        audio_codec: string,
        video_codec: string,
        dave_protocol_version: number,
    } & ({
        secret_key: number[],
        mode: string,
    } | {
        media_session_id: number,
        sdp: string,
    })

    export type HeartbeatAck = {
        t: number
    }

    export type ClientsConnect = {
        user_ids: string[]
    }

    export type ClientDisconnect = {
        user_id: string
    }

    export type DavePrepareTransition = {
        transition_id: number,
        protocol_version: number
    }

    export type DaveExecuteTransition = {
        transition_id: number,
    }

    export type DaveTransitionReady = {
        transition_id: number
    }

    export type DavePrepareEpoch = {
        epoch: number
        protocol_version: number
    }

    export type MlsInvalidCommitWelcome = {
        transition_id: number
    }
}

export namespace GatewayResponse {
    type Generic<Op extends VoiceOpCodes, T extends Record<string, unknown> | null> = {
        op: Op,
        d: T,
        seq?: number
    }
    export type Hello = Generic<VoiceOpCodes.HELLO, Message.Hello>
    export type Ready = Generic<VoiceOpCodes.READY, Message.Ready>
    export type Resumed = Generic<VoiceOpCodes.RESUMED, null>
    export type Speaking = Generic<VoiceOpCodes.SPEAKING, Message.Speaking>
    export type SelectProtocolAck = Generic<VoiceOpCodes.SELECT_PROTOCOL_ACK, Message.SelectProtocolAck>
    export type HeartbeatAck = Generic<VoiceOpCodes.HEARTBEAT_ACK, Message.HeartbeatAck>
    export type ClientsConnect = Generic<VoiceOpCodes.CLIENTS_CONNECT, Message.ClientsConnect>
    export type ClientDisconnect = Generic<VoiceOpCodes.CLIENT_DISCONNECT, Message.ClientDisconnect>
    export type DavePrepareTransition = Generic<VoiceOpCodes.DAVE_PREPARE_TRANSITION, Message.DavePrepareTransition>
    export type DaveExecuteTransition = Generic<VoiceOpCodes.DAVE_EXECUTE_TRANSITION, Message.DaveExecuteTransition>
    export type DavePrepareEpoch = Generic<VoiceOpCodes.DAVE_PREPARE_EPOCH, Message.DavePrepareEpoch>
}

export type GatewayResponse =
    GatewayResponse.Hello |
    GatewayResponse.Ready |
    GatewayResponse.Resumed |
    GatewayResponse.Speaking |
    GatewayResponse.SelectProtocolAck |
    GatewayResponse.HeartbeatAck |
    GatewayResponse.ClientsConnect |
    GatewayResponse.ClientDisconnect |
    GatewayResponse.DavePrepareTransition |
    GatewayResponse.DaveExecuteTransition |
    GatewayResponse.DavePrepareEpoch

export namespace GatewayRequest {
    type Generic<Op extends VoiceOpCodes, T extends Record<string, unknown> | null> = {
        op: Op,
        d: T
    }
    export type Identify = Generic<VoiceOpCodes.IDENTIFY, Message.Identify>
    export type Resume = Generic<VoiceOpCodes.RESUME, Message.Resume>
    export type Heartbeat = Generic<VoiceOpCodes.HEARTBEAT, Message.Heartbeat>
    export type SelectProtocol = Generic<VoiceOpCodes.SELECT_PROTOCOL, Message.SelectProtocol>
    export type Video = Generic<VoiceOpCodes.VIDEO, Message.Video>
    export type Speaking = Generic<VoiceOpCodes.SPEAKING, Message.Speaking>
    export type DaveTransitionReady = Generic<VoiceOpCodes.DAVE_TRANSITION_READY, Message.DaveTransitionReady>
    export type MlsInvalidCommitWelcome = Generic<VoiceOpCodes.MLS_INVALID_COMMIT_WELCOME, Message.MlsInvalidCommitWelcome>
}

export type GatewayRequest =
    GatewayRequest.Identify |
    GatewayRequest.Resume |
    GatewayRequest.Heartbeat |
    GatewayRequest.SelectProtocol |
    GatewayRequest.Video |
    GatewayRequest.Speaking |
    GatewayRequest.DaveTransitionReady |
    GatewayRequest.MlsInvalidCommitWelcome
