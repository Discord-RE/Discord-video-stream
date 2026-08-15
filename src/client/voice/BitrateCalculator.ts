export class BitrateCalculator {
  private readonly _windowDurationMs: number;
  private readonly _samples: { timestampMs: number; bytes: number }[] = [];
  private _totalBytes = 0;

  constructor(windowDurationMs = 1000) {
    this._windowDurationMs = windowDurationMs;
  }

  public addSample(bytes: number): number {
    const now = Date.now();
    this._samples.push({ timestampMs: now, bytes });
    this._totalBytes += bytes;

    const cutoff = now - this._windowDurationMs;
    let expired = 0;
    while (
      expired < this._samples.length &&
      this._samples[expired].timestampMs < cutoff
    ) {
      this._totalBytes -= this._samples[expired].bytes;
      expired++;
    }
    if (expired > 0) this._samples.splice(0, expired);

    return this.calculateBitrate();
  }

  public calculateBitrate(): number {
    return (this._totalBytes * 8 * 1000) / this._windowDurationMs;
  }
}
