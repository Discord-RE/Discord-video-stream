import { RTCPeerConnection, RTCRtpCodecParameters, RTCRtpSender, MediaStream, MediaStreamTrack } from 'werift';
import { CodecPayloadType } from './BaseMediaConnection.js';
import { AudioPacketizer } from '../packet/AudioPacketizer.js';
import {
  VideoPacketizerH264,
  VideoPacketizerH265
} from '../packet/VideoPacketizerAnnexB.js';
import { VideoPacketizerVP8 } from '../packet/VideoPacketizerVP8.js';
import { normalizeVideoCodec } from '../../utils.js';
import type { BaseMediaPacketizer } from '../packet/BaseMediaPacketizer.js';
import type { BaseMediaConnection } from './BaseMediaConnection.js';

const rtpCodecParameters = Object.fromEntries(
  Object.entries(CodecPayloadType).map(([name, { clockRate, payload_type, type }]) => [
    name, new RTCRtpCodecParameters({
      mimeType: `${type}/${name}`,
      clockRate,
      payloadType: payload_type,
      channels: type === "audio" ? 2 : undefined
    })
  ])
) as Record<keyof typeof CodecPayloadType, RTCRtpCodecParameters>

export class WebRtcConnWrapper {
  private _webRtcConn;
  private _mediaConn: BaseMediaConnection;
  private _audioPacketizer?: BaseMediaPacketizer;
  private _videoPacketizer?: BaseMediaPacketizer;
  private _audioRtcRtpSender?: RTCRtpSender;
  private _videoRtcRtpSender?: RTCRtpSender;

  constructor(mediaConn: BaseMediaConnection) {
    this._mediaConn = mediaConn;
    this._webRtcConn = new RTCPeerConnection({
      codecs: {
        audio: Object.values(rtpCodecParameters)
          .filter(el => el.mimeType.startsWith("audio")),
        video: Object.values(rtpCodecParameters)
          .filter(el => el.mimeType.startsWith("video")),
      }
    });
  }

  public close() {
    this._webRtcConn.close();
  }

  public get webRtcConn() {
    return this._webRtcConn;
  }

  public get ready() {
    return this._webRtcConn.connectionState == "connected";
  }

  public get mediaConnection() {
    return this._mediaConn;
  }

  public async sendAudioFrame(frame: Buffer, frametime: number): Promise<void> {
    if (!this.ready) return;
    await this._audioPacketizer?.sendFrame(frame, frametime);
  }

  public async sendVideoFrame(frame: Buffer, frametime: number): Promise<void> {
    if (!this.ready) return;
    await this._videoPacketizer?.sendFrame(frame, frametime);
  }

  public setPacketizer(videoCodec: string): void {
    if (!this.mediaConnection.webRtcParams)
      throw new Error("WebRTC connection not ready");
    this._audioRtcRtpSender && this._webRtcConn.removeTrack(this._audioRtcRtpSender);
    this._videoRtcRtpSender && this._webRtcConn.removeTrack(this._videoRtcRtpSender);
    const { audioSsrc, videoSsrc } = this.mediaConnection.webRtcParams;
    const videoCodecNormalized = normalizeVideoCodec(videoCodec);
    const audioTrack = new MediaStreamTrack({
      kind: "audio",
      codec: rtpCodecParameters.opus,
      ssrc: audioSsrc
    })
    const videoTrack = new MediaStreamTrack({
      kind: "video",
      codec: rtpCodecParameters[videoCodecNormalized],
      ssrc: videoSsrc
    })
    const mediaStream = new MediaStream([ audioTrack, videoTrack ]);
    this._audioRtcRtpSender = this._webRtcConn.addTrack(audioTrack, mediaStream);
    this._videoRtcRtpSender = this._webRtcConn.addTrack(videoTrack, mediaStream);
    this._audioPacketizer = new AudioPacketizer(audioTrack, this._mediaConn);
    switch (normalizeVideoCodec(videoCodec)) {
      case "H264":
        this._videoPacketizer = new VideoPacketizerH264(videoTrack, this._mediaConn);
        break;
      case "H265":
        this._videoPacketizer = new VideoPacketizerH265(videoTrack, this._mediaConn);
        break;
      case "VP8":
        this._videoPacketizer = new VideoPacketizerVP8(videoTrack, this._mediaConn);
        break;
      default:
        throw new Error(`Packetizer not implemented for ${videoCodec}`)
    }
  }
}