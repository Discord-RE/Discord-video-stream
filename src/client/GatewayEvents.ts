type GatewayEventGeneric<Type extends string = string, Data = unknown> = {
    t: Type,
    d: Data
}

export namespace GatewayEvent {
    export type VoiceStateUpdate = GatewayEventGeneric<
        "VOICE_STATE_UPDATE", {
            user_id: string,
            session_id: string
        }
    >
    export type VoiceServerUpdate = GatewayEventGeneric<
        "VOICE_SERVER_UPDATE", {
            guild_id: string,
            channel_id?: string,
            endpoint: string,
            token: string
        }
    >
    export type StreamCreate = GatewayEventGeneric<
        "STREAM_CREATE", {
            stream_key: string,
            rtc_server_id: string
        }
    >
    export type StreamServerUpdate = GatewayEventGeneric<
        "STREAM_SERVER_UPDATE", {
            stream_key: string,
            endpoint: string,
            token: string
        }
    >
}


export type GatewayEvent =
    GatewayEvent.VoiceStateUpdate |
    GatewayEvent.VoiceServerUpdate |
    GatewayEvent.StreamCreate |
    GatewayEvent.StreamServerUpdate
