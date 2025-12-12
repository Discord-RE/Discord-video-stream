import { AnnexBBitstreamReader, AnnexBBitstreamWriter } from "./AnnexBBitstreamReaderWriter.js";

export function rewriteSPSVUI(buffer: Buffer)
{
  const reader = new AnnexBBitstreamReader(buffer.subarray(1));
  const writer = new AnnexBBitstreamWriter();

  const readBit = (n = 1) => reader.readBits(n);
  const writeBit = (v: number, n = 1) => writer.writeBits(v, n);
  const readU = (n: number) => reader.readUnsigned(n);
  const writeU = (v: number, n: number) => writer.writeUnsigned(v, n);
  const readUE = () => reader.readUnsignedExpGolomb();
  const writeUE = (v: number) => writer.writeUnsignedExpGolomb(v);
  const readSE = () => reader.readSignedExpGolomb();
  const writeSE = (v: number) => writer.writeSignedExpGolomb(v);

  // Rewrite the NAL header
  writeU(buffer[0], 8);

  const profile_idc = readU(8);
  writeU(profile_idc, 8);

  const constraint_flags = readU(8);
  writeU(constraint_flags, 8);

  const level_idc = readU(8);
  writeU(level_idc, 8);

  const seq_parameter_set_id = readUE();
  writeUE(seq_parameter_set_id);

  // If profile in high profiles, additional fields
  const highProfiles = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 144]);
  if (highProfiles.has(profile_idc)) {
    const chroma_format_idc = readUE();
    writeUE(chroma_format_idc);

    if (chroma_format_idc === 3) {
      const separate_colour_plane_flag = readBit(1);
      writeBit(separate_colour_plane_flag, 1);
    }

    const bit_depth_luma_minus8 = readUE();
    writeUE(bit_depth_luma_minus8);
    const bit_depth_chroma_minus8 = readUE();
    writeUE(bit_depth_chroma_minus8);

    const qpprime_y_zero_transform_bypass_flag = readBit(1);
    writeBit(qpprime_y_zero_transform_bypass_flag, 1);

    const seq_scaling_matrix_present_flag = readBit(1);
    writeBit(seq_scaling_matrix_present_flag, 1);
    if (seq_scaling_matrix_present_flag) {
      const scalingCount = chroma_format_idc !== 3 ? 8 : 12;
      for (let i = 0; i < scalingCount; i++) {
        const seq_scaling_list_present_flag = readBit(1);
        writeBit(seq_scaling_list_present_flag, 1);
        if (seq_scaling_list_present_flag) {
          const size = i < 6 ? 16 : 64;
          // scaling_list(size)
          let lastScale = 8;
          let nextScale = 8;
          for (let j = 0; j < size; j++) {
            const delta = readSE();
            writeSE(delta);
            nextScale = (lastScale + delta + 256) % 256;
            if (nextScale !== 0) lastScale = nextScale;
          }
        }
      }
    }
  }

  const log2_max_frame_num_minus4 = readUE();
  writeUE(log2_max_frame_num_minus4);

  const pic_order_cnt_type = readUE();
  writeUE(pic_order_cnt_type);
  if (pic_order_cnt_type === 0) {
    const log2_max_pic_order_cnt_lsb_minus4 = readUE();
    writeUE(log2_max_pic_order_cnt_lsb_minus4);
  } else if (pic_order_cnt_type === 1) {
    const delta_pic_order_always_zero_flag = readBit(1);
    writeBit(delta_pic_order_always_zero_flag, 1);
    const offset_for_non_ref_pic = readSE();
    writeSE(offset_for_non_ref_pic);
    const offset_for_top_to_bottom_field = readSE();
    writeSE(offset_for_top_to_bottom_field);
    const num_ref_frames_in_pic_order_cnt_cycle = readUE();
    writeUE(num_ref_frames_in_pic_order_cnt_cycle);
    for (let i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; i++) {
      const offset_for_ref_frame = readSE();
      writeSE(offset_for_ref_frame);
    }
  }

  const max_num_ref_frames = readUE();
  writeUE(max_num_ref_frames);

  const gaps_in_frame_num_value_allowed_flag = readBit(1);
  writeBit(gaps_in_frame_num_value_allowed_flag, 1);

  const pic_width_in_mbs_minus1 = readUE();
  writeUE(pic_width_in_mbs_minus1);

  const pic_height_in_map_units_minus1 = readUE();
  writeUE(pic_height_in_map_units_minus1);

  const frame_mbs_only_flag = readBit(1);
  writeBit(frame_mbs_only_flag, 1);
  if (frame_mbs_only_flag === 0) {
    const mb_adaptive_frame_field_flag = readBit(1);
    writeBit(mb_adaptive_frame_field_flag, 1);
  }

  const direct_8x8_inference_flag = readBit(1);
  writeBit(direct_8x8_inference_flag, 1);

  const frame_cropping_flag = readBit(1);
  writeBit(frame_cropping_flag, 1);
  if (frame_cropping_flag) {
    const frame_crop_left_offset = readUE();
    writeUE(frame_crop_left_offset);
    const frame_crop_right_offset = readUE();
    writeUE(frame_crop_right_offset);
    const frame_crop_top_offset = readUE();
    writeUE(frame_crop_top_offset);
    const frame_crop_bottom_offset = readUE();
    writeUE(frame_crop_bottom_offset);
  }

  // https://webrtc.googlesource.com/src/+/5f2c9278f35e47ff72eb191669d473b7400c9f3e/common_video/h264/sps_vui_rewriter.cc#283
  function addBitstreamRestriction()
  {
    // motion_vectors_over_pic_boundaries_flag: u(1)
    // Default is 1 when not present.
    writeBit(1, 1);
    // max_bytes_per_pic_denom: ue(v)
    // Default is 2 when not present.
    writeUE(2);
    // max_bits_per_mb_denom: ue(v)
    // Default is 1 when not present.
    writeUE(1);
    // log2_max_mv_length_horizontal: ue(v)
    // log2_max_mv_length_vertical: ue(v)
    // Both default to 16 when not present.
    writeUE(16);
    writeUE(16);
    // ********* IMPORTANT! **********
    // max_num_reorder_frames: ue(v)
    writeUE(0);
    // max_dec_frame_buffering: ue(v)
    writeUE(max_num_ref_frames);
  }

  const vui_parameters_present_flag = readBit(1);
  writeBit(1, 1);
  // If no VUI exists, write one
  if (!vui_parameters_present_flag) {
    // aspect_ratio_info_present_flag, overscan_info_present_flag. Both u(1).
    writeBit(0, 2);

    // video_signal_type_present_flag, u(1).
    // Just write 0 here because I'm not gonna bother myself with color space and whatnot
    writeBit(0, 1);

    // chroma_loc_info_present_flag, timing_info_present_flag,
    // nal_hrd_parameters_present_flag, vcl_hrd_parameters_present_flag,
    // pic_struct_present_flag, All u(1)
    writeBit(0, 5);

    // bitstream_restriction_flag: u(1)
    writeBit(1, 1);

    addBitstreamRestriction();
  }
  else {
    // VUI parsing and copying
    const aspect_ratio_info_present_flag = readBit(1);
    writeBit(aspect_ratio_info_present_flag, 1);
    if (aspect_ratio_info_present_flag) {
      const aspect_ratio_idc = readU(8);
      writeU(aspect_ratio_idc, 8);
      if (aspect_ratio_idc === 255) { // Extended_SAR
        const sar_width = readU(16);
        writeU(sar_width, 16);
        const sar_height = readU(16);
        writeU(sar_height, 16);
      }
    }

    const overscan_info_present_flag = readBit(1);
    writeBit(overscan_info_present_flag, 1);
    if (overscan_info_present_flag) {
      const overscan_appropriate_flag = readBit(1);
      writeBit(overscan_appropriate_flag, 1);
    }

    // Read the video signal type, but don't copy it
    const video_signal_type_present_flag = readBit(1);
    writeBit(0, 1);
    if (video_signal_type_present_flag) {
      const video_format = readBit(3);
      // writeBit(video_format, 3);
      const video_full_range_flag = readBit(1);
      // writeBit(video_full_range_flag, 1);
      const colour_description_present_flag = readBit(1);
      // writeBit(colour_description_present_flag, 1);
      if (colour_description_present_flag) {
        const colour_primaries = readU(8);
        // writeU(colour_primaries, 8);
        const transfer_characteristics = readU(8);
        // writeU(transfer_characteristics, 8);
        const matrix_coeffs = readU(8);
        // writeU(matrix_coeffs, 8);
      }
    }

    const chroma_loc_info_present_flag = readBit(1);
    writeBit(chroma_loc_info_present_flag, 1);
    if (chroma_loc_info_present_flag) {
      const chroma_sample_loc_type_top_field = readUE();
      writeUE(chroma_sample_loc_type_top_field);
      const chroma_sample_loc_type_bottom_field = readUE();
      writeUE(chroma_sample_loc_type_bottom_field);
    }

    const timing_info_present_flag = readBit(1);
    writeBit(timing_info_present_flag, 1);
    if (timing_info_present_flag) {
      const num_units_in_tick = readU(32);
      writeU(num_units_in_tick, 32);
      const time_scale = readU(32);
      writeU(time_scale, 32);
      const fixed_frame_rate_flag = readBit(1);
      writeBit(fixed_frame_rate_flag, 1);
    }

    const nal_hrd_parameters_present_flag = readBit(1);
    writeBit(nal_hrd_parameters_present_flag, 1);
    if (nal_hrd_parameters_present_flag) {
      // hrd_parameters()
      const cpb_cnt_minus1 = readUE();
      writeUE(cpb_cnt_minus1);
      const bit_rate_scale = readBit(4);
      writeBit(bit_rate_scale, 4);
      const cpb_size_scale = readBit(4);
      writeBit(cpb_size_scale, 4);
      for (let i = 0; i <= cpb_cnt_minus1; i++) {
        const bit_rate_value_minus1 = readUE();
        writeUE(bit_rate_value_minus1);
        const cpb_size_value_minus1 = readUE();
        writeUE(cpb_size_value_minus1);
        const cbr_flag = readBit(1);
        writeBit(cbr_flag, 1);
      }
      const initial_cpb_removal_delay_length_minus1 = readBit(5);
      writeBit(initial_cpb_removal_delay_length_minus1, 5);
      const cpb_removal_delay_length_minus1 = readBit(5);
      writeBit(cpb_removal_delay_length_minus1, 5);
      const dpb_output_delay_length_minus1 = readBit(5);
      writeBit(dpb_output_delay_length_minus1, 5);
      const time_offset_length = readBit(5);
      writeBit(time_offset_length, 5);
    }

    const vcl_hrd_parameters_present_flag = readBit(1);
    writeBit(vcl_hrd_parameters_present_flag, 1);
    if (vcl_hrd_parameters_present_flag) {
      // hrd_parameters()
      const cpb_cnt_minus1 = readUE();
      writeUE(cpb_cnt_minus1);
      const bit_rate_scale = readBit(4);
      writeBit(bit_rate_scale, 4);
      const cpb_size_scale = readBit(4);
      writeBit(cpb_size_scale, 4);
      for (let i = 0; i <= cpb_cnt_minus1; i++) {
        const bit_rate_value_minus1 = readUE();
        writeUE(bit_rate_value_minus1);
        const cpb_size_value_minus1 = readUE();
        writeUE(cpb_size_value_minus1);
        const cbr_flag = readBit(1);
        writeBit(cbr_flag, 1);
      }
      const initial_cpb_removal_delay_length_minus1 = readBit(5);
      writeBit(initial_cpb_removal_delay_length_minus1, 5);
      const cpb_removal_delay_length_minus1 = readBit(5);
      writeBit(cpb_removal_delay_length_minus1, 5);
      const dpb_output_delay_length_minus1 = readBit(5);
      writeBit(dpb_output_delay_length_minus1, 5);
      const time_offset_length = readBit(5);
      writeBit(time_offset_length, 5);
    }

    if (nal_hrd_parameters_present_flag || vcl_hrd_parameters_present_flag)
    {
      const low_delay_hrd_flag = readBit(1);
      writeBit(low_delay_hrd_flag, 1);
    }

    const pic_struct_present_flag = readBit(1);
    writeBit(pic_struct_present_flag, 1);

    const bitstream_restriction_flag = readBit(1);
    writeBit(1, 1);
    if (!bitstream_restriction_flag) {
      addBitstreamRestriction()
    }
    else {
      const motion_vectors_over_pic_boundaries_flag = readBit(1);
      writeBit(motion_vectors_over_pic_boundaries_flag, 1);
      const max_bytes_per_pic_denom = readUE();
      writeUE(max_bytes_per_pic_denom);
      const max_bits_per_mb_denom = readUE();
      writeUE(max_bits_per_mb_denom);
      const log2_max_mv_length_horizontal = readUE();
      writeUE(log2_max_mv_length_horizontal);
      const log2_max_mv_length_vertical = readUE();
      writeUE(log2_max_mv_length_vertical);
      const num_reorder_frames = readUE();
      writeUE(0);
      const max_dec_frame_buffering = readUE();
      writeUE(max_num_ref_frames);
    }
  }

  writeBit(1, 1); // rbsp_stop_one_bit
  writer.flush();
  // return the rewritten RBSP as a buffer
  return writer.toBuffer();
}
