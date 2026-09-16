import { Writable } from "node:stream";
import { setTimeout, setImmediate } from "node:timers/promises";
import { Log } from "debug-level";
import type { Packet } from "node-av";

export type BaseMediaStreamOptions = {
  noSleep?: boolean;
  livestreamCatchup?: boolean;
  catchupQueueThreshold?: number;
  catchupSpeedupFactor?: number;
  catchupMinFactor?: number;
};

const HIGH_PRECISION_THRESHOLD_MS = 2;

export class BaseMediaStream extends Writable {
  private _pts?: number;
  private _syncTolerance = 20;
  private _loggerSend: Log;
  private _loggerSync: Log;
  private _loggerSleep: Log;

  private _noSleep: boolean;
  private _sync = true;
  private _syncStream?: BaseMediaStream;
  private _frameSendDeadlineExceededCount = 0;

  private _streamStartTime?: number;
  private _virtualTime?: number;
  private _catchupOffset = 0;

  private _livestreamCatchup = false;
  private _catchupQueueThreshold = 10;
  private _catchupSpeedupFactor = 0.95;
  private _catchupMinFactor = 0.5;

  constructor(type: string, options: BaseMediaStreamOptions = {}) {
    super({ objectMode: true, highWaterMark: 32 });
    this._loggerSend = new Log(`stream:${type}:send`);
    this._loggerSync = new Log(`stream:${type}:sync`);
    this._loggerSleep = new Log(`stream:${type}:sleep`);
    const {
      noSleep = false,
      livestreamCatchup = false,
      catchupQueueThreshold = 10,
      catchupSpeedupFactor = 0.95,
      catchupMinFactor = 0.5,
    } = options;
    this._noSleep = noSleep;
    this._livestreamCatchup = livestreamCatchup;
    this.catchupQueueThreshold = catchupQueueThreshold;
    this.catchupSpeedupFactor = catchupSpeedupFactor;
    this.catchupMinFactor = catchupMinFactor;
  }

  get sync(): boolean {
    return this._sync;
  }
  set sync(val: boolean) {
    this._sync = val;
    if (val) this._loggerSync.debug("Sync enabled");
    else this._loggerSync.debug("Sync disabled");
  }
  get syncStream() {
    return this._syncStream;
  }
  set syncStream(stream: BaseMediaStream | undefined) {
    if (stream !== undefined && this === stream.syncStream)
      throw new Error("Cannot sync 2 streams with eachother");
    this._syncStream = stream;
  }
  get noSleep(): boolean {
    return this._noSleep;
  }
  set noSleep(val: boolean) {
    this._noSleep = val;
    if (!val) this.resetTimingState();
  }
  get pts(): number | undefined {
    return this._pts;
  }
  get syncTolerance() {
    return this._syncTolerance;
  }
  set syncTolerance(n: number) {
    if (n < 0) return;
    this._syncTolerance = n;
  }
  get livestreamCatchup(): boolean {
    return this._livestreamCatchup;
  }
  set livestreamCatchup(val: boolean) {
    this._livestreamCatchup = val;
  }
  get catchupQueueThreshold(): number {
    return this._catchupQueueThreshold;
  }
  set catchupQueueThreshold(n: number) {
    if (!Number.isFinite(n) || n < 0) return;
    this._catchupQueueThreshold = Math.floor(n);
  }
  get catchupSpeedupFactor(): number {
    return this._catchupSpeedupFactor;
  }
  set catchupSpeedupFactor(n: number) {
    if (!Number.isFinite(n) || n <= 0 || n >= 1) return;
    this._catchupSpeedupFactor = n;
  }
  get catchupMinFactor(): number {
    return this._catchupMinFactor;
  }
  set catchupMinFactor(n: number) {
    if (!Number.isFinite(n) || n <= 0 || n >= 1) return;
    this._catchupMinFactor = n;
  }
  protected async _sendFrame(
    _frame: Buffer,
    _frametime: number,
  ): Promise<void> {
    throw new Error("Not implemented");
  }
  private get ptsDelta() {
    if (this.pts !== undefined && this.syncStream?.pts !== undefined)
      return this.pts - this.syncStream.pts;
    return undefined;
  }
  private get isAhead() {
    const delta = this.ptsDelta;
    return (
      this.syncStream?.writableEnded === false &&
      delta !== undefined &&
      delta > this.syncTolerance
    );
  }
  private get isBehind() {
    const delta = this.ptsDelta;
    return (
      this.syncStream?.writableEnded === false &&
      delta !== undefined &&
      delta < -this.syncTolerance
    );
  }
  private resetTimingState() {
    this._streamStartTime = this._virtualTime = undefined;
    this._catchupOffset = 0;
  }

  private async precisionWait(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (ms < HIGH_PRECISION_THRESHOLD_MS) {
      const deadline = performance.now() + ms;
      while (performance.now() < deadline) {
        // Busy-wait: avoids ~1ms jitter from setTimeout resolution
        // Yields via setImmediate to avoid blocking the event loop
        await setImmediate();
      }
    } else {
      await setTimeout(ms);
    }
  }

  async _write(
    frame: Packet,
    _: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    const { data, pts, duration, timeBase } = frame;
    if (!data) {
      frame.free();
      callback();
      return;
    }

    const frametime = (Number(duration) / timeBase.den) * timeBase.num * 1000;

    const start = performance.now();
    await this._sendFrame(Buffer.from(data), frametime);
    const afterSend = performance.now();

    this._pts = (Number(pts) / timeBase.den) * timeBase.num * 1000;
    this.emit("pts", this._pts);

    const sendTime = afterSend - start;
    const ratio = sendTime / frametime;
    this._loggerSend.trace(
      {
        stats: {
          pts: this._pts,
          frame_size: data.length,
          duration: sendTime,
          frametime,
        },
      },
      `Frame sent in ${sendTime.toFixed(2)}ms (${(ratio * 100).toFixed(2)}% frametime)`,
    );
    if (ratio > 1) {
      this._frameSendDeadlineExceededCount++;
      if (this._frameSendDeadlineExceededCount > 10)
        this._loggerSend.warn(
          {
            frame_size: data.length,
            duration: sendTime,
            frametime,
          },
          `Frame takes too long to send (${(ratio * 100).toFixed(2)}% frametime)`,
        );
    } else {
      this._frameSendDeadlineExceededCount = 0;
    }

    // --- Timing ---
    let streamStart: number;
    let virtualTime: number;
    if (this._streamStartTime === undefined) {
      streamStart = this._streamStartTime = start;
      virtualTime = this._virtualTime = frametime;
    } else {
      streamStart = this._streamStartTime;
      virtualTime = this._virtualTime! + frametime;
      this._virtualTime = virtualTime;
    }

    // Apply accumulated catchup offset (additive, never mutates the base clock)
    const effectiveVirtualTime = virtualTime + this._catchupOffset;

    // Deadline = stream start + effective virtual time
    const frameDeadline = streamStart + effectiveVirtualTime;
    const now = performance.now();
    const sleep = Math.max(0, frameDeadline - now);

    // Sync: if behind the partner, skip sleep to catch up
    if (this.sync && this.isBehind) {
      this._loggerSync.debug(
        {
          stats: {
            pts: this.pts,
            pts_other: this.syncStream?.pts,
          },
        },
        "Stream is behind. Not sleeping for this frame",
      );
      callback(null);
      frame.free();
      return;
    }

    // Sync: if ahead of the partner, wait until caught up
    if (this.sync && this.isAhead) {
      this._loggerSync.debug(
        {
          stats: {
            pts: this.pts,
            pts_other: this.syncStream?.pts,
            frametime,
          },
        },
        `Stream is ahead. Waiting for partner to catch up`,
      );
      // Single precision wait instead of a loop — rechecked on next _write
      await this.precisionWait(frametime);
      callback(null);
      frame.free();
      return;
    }

    // Livestream catchup: reduce sleep when the queue is backed up
    let effectiveSleep = sleep;
    if (this._livestreamCatchup && sleep > 0) {
      const queueLength = this.writableLength;
      const excess = queueLength - this._catchupQueueThreshold;
      if (excess > 0) {
        const factor = Math.max(
          this._catchupMinFactor,
          this._catchupSpeedupFactor ** excess,
        );
        const adjusted = Math.max(0, sleep * factor);
        const saved = sleep - adjusted;
        if (saved > 0) {
          // Accumulate offset — the base clock stays untouched
          this._catchupOffset -= saved;
          this._loggerSleep.debug(
            {
              stats: {
                pts: this._pts,
                queueLength,
                excess,
                factor,
                sleep,
                effectiveSleep: adjusted,
                saved,
              },
            },
            `Livestream catchup: queue backed up (${queueLength} frames). Sleeping for ${adjusted.toFixed(2)}ms instead of ${sleep.toFixed(2)}ms`,
          );
        }
        effectiveSleep = adjusted;
      }
    }

    this._loggerSleep.trace(
      {
        stats: {
          pts: this._pts,
          virtualTime: this._virtualTime,
          catchupOffset: this._catchupOffset,
          frameDeadline,
          effectiveSleep,
        },
      },
      `Sleeping for ${effectiveSleep}ms`,
    );

    await this.precisionWait(effectiveSleep);
    callback(null);
    frame.free();
  }

  _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    super._destroy(error, callback);
    this.syncStream = undefined;
  }
}
