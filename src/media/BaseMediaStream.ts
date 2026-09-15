import { Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { Log } from "debug-level";
import type { Packet } from "node-av";

export type BaseMediaStreamOptions = {
  noSleep?: boolean;
  livestreamCatchup?: boolean;
  catchupQueueThreshold?: number;
  catchupSpeedupFactor?: number;
};

export class BaseMediaStream extends Writable {
  private _pts?: number;
  private _syncTolerance = 20;
  private _loggerSend: Log;
  private _loggerSync: Log;
  private _loggerSleep: Log;

  private _noSleep: boolean;
  private _startTime?: number;
  private _startPts?: number;
  private _sync = true;
  private _syncStream?: BaseMediaStream;
  private _frameSendDeadlineExceededCount = 0;

  private _livestreamCatchup = false;
  private _catchupQueueThreshold = 10;
  private _catchupSpeedupFactor = 0.95;

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
    } = options;
    this._noSleep = noSleep;
    this._livestreamCatchup = livestreamCatchup;
    this.catchupQueueThreshold = catchupQueueThreshold;
    this.catchupSpeedupFactor = catchupSpeedupFactor;
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
    if (!val) this.resetTimingCompensation();
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
  /**
   * Number of buffered frames (including the frame currently being sent)
   * above which catchup pacing kicks in. See `livestreamCatchup`.
   */
  get catchupQueueThreshold(): number {
    return this._catchupQueueThreshold;
  }
  set catchupQueueThreshold(n: number) {
    if (!Number.isFinite(n) || n < 0) return;
    this._catchupQueueThreshold = Math.floor(n);
  }
  /**
   * Multiplier applied to the computed sleep time while catching up.
   * Must be in the exclusive range (0, 1). Smaller values catch up faster
   * but cause more noticeable pacing changes. Defaults to 0.95 (5% faster).
   */
  get catchupSpeedupFactor(): number {
    return this._catchupSpeedupFactor;
  }
  set catchupSpeedupFactor(n: number) {
    if (!Number.isFinite(n) || n <= 0 || n >= 1) return;
    this._catchupSpeedupFactor = n;
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
  private resetTimingCompensation() {
    this._startTime = this._startPts = undefined;
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

    const start_sendFrame = performance.now();
    await this._sendFrame(Buffer.from(data), frametime);
    const end_sendFrame = performance.now();

    this._pts = (Number(pts) / timeBase.den) * timeBase.num * 1000;
    this.emit("pts", this._pts);

    const sendTime = end_sendFrame - start_sendFrame;
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

    this._startTime ??= start_sendFrame;
    this._startPts ??= this._pts;
    const sleep = Math.max(
      0,
      this._pts -
        this._startPts +
        frametime -
        (end_sendFrame - this._startTime),
    );
    if (this._noSleep || sleep === 0) {
      callback(null);
    } else if (this.sync && this.isBehind) {
      this._loggerSync.debug(
        {
          stats: {
            pts: this.pts,
            pts_other: this.syncStream?.pts,
          },
        },
        "Stream is behind. Not sleeping for this frame",
      );
      this.resetTimingCompensation();
      callback(null);
    } else if (this.sync && this.isAhead) {
      do {
        this._loggerSync.debug(
          {
            stats: {
              pts: this.pts,
              pts_other: this.syncStream?.pts,
              frametime,
            },
          },
          `Stream is ahead. Waiting for ${frametime}ms`,
        );
        await setTimeout(frametime);
      } while (this.sync && this.isAhead);
      this.resetTimingCompensation();
      callback(null);
    } else {
      let effectiveSleep = sleep;
      if (this._livestreamCatchup && sleep > 0) {
        const queueLength = this.writableLength;
        if (queueLength > this._catchupQueueThreshold) {
          const adjusted = Math.max(0, sleep * this._catchupSpeedupFactor);
          const saved = sleep - adjusted;
          if (saved > 0) {
            // Shift the pacing anchor backwards so the time saved is not
            // given back on the next frame. This makes frame pacing run
            // slightly faster than realtime until the queue drains.
            if (this._startTime !== undefined) this._startTime -= saved;
            this._loggerSleep.debug(
              {
                stats: {
                  pts: this._pts,
                  queueLength,
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
            startPts: this._startPts,
            time: end_sendFrame,
            startTime: this._startTime,
            frametime,
          },
        },
        `Sleeping for ${effectiveSleep}ms`,
      );
      setTimeout(effectiveSleep).then(() => callback(null));
    }
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
