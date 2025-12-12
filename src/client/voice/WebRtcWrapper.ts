import {
  PeerConnection,
  Audio, Video,
  RtpPacketizer,
  H264RtpPacketizer,
  H265RtpPacketizer,
  AV1RtpPacketizer,
  RtpPacketizationConfig,
  RtcpNackResponder,
  RtcpSrReporter,
  type Track,
} from "node-datachannel";
import { Codec, MediaType } from "@snazzah/davey";
import { CodecPayloadType } from "./CodecPayloadType.js";
import { normalizeVideoCodec, type SupportedVideoCodec } from '../../utils.js';
import { splitNalu, H264Helpers, H264NalUnitTypes, startCode3 } from "../processing/AnnexBHelper.js";
import { rewriteSPSVUI } from "../processing/SPSVUIRewriter.js";
import type { BaseMediaConnection } from './BaseMediaConnection.js';

export class WebRtcConnWrapper {
  private _mediaConn: BaseMediaConnection;

  private _webRtcConn?: PeerConnection;
  private _audioDef: Audio;
  private _videoDef: Video;
  private _audioTrack?: Track;
  private _videoTrack?: Track;
  private _audioPacketizer?: RtpPacketizer;
  private _videoPacketizer?: RtpPacketizer;
  private _videoCodec?: SupportedVideoCodec;

  constructor(mediaConn: BaseMediaConnection) {
    this._mediaConn = mediaConn;
    this._audioDef = new Audio("0", "SendRecv");
    this._videoDef = new Video("1", "SendRecv");
    this._audioDef.addOpusCodec(CodecPayloadType.opus.payload_type);
    for (const { name, payload_type, rtx_payload_type, clockRate } of Object.values(CodecPayloadType).filter(el => el.type === "video")) {
      switch (name)
      {
        case "H264":
          this._videoDef.addH264Codec(payload_type);
          break;
        case "H265":
          this._videoDef.addH265Codec(payload_type);
          break;
        case "VP8":
          this._videoDef.addVP8Codec(payload_type);
          break;
        case "VP9":
          this._videoDef.addVP9Codec(payload_type);
          break;
        case "AV1":
          this._videoDef.addAV1Codec(payload_type);
          break;
      }
      this._videoDef.addRTXCodec(rtx_payload_type, payload_type, clockRate);
    }
  }

  public initWebRtc() {
    this._webRtcConn = new PeerConnection("", {
      iceServers: ['stun:stun.l.google.com:19302']
    });
    this._audioTrack = this._webRtcConn.addTrack(this._audioDef);
    this._videoTrack = this._webRtcConn.addTrack(this._videoDef);
    this._setMediaHandler();
    return this._webRtcConn;
  }

  private _setMediaHandler() {
    if (this._audioPacketizer)
      this._audioTrack?.setMediaHandler(this._audioPacketizer);
    if (this._videoPacketizer)
      this._videoTrack?.setMediaHandler(this._videoPacketizer);
  }

  public close() {
    this._webRtcConn?.close();
  }

  public get webRtcConn() {
    return this._webRtcConn;
  }

  public get ready() {
    return this._webRtcConn?.state() === "connected";
  }

  public get mediaConnection() {
    return this._mediaConn;
  }

  public sendAudioFrame(frame: Buffer, frametime: number) {
    if (!this.ready)
      return;
    if (!this._audioPacketizer)
      return;
    const { rtpConfig } = this._audioPacketizer;
    const { clockRate } = rtpConfig;
    if (this.mediaConnection.daveReady)
      frame = this.mediaConnection.daveSession!.encryptOpus(frame);
    this._audioTrack?.sendMessageBinary(frame);
    rtpConfig.timestamp += Math.round(frametime * clockRate / 1000);
  }

  public sendVideoFrame(frame: Buffer, frametime: number) {
    if (!this.ready)
      return;
    if (!this._videoPacketizer)
      return;
    const { rtpConfig } = this._videoPacketizer;
    const { clockRate } = rtpConfig;
    if (this._videoCodec == "H264")
    {
      let spsRewritten = false;
      const nalus = splitNalu(frame).map(el => {
        if (H264Helpers.getUnitType(el) === H264NalUnitTypes.SPS)
        {
          spsRewritten = true;
          return rewriteSPSVUI(el);
        }
        return el;
      });
      if (spsRewritten)
        frame = Buffer.concat(nalus.flatMap(el => [startCode3, el]));
    }
    if (this.mediaConnection.daveReady)
    {
      let daveCodec;
      switch (this._videoCodec)
      {
        case "H264":
          daveCodec = Codec.H264;
          break;
        case "H265":
          daveCodec = Codec.H265;
          break;
        case "VP8":
          daveCodec = Codec.VP8;
          break;
        case "VP9":
          daveCodec = Codec.VP9;
          break;
        case "AV1":
          daveCodec = Codec.AV1;
          break;
        default:
          daveCodec = Codec.UNKNOWN;
          break;
      }
      frame = this.mediaConnection.daveSession!.encrypt(MediaType.VIDEO, daveCodec, frame);
    }
    this._videoTrack?.sendMessageBinary(frame);
    rtpConfig.timestamp += Math.round(frametime * clockRate / 1000);
  }

  public setPacketizer(videoCodec: string): void {
    if (!this.mediaConnection.webRtcParams)
      throw new Error("WebRTC connection not ready");
    const { audioSsrc, videoSsrc } = this.mediaConnection.webRtcParams;
    const rtpConfigAudio = new RtpPacketizationConfig(
      audioSsrc, "", CodecPayloadType.opus.payload_type, CodecPayloadType.opus.clockRate
    );
    this._audioPacketizer = new RtpPacketizer(rtpConfigAudio);
    this._audioPacketizer.addToChain(new RtcpSrReporter(rtpConfigAudio));
    this._audioPacketizer.addToChain(new RtcpNackResponder());

    this._videoCodec = normalizeVideoCodec(videoCodec);
    const rtpConfigVideo = new RtpPacketizationConfig(
      videoSsrc, "",
      CodecPayloadType[this._videoCodec].payload_type,
      CodecPayloadType[this._videoCodec].clockRate,
    );

    switch (this._videoCodec)
    {
      case "H264":
        this._videoPacketizer = new H264RtpPacketizer("StartSequence", rtpConfigVideo);
        break;
      case "H265":
        this._videoPacketizer = new H265RtpPacketizer("StartSequence", rtpConfigVideo);
        break;
      case "AV1":
        this._videoPacketizer = new AV1RtpPacketizer("Obu", rtpConfigVideo);
        break;
      default:
        throw new Error(`Packetizer not implemented for ${this._videoCodec}`);
    }
    this._videoPacketizer.addToChain(new RtcpSrReporter(rtpConfigVideo));
    this._videoPacketizer.addToChain(new RtcpNackResponder());

    this._setMediaHandler();
  }
}