import { PeerConnection, Audio, Video, type Track } from "node-datachannel";
import { CodecPayloadType } from "./CodecPayloadType.js";
import { AudioPacketizer } from '../packet/AudioPacketizer.js';
import {
  VideoPacketizerH264,
  VideoPacketizerH265
} from '../packet/VideoPacketizerAnnexB.js';
import { VideoPacketizerVP8 } from '../packet/VideoPacketizerVP8.js';
import { normalizeVideoCodec } from '../../utils.js';
import type { BaseMediaPacketizer } from '../packet/BaseMediaPacketizer.js';
import type { BaseMediaConnection } from './BaseMediaConnection.js';

export class WebRtcConnWrapper {
  private _mediaConn: BaseMediaConnection;

  private _webRtcConn;
  private _audioDef: Audio;
  private _videoDef: Video;
  private _audioTrack: Track;
  private _videoTrack: Track;
  private _audioPacketizer?: BaseMediaPacketizer;
  private _videoPacketizer?: BaseMediaPacketizer;

  constructor(mediaConn: BaseMediaConnection) {
    this._mediaConn = mediaConn;
    this._webRtcConn = new PeerConnection("", {
      iceServers: ['stun:stun.l.google.com:19302']
    });
    this._audioDef = new Audio("0", "SendRecv");
    this._videoDef = new Video("1", "SendRecv");
    this._audioDef.addOpusCodec(CodecPayloadType.opus.payload_type);
    for (const { name, payload_type, rtx_payload_type, clockRate } of Object.values(CodecPayloadType).filter(el => el.type === "video")) {
      this._videoDef.addVideoCodec(payload_type, name);
      this._videoDef.addRTXCodec(rtx_payload_type, payload_type, clockRate);
    }
    this._audioTrack = this._webRtcConn.addTrack(this._audioDef);
    this._videoTrack = this._webRtcConn.addTrack(this._videoDef);
  }

  public close() {
    this._webRtcConn.close();
  }

  public get webRtcConn() {
    return this._webRtcConn;
  }

  public get ready() {
    return this._webRtcConn.state() === "connected";
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
    // This is only dependent on SSRC, so move this somewhere else
    const { audioSsrc, videoSsrc } = this.mediaConnection.webRtcParams;
    this._audioDef.addSSRC(audioSsrc);
    this._videoDef.addSSRC(videoSsrc);

    this._audioPacketizer = new AudioPacketizer({
      ssrc: audioSsrc, mediaConn: this.mediaConnection, track: this._audioTrack
    });
    const videoPacketizerParams = {
      ssrc: videoSsrc,
      mediaConn: this.mediaConnection,
      track: this._videoTrack
    }
    switch (normalizeVideoCodec(videoCodec)) {
      case "H264":
        this._videoPacketizer = new VideoPacketizerH264(videoPacketizerParams);
        break;
      case "H265":
        this._videoPacketizer = new VideoPacketizerH265(videoPacketizerParams);
        break;
      case "VP8":
        this._videoPacketizer = new VideoPacketizerVP8(videoPacketizerParams);
        break;
      default:
        throw new Error(`Packetizer not implemented for ${videoCodec}`)
    }
  }
}