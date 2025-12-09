export class AnnexBBitstreamReader {
  private _buffer: Buffer;
  private _byteOffset = 0;
  private _bitOffset = 0;

  constructor(buffer: Buffer) {
    this._buffer = buffer;
  }
  public readBits(count: number) {
    if (count == 0)
      return 0;
    let result = 0;
    while (count > 0)
    {
      if (this._byteOffset >= this._buffer.length)
        throw new Error("Bad byte offset")
      if (
        this._bitOffset == 0 && this._byteOffset >= 2
        && this._buffer[this._byteOffset - 2] == 0
        && this._buffer[this._byteOffset - 1] == 0
        && this._buffer[this._byteOffset]     == 3
      )
      {
        // Skip over emulation prevention
        this._byteOffset++;
      }
      if (this._bitOffset === 0 && count >= 8)
      {
        // We're byte aligned, read whole bytes and push in
        result = (result << 8) | this._buffer[this._byteOffset++];
        count -= 8;
      }
      else
      {
        // Read just enough to get us to the next byte
        const numBitsToRead = Math.min(count, 8 - this._bitOffset);
        const mask = (1 << numBitsToRead) - 1;
        const newBits = (this._buffer[this._byteOffset] >> (8 - this._bitOffset - numBitsToRead)) & mask;
        result = (result << numBitsToRead) | newBits;
        count -= numBitsToRead;
        this._bitOffset += numBitsToRead;
        if (this._bitOffset === 8)
        {
          this._bitOffset = 0;
          this._byteOffset++;
        }
      }
    }
    return result;
  }
  public readUnsigned(bits: number)
  {
    return this.readBits(bits);
  }
  public readSigned(bits: number)
  {
    const unsigned = this.readUnsigned(bits);
    if (unsigned & (1 << (bits - 1)))
      return unsigned - (1 << bits);
    return unsigned
  }
  public readUnsignedExpGolomb()
  {
    let leading0 = 0;
    while (this.readBits(1) == 0)
      leading0++;

    return (1 << leading0) + this.readBits(leading0) - 1;
  }
  public readSignedExpGolomb()
  {
    // Mapping: x <= 0 => -2x, x > 0 => 2x - 1
    const unsigned = this.readUnsignedExpGolomb();
    if (unsigned % 2 == 0)
      return unsigned / -2;
    return (unsigned + 1) / 2;
  }
}

export class AnnexBBitstreamWriter {
  private _arr: number[] = [];
  private _pendingByte = 0;
  private _bitOffset = 0;

  public toBuffer()
  {
    return Buffer.from(this._arr);
  }
  public flush()
  {
    // Write the pending byte into the array and reset, taking care of emulation prevention
    if (this._pendingByte <= 3 && this._arr.at(-1) == 0 && this._arr.at(-2) == 0)
      this._arr.push(3);
    this._arr.push(this._pendingByte);
    this._pendingByte = 0;
    this._bitOffset = 0;
  }
  public writeBits(bits: number, count: number) {
    while (count > 0)
    {
      if (this._bitOffset == 0)
      {
        if (count >= 8)
        {
          // We're byte aligned and has more than 1 byte left to write, write a whole byte
          this._pendingByte = (bits >> (count - 8)) & 0xFF;
          count -= 8;
          this.flush();
        }
        else
        {
          // We have less than 1 byte, write the rest in
          const mask = (1 << count) - 1;
          this._pendingByte |= (bits & mask) << (8 - count);
          this._bitOffset = count;
          count = 0;
        }
      }
      else
      {
        // Write the minimum number of bits to get us byte aligned again
        const numBitsToWrite = Math.min(8 - this._bitOffset, count)
        const bitsToWrite = (bits >> (count - numBitsToWrite)) & ((1 << numBitsToWrite) - 1);
        this._pendingByte |= bitsToWrite << (8 - this._bitOffset - numBitsToWrite);
        count -= numBitsToWrite;
        this._bitOffset += numBitsToWrite;
        if (this._bitOffset == 8)
        {
          this._bitOffset = 0;
          this.flush();
        }
      }
    }
  }
  public writeUnsigned(num: number, count: number)
  {
    if (num < 0)
      throw new Error("Expected a non-negative number");
    this.writeBits(num, count);
  }
  public writeSigned(num: number, count: number)
  {
    if (count <= 0) return;
    if (count > 32) throw new Error('writeSigned supports up to 32 bits');

    // Build mask for `count` bits. Handle 32-bit as a special case.
    const mask = count === 32 ? 0xFFFFFFFF >>> 0 : (((1 << count) >>> 0) - 1) >>> 0;

    // Convert to two's-complement unsigned representation and write
    const unsigned = (num & mask) >>> 0;
    this.writeBits(unsigned, count);
  }
  public writeUnsignedExpGolomb(num: number)
  {
    if (num < 0)
      throw new Error("Expected a non-negative number");
    num++;
    const bitCount = 32 - Math.clz32(num >>> 0);
    this.writeBits(0, bitCount - 1)
    this.writeBits(num, bitCount);
  }
  public writeSignedExpGolomb(num: number)
  {
    if (num < 0)
      this.writeUnsignedExpGolomb(-2 * num);
    else
      this.writeUnsignedExpGolomb(2 * num - 1);
  }
}
