export enum H264NalUnitTypes {
    Unspecified = 0,
    CodedSliceNonIDR = 1,
    CodedSlicePartitionA = 2,
    CodedSlicePartitionB = 3,
    CodedSlicePartitionC = 4,
    CodedSliceIdr = 5,
    SEI = 6,
    SPS = 7,
    PPS = 8,
    AccessUnitDelimiter = 9,
    EndOfSequence = 10,
    EndOfStream = 11,
    FillerData = 12,
    SEIExtenstion = 13,
    PrefixNalUnit = 14,
    SubsetSPS = 15,
}

export enum H265NalUnitTypes {
    TRAIL_N = 0,
    TRAIL_R = 1,
    TSA_N = 2,
    TSA_R = 3,
    STSA_N = 4,
    STSA_R = 5,
    RADL_N = 6,
    RADL_R = 7,
    RASL_N = 8,
    RASL_R = 9,
    RSV_VCL_N10 = 10,
    RSV_VCL_R11 = 11,
    RSV_VCL_N12 = 12,
    RSV_VCL_R13 = 13,
    RSV_VCL_N14 = 14,
    RSV_VCL_R15 = 15,
    BLA_W_LP = 16,
    BLA_W_RADL = 17,
    BLA_N_LP = 18,
    IDR_W_RADL = 19,
    IDR_N_LP = 20,
    CRA_NUT = 21,
    RSV_IRAP_VCL22 = 22,
    RSV_IRAP_VCL23 = 23,
    RSV_VCL24 = 24,
    RSV_VCL25 = 25,
    RSV_VCL26 = 26,
    RSV_VCL27 = 27,
    RSV_VCL28 = 28,
    RSV_VCL29 = 29,
    RSV_VCL30 = 30,
    RSV_VCL31 = 31,
    VPS_NUT = 32,
    SPS_NUT = 33,
    PPS_NUT = 34,
    AUD_NUT = 35,
    EOS_NUT = 36,
    EOB_NUT = 37,
    FD_NUT = 38,
    PREFIX_SEI_NUT = 39,
    SUFFIX_SEI_NUT = 40,
    RSV_NVCL41 = 41,
    RSV_NVCL42 = 42,
    RSV_NVCL43 = 43,
    RSV_NVCL44 = 44,
    RSV_NVCL45 = 45,
    RSV_NVCL46 = 46,
    RSV_NVCL47 = 47,
    UNSPEC48 = 48,
    UNSPEC49 = 49,
    UNSPEC50 = 50,
    UNSPEC51 = 51,
    UNSPEC52 = 52,
    UNSPEC53 = 53,
    UNSPEC54 = 54,
    UNSPEC55 = 55,
    UNSPEC56 = 56,
    UNSPEC57 = 57,
    UNSPEC58 = 58,
    UNSPEC59 = 59,
    UNSPEC60 = 60,
    UNSPEC61 = 61,
    UNSPEC62 = 62,
    UNSPEC63 = 63,
};

export interface AnnexBHelpers {
    getUnitType(frame: Buffer): number;
    splitHeader(frame: Buffer): [Buffer, Buffer];
    isAUD(unitType: number): boolean;
}

export const H264Helpers: AnnexBHelpers = {
    getUnitType(frame) {
        return frame[0] & 0x1f;
    },
    splitHeader(frame) {
        return [frame.subarray(0, 1), frame.subarray(1)];
    },
    isAUD(unitType) {
        return unitType === H264NalUnitTypes.AccessUnitDelimiter;
    }
}

export const H265Helpers: AnnexBHelpers = {
    getUnitType(frame) {
        return (frame[0] >> 1) & 0x3f;
    },
    splitHeader(frame) {
        return [frame.subarray(0, 2), frame.subarray(2)];
    },
    isAUD(unitType) {
        return unitType === H265NalUnitTypes.AUD_NUT;
    }
}

export const startCode3 = Buffer.from([0, 0, 1]);

export function splitNalu(buf: Buffer)
{
    let temp: Buffer | null = buf;
    const nalus: Buffer[] = [];
    while (temp?.byteLength)
    {
        let pos: number = temp.indexOf(startCode3);
        let length = 3;
        if (pos > 0 && temp[pos - 1] == 0)
        {
            pos--;
            length++;
        }
        const nalu = pos == -1 ? temp : temp.subarray(0, pos);
        temp = pos == -1 ? null : temp.subarray(pos + length);
        if (nalu.byteLength)
            nalus.push(nalu);
    }
    return nalus;
}
