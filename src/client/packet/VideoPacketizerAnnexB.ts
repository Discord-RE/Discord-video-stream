import type { MediaUdp } from "../voice/MediaUdp.js";
import { BaseMediaPacketizer } from "./BaseMediaPacketizer.js";
import {
    H264Helpers,
    H265Helpers,
    type AnnexBHelpers
} from "../processing/AnnexBHelper.js";
import { splitNalu } from "../processing/AnnexBHelper.js";
import { CodecPayloadType } from "../voice/BaseMediaConnection.js";

/**
 * Annex B format
 * 
 * Packetizer for Annex B NAL. This method does NOT support aggregation packets
 * where multiple NALs are sent as a single RTP payload. The supported payload
 * type is Single NAL Unit Packet and Fragmentation Unit A (FU-A). The headers
 * produced correspond to packetization-mode=1.

         RTP Payload Format for H.264 Video:
         https://tools.ietf.org/html/rfc6184

         RTP Payload Format for HEVC Video:
         https://tools.ietf.org/html/rfc7798
         
         FFmpeg H264/HEVC RTP packetisation code:
         https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/rtpenc_h264_hevc.c
         
         When the payload size is less than or equal to max RTP payload, send as 
         Single NAL Unit Packet:
         https://tools.ietf.org/html/rfc6184#section-5.6
         https://tools.ietf.org/html/rfc7798#section-4.4.1
         
         0                   1                   2                   3
         0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
         +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
         |F|NRI|  Type   |                                               |
         +-+-+-+-+-+-+-+-+                                               |
         |                                                               |
         |               Bytes 2..n of a single NAL unit                 |
         |                                                               |
         |                               +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
         |                               :...OPTIONAL RTP padding        |
         +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
         
         Type = 24 for STAP-A (NOTE: this is the type of the RTP header 
         and NOT the NAL type).
         
         When the payload size is greater than max RTP payload, send as 
         Fragmentation Unit A (FU-A):
         https://tools.ietf.org/html/rfc6184#section-5.8
              0                   1                   2                   3
         0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
         +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
         | FU indicator  |   FU header   |                               |
         +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
         |   Fragmentation Unit (FU) Payload
         |
         ...
 */
class VideoPacketizerAnnexB extends BaseMediaPacketizer {
    private _nalFunctions: AnnexBHelpers;

    constructor(connection: MediaUdp, ssrc: number, payloadType: number, nalFunctions: AnnexBHelpers) {
        super(connection, ssrc, payloadType, true);
        this._nalFunctions = nalFunctions;
    }

    /**
     * Sends packets after partitioning the video frame into
     * MTU-sized chunks
     * @param frame Annex B video frame
     */
    public override async sendFrame(frame: Buffer, frametime: number): Promise<void> {
        super.sendFrame(frame, frametime);

        const nalus = splitNalu(frame);

        let packetsSent = 0;
        let bytesSent = 0;
        let index = 0;
        for (const nalu of nalus) {
            const isLastNal = index === nalus.length - 1;
            if (nalu.length <= this.mtu) {
                // Send as Single NAL Unit Packet.
                const packetHeader = Buffer.concat([
                    this.makeRtpHeader(isLastNal), BaseMediaPacketizer.extensionHeader
                ]);

                const [ciphertext, nonceBuffer] = await this.encryptData(
                    Buffer.concat([...BaseMediaPacketizer.extensions, nalu]), packetHeader
                );
                const packet = Buffer.concat([
                    packetHeader, ciphertext,
                    nonceBuffer.subarray(0, 4),
                ]);
                this.mediaUdp.sendPacket(packet);
                packetsSent++;
                bytesSent += packet.length;
            } else {
                const [naluHeader, naluData] = this._nalFunctions.splitHeader(nalu);
                const data = this.partitionDataMTUSizedChunks(naluData);
                const encryptedPackets: Promise<Buffer>[] = [];

                // Send as Fragmentation Unit A (FU-A):
                for (let i = 0; i < data.length; i++) {
                    const isFirstPacket = i === 0;
                    const isFinalPacket = i === data.length - 1;

                    const markerBit = isLastNal && isFinalPacket;

                    const packetHeader = Buffer.concat([
                        this.makeRtpHeader(markerBit), BaseMediaPacketizer.extensionHeader
                    ]);

                    const packetData = Buffer.concat([
                        ...BaseMediaPacketizer.extensions,
                        this.makeFragmentationUnitHeader(
                            isFirstPacket,
                            isFinalPacket,
                            naluHeader
                        ),
                        data[i]
                    ]);

                    encryptedPackets.push(this.encryptData(packetData, packetHeader)
                        .then(([ciphertext, nonceBuffer]) => Buffer.concat([
                            packetHeader,
                            ciphertext,
                            nonceBuffer.subarray(0, 4),
                        ]))
                    );
                }

                for (const packet of await Promise.all(encryptedPackets))
                {
                    this.mediaUdp.sendPacket(packet);
                    packetsSent++;
                    bytesSent += packet.length;
                }
            }
            index++;
        }

        await this.onFrameSent(packetsSent, bytesSent, frametime);
    }

    protected makeFragmentationUnitHeader(isFirstPacket: boolean, isLastPacket: boolean, naluHeader: Buffer): Buffer {
        throw new Error("Not implemented");
    }

    public override async onFrameSent(packetsSent: number, bytesSent: number, frametime: number): Promise<void> {
        await super.onFrameSent(packetsSent, bytesSent, frametime);
        // video RTP packet timestamp incremental value = 90,000Hz / fps
        this.incrementTimestamp(90000 / 1000 * frametime);
    }
}

export class VideoPacketizerH264 extends VideoPacketizerAnnexB {
    constructor(connection: MediaUdp, ssrc: number) {
        super(connection, ssrc, CodecPayloadType.H264.payload_type, H264Helpers);
    }
    /**
     * The FU indicator octet has the following format:
        
            +---------------+
            |0|1|2|3|4|5|6|7|
            +-+-+-+-+-+-+-+-+
            |F|NRI|  Type   |
            +---------------+
            
            F and NRI bits come from the NAL being transmitted.
            Type = 28 for FU-A (NOTE: this is the type of the H264 RTP header 
            and NOT the NAL type).
            
            The FU header has the following format:
            
            +---------------+
            |0|1|2|3|4|5|6|7|
            +-+-+-+-+-+-+-+-+
            |S|E|R|  Type   |
            +---------------+
            
            S: Set to 1 for the start of the NAL FU (i.e. first packet in frame).
            E: Set to 1 for the end of the NAL FU (i.e. the last packet in the frame).
            R: Reserved bit must be 0.
            Type: The NAL unit payload type, comes from NAL packet (NOTE: this IS the type of the NAL message).
 * @param isFirstPacket 
 * @param isLastPacket 
 * @param naluHeader
 * @returns FU-A packets
 */
    protected override makeFragmentationUnitHeader(isFirstPacket: boolean, isLastPacket: boolean, naluHeader: Buffer): Buffer {
        const nal0 = naluHeader[0];
        const fuPayloadHeader = Buffer.alloc(2);
        const nalType = H264Helpers.getUnitType(naluHeader);
        const fnri = nal0 & 0xe0;

        // set fu indicator
        fuPayloadHeader[0] = 0x1c | fnri; // type 28 with fnri from original frame

        // set fu header
        if (isFirstPacket) {
            fuPayloadHeader[1] = 0x80 | nalType; // set start bit
        } else if (isLastPacket) {
            fuPayloadHeader[1] = 0x40 | nalType; // set last bit
        } else {
            fuPayloadHeader[1] = nalType; // no start or end bit
        }

        return fuPayloadHeader;
    }
}

export class VideoPacketizerH265 extends VideoPacketizerAnnexB {
    constructor(connection: MediaUdp, ssrc: number) {
        super(connection, ssrc, CodecPayloadType.H265.payload_type, H265Helpers);
    }
    /**
     * The FU indicator octet has the following format:

            +---------------+---------------+
            |0|1|2|3|4|5|6|7|0|1|2|3|4|5|6|7|
            +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
            |F|   Type    |  LayerId  | TID |
            +-------------+-----------------+
            
            All other fields except Type come from the NAL being transmitted.
            Type = 49 for FU-A (NOTE: this is the type of the H265 RTP header 
            and NOT the NAL type).
            
            The FU header has the following format:
            
            +---------------+
            |0|1|2|3|4|5|6|7|
            +-+-+-+-+-+-+-+-+
            |S|E|    Type   |
            +---------------+
            
            S: Set to 1 for the start of the NAL FU (i.e. first packet in frame).
            E: Set to 1 for the end of the NAL FU (i.e. the last packet in the frame).
            Type: The NAL unit payload type, comes from NAL packet (NOTE: this IS the type of the NAL message).
 * @param isFirstPacket 
 * @param isLastPacket 
 * @param naluHeader
 * @returns FU-A packets
 */
    protected override makeFragmentationUnitHeader(isFirstPacket: boolean, isLastPacket: boolean, naluHeader: Buffer): Buffer {
        const fuIndicatorHeader = Buffer.allocUnsafe(3);
        naluHeader.copy(fuIndicatorHeader);
        const nalType = H265Helpers.getUnitType(naluHeader);

        // clear NAL type and set it to 49
        fuIndicatorHeader[0] = (fuIndicatorHeader[0] & 0b10000001) | (49 << 1);

        // set fu header
        if (isFirstPacket) {
            fuIndicatorHeader[2] = 0x80 | nalType; // set start bit
        } else if (isLastPacket) {
            fuIndicatorHeader[2] = 0x40 | nalType; // set last bit
        } else {
            fuIndicatorHeader[2] = nalType; // no start or end bit
        }

        return fuIndicatorHeader;
    }
}
