import { Writable } from "node:stream";
import { setImmediate, setTimeout } from "node:timers/promises";
import { Log } from "debug-level";
import type { Packet } from "node-av";

export type BaseMediaStreamOptions = {
  noSleep?: boolean;
  livestreamCatchup?: boolean;
  catchupQueueThreshold?: number;
  catchupSpeedupFactor?: number;
  catchupMinFactor?: number;
};

// Width of the final-approach window handled by yield-spinning instead of
// a timer. A timer wake-up can land several ms late under event-loop load;
// aiming the coarse timer this far inside the deadline lets the spin phase
// absorb that latency instead of overshooting the target.
const SPIN_WINDOW_MS = 2;

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
  // Accumulated intentional pacing deviations (livestream catchup + A/V
  // sync). Applied additively to the virtual clock so skipped/shortened
  // sleeps are forgiven, not paid back as extra sleep on later frames.
  private _catchupOffset = 0;

  private _livestreamCatchup = false;
  private _catchupQueueThreshold!: number;
  private _catchupSpeedupFactor!: number;
  private _catchupMinFactor!: number;

  constructor(type: string, options: BaseMediaStreamOptions = {}) {
    super({ objectMode: true, highWaterMark: 32 });
    this._loggerSend = new Log(`stream:${type}:send`);
    this._loggerSync = new Log(`stream:${type}:sync`);
    this._loggerSleep = new Log(`stream:${type}:sleep`);
    const {
      noSleep = false,
      livestreamCatchup = false,
      catchupQueueThreshold = 10,
      catchupSpeedupFactor = 0.97,
      catchupMinFactor = 0.85,
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

  // Sleeps until the wall clock reaches `deadline` (performance.now() base).
  // Two phases: a single coarse timer wake-up that lands just inside the
  // spin window, then a bounded setImmediate-yield spin for the final
  // stretch. This gives sub-millisecond accuracy without a busy-blocked
  // event loop and without re-arming many timers.
  private async waitUntil(deadline: number): Promise<void> {
    for (;;) {
      const remaining = deadline - performance.now();
      if (!Number.isFinite(remaining) || remaining <= 0) return;
      if (remaining <= SPIN_WINDOW_MS) {
        // Yield-spin: setImmediate turns are sub-millisecond, so this
        // lands within microseconds of the deadline while still letting
        // the synced partner stream (and I/O) make progress.
        do {
          await setImmediate();
        } while (performance.now() < deadline);
        return;
      }
      // Coarse phase: re-arm one timer aimed inside the spin window, so
      // timer latency is absorbed by the spin instead of overshooting.
      await setTimeout(remaining - SPIN_WINDOW_MS);
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
    const frameSize = data.length;

    const sendStart = performance.now();
    await this._sendFrame(Buffer.from(data), frametime);
    // Release the packet's memory before pacing: a frame can be held for
    // a full frametime (or much longer while catching up) before callback.
    frame.free();

    const ptsMs = (Number(pts) / timeBase.den) * timeBase.num * 1000;
    this._pts = ptsMs;
    this.emit("pts", ptsMs);

    if (this._noSleep) {
      // Burst mode: drain frames as fast as they arrive. The paced
      // timeline restarts from scratch when noSleep is turned off
      // (resetTimingState), so nothing is advanced or repaid here.
      callback(null);
      return;
    }

    const sendTime = performance.now() - sendStart;

    // Send-overrun watchdog: sustained violations mean the frame budget
    // cannot be met, so the stream will drift behind permanently.
    if (sendTime > frametime) {
      this._frameSendDeadlineExceededCount++;
      if (this._frameSendDeadlineExceededCount > 10) {
        this._loggerSend.warn(
          {
            frame_size: frameSize,
            duration: sendTime,
            frametime,
          },
          `Frame takes too long to send (${((sendTime / frametime) * 100).toFixed(2)}% frametime)`,
        );
      }
    } else {
      this._frameSendDeadlineExceededCount = 0;
    }

    // --- Virtual clock ---
    // Each frame's deadline is the stream anchor plus accumulated media
    // time. Anchoring to a single start point (not to the previous send)
    // means one slow frame cannot shift the whole timeline, and pacing
    // self-corrects because the remaining wait is recomputed against the
    // wall clock every frame.
    if (this._streamStartTime === undefined) {
      this._streamStartTime = sendStart;
      this._virtualTime = frametime;
    } else {
      this._virtualTime = this._virtualTime! + frametime;
    }
    const deadline =
      this._streamStartTime + this._virtualTime + this._catchupOffset;
    const sleep = deadline - performance.now();

    // --- A/V sync: behind the partner, skip this frame's sleep ---
    if (this.sync && this.isBehind) {
      // Forgive the skipped sleep: the virtual clock already advanced for
      // this frame, so without this the skipped time would be repaid as
      // extra sleep on the next frame (skip + normal = oscillation).
      this._catchupOffset -= sleep;
      if (this._loggerSync.enabled.debug) {
        this._loggerSync.debug(
          {
            stats: {
              pts: ptsMs,
              pts_other: this.syncStream?.pts,
              frametime,
              skippedSleep: sleep,
            },
          },
          "Stream is behind. Not sleeping for this frame",
        );
      }
      callback(null);
      return;
    }

    // --- A/V sync: ahead of the partner, wait for it to catch up ---
    if (this.sync && this.isAhead) {
      if (this._loggerSync.enabled.debug) {
        this._loggerSync.debug(
          {
            stats: {
              pts: ptsMs,
              pts_other: this.syncStream?.pts,
              frametime,
            },
          },
          "Stream is ahead. Waiting for partner to catch up",
        );
      }
      // Absorb the whole backlog here in frametime-sized waits instead of
      // one frametime per piped frame. The loop exits early if the partner
      // ends or sync is toggled off.
      const waitStart = performance.now();
      do {
        await this.waitUntil(performance.now() + frametime);
      } while (this.sync && this.isAhead);
      // Forgive the difference between the computed sleep and the actual
      // wait — the wait was intentional slowdown, not debt to repay.
      this._catchupOffset += performance.now() - waitStart - sleep;
      callback(null);
      return;
    }

    // --- Livestream catchup: shrink the sleep while the queue is backed up ---
    let effectiveSleep = sleep;
    let effectiveDeadline = deadline;
    if (this._livestreamCatchup && sleep > 0) {
      const queueLength = this.writableLength;
      const excess = queueLength - this._catchupQueueThreshold;
      if (excess > 0) {
        const factor = Math.max(
          this._catchupMinFactor,
          this._catchupSpeedupFactor ** excess,
        );
        const saved = sleep * (1 - factor);
        if (saved > 0) {
          // Record the deviation so the base clock stays untouched.
          this._catchupOffset -= saved;
          effectiveSleep = sleep - saved;
          effectiveDeadline = deadline - saved;
          if (this._loggerSleep.enabled.debug) {
            this._loggerSleep.debug(
              {
                stats: {
                  pts: ptsMs,
                  queueLength,
                  excess,
                  factor,
                  frametime,
                  sleep,
                  effectiveSleep,
                  saved,
                },
              },
              `Livestream catchup: queue backed up (${queueLength} frames). Sleeping for ${effectiveSleep.toFixed(2)}ms instead of ${sleep.toFixed(2)}ms`,
            );
          }
        }
      }
    }

    if (this._loggerSleep.enabled.trace) {
      this._loggerSleep.trace(
        {
          stats: {
            pts: ptsMs,
            virtualTime: this._virtualTime,
            catchupOffset: this._catchupOffset,
            deadline,
            frametime,
            sleep,
            effectiveSleep,
          },
        },
        `Sleeping for ${effectiveSleep}ms`,
      );
    }

    await this.waitUntil(effectiveDeadline);
    callback(null);
  }

  _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    super._destroy(error, callback);
    this.syncStream = undefined;
  }
}
