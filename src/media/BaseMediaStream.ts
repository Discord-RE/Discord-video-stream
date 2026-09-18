import { Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { Log } from "debug-level";
import type { Packet } from "node-av";

export type BaseMediaStreamOptions = {
  noSleep?: boolean;
  livestreamCatchup?: boolean;
  /**
   * Backlog size (in frames) that triggers livestream catchup. Calibrated
   * at 30fps: the effective threshold scales with the measured frame rate
   * so it always represents the same media-time depth (~333ms by default).
   */
  catchupQueueThreshold?: number;
  /**
   * Catchup aggressiveness: each reference-interval (~33ms) of backlog
   * above the threshold adds roughly (1 - speedupFactor) speedup, so the
   * default 0.9 still nudges gently (~10%) on a one-frame excess but
   * reaches near-flat-out fast-forward once a few hundred ms pile up.
   * Explicitly set 0.97 for the older shallower ramp.
   */
  catchupSpeedupFactor?: number;
  /**
   * Floor for the catchup sleep multiplier, i.e. `1 - catchupMinFactor` is
   * the maximum speedup applied to deep backlogs. Lower = faster
   * fast-forward on multi-second gaps (never drops frames). Default 0.2
   * allows up to ~5x drain with minimum gaps (~7ms video / ~4ms audio)
   * that the event loop and the downstream RTP pacer sustain —
   * deliberately not flat-out: 1ms-gap micro-bursts cost more in loop /
   * pacer queueing delay than they save. Ramp stays proportional, so
   * small backlogs still converge gently. Set 0.85 for a 15% ceiling.
   */
  catchupMinFactor?: number;
};

// Frame interval the catchup options are calibrated against: the default
// threshold of 10 frames is ~333ms of backlog at 30fps, and the per-frame
// speedup factor is normalized the same way so behaviour stays constant
// across 15/30/60/120fps content.
const CATCHUP_REF_FRAMETIME_MS = 1000 / 30;

// Gentle per-frame warp for small A/V errors. Small steps converge
// smoothly; large steps inject visible jitter. Large behind-errors
// compress progressively (see below) so seconds-scale gaps still converge
// fast without ever dropping a frame.
const SYNC_MAX_WARP_FRACTION = 0.3;
// Absolute cap on a single sync stretch so a huge error can't park the
// stream. Large jumps are discontinuities (seek/loop) and handled by
// rebasing, not by waiting.
const SYNC_MAX_STRETCH_MS = 100;

// Systematic `setTimeout` lateness is learned and subtracted from the next
// sleep so sends land centered on the deadline with zero extra wakeups.
// Clamped: this only removes average bias, it never hurries a frame.
const TIMER_BIAS_MAX_MS = 3;

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

  // PTS-anchored timeline: deadline(frame) = t0 + (pts - p0), absolute
  // per frame — a late timer never shifts the next deadline, so pacing
  // errors stay bounded instead of accumulating, and intentional
  // deviations (sync/catchup trims) need no bookkeeping: they apply to
  // this frame only and are forgotten. Each stream owns its anchor; a
  // stream starting after its partner aligns to the partner's anchor
  // (see below), and the sync trim absorbs any residual skew.
  private _t0?: number;
  private _p0?: number;
  private _lastPts?: number;

  private _livestreamCatchup = false;
  private _catchupQueueThreshold!: number;
  private _catchupSpeedupFactor!: number;
  private _catchupMinFactor!: number;
  // Smoothed frame interval of the incoming content, seeded with the
  // reference ~33ms guess so call sites never deal with undefined.
  // Updated only from valid (> 0) samples, hence always > 0. Content
  // property, not timeline state, so it survives resetTimingState and
  // adapts within a few frames if the content changes.
  private _avgFrametime: number = CATCHUP_REF_FRAMETIME_MS;
  // EMA of measured send cost and of timer overshoot. Both center actual
  // send time on the deadline without extra wakeups.
  private _sendEmaMs = 0;
  private _timerBiasEmaMs = 0;

  constructor(type: string, options: BaseMediaStreamOptions = {}) {
    super({ objectMode: true, highWaterMark: 32 });
    this._loggerSend = new Log(`stream:${type}:send`);
    this._loggerSync = new Log(`stream:${type}:sync`);
    this._loggerSleep = new Log(`stream:${type}:sleep`);
    const {
      noSleep = false,
      livestreamCatchup = false,
      catchupQueueThreshold = 10,
      catchupSpeedupFactor = 0.9,
      catchupMinFactor = 0.2,
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
  // Media-time depth (ms) that triggers catchup. frame-count option ×
  // reference interval, so it is rate-independent.
  private get _catchupThresholdMs(): number {
    return this._catchupQueueThreshold * CATCHUP_REF_FRAMETIME_MS;
  }
  // Speedup per ms of excess backlog: one reference frametime (~33ms)
  // of excess applies (1 - speedupFactor), so the default 0.9 nudges
  // gently near the threshold and identically at any frame rate.
  private get _catchupGainPerMs(): number {
    return (1 - this._catchupSpeedupFactor) / CATCHUP_REF_FRAMETIME_MS;
  }
  private resetTimingState() {
    this._t0 = undefined;
    this._p0 = undefined;
    this._lastPts = undefined;
  }

  // A/V sync error: this frame's media elapsed minus the partner's last
  // *sent* elapsed. Last-sent on both sides keeps the comparison symmetric
  // across different frame cadences. undefined while the partner hasn't
  // started or has ended.
  private _syncErrorMs(ownPtsMs: number): number | undefined {
    const other = this._syncStream;
    if (!this._sync || other === undefined || other.writableEnded)
      return undefined;
    if (this._p0 === undefined || other._p0 === undefined) return undefined;
    if (other._lastPts === undefined || !Number.isFinite(other._lastPts))
      return undefined;
    return ownPtsMs - this._p0 - (other._lastPts - other._p0);
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
    if (Number.isFinite(frametime) && frametime > 0) {
      this._avgFrametime += 0.15 * (frametime - this._avgFrametime);
    }
    const ptsMs = (Number(pts) / timeBase.den) * timeBase.num * 1000;
    const timingValid =
      Number.isFinite(ptsMs) && Number.isFinite(frametime) && frametime > 0;

    // Copy out and release native memory before pacing: a frame can be
    // held for a full frametime before it is sent.
    const buf = Buffer.from(data);
    frame.free();

    const publish = (sentPts: number) => {
      this._pts = sentPts;
      this._lastPts = sentPts;
      this.emit("pts", sentPts);
    };

    const sendNow = async () => {
      const sendStart = performance.now();
      // NOTE: always the nominal frametime — pacing warp must never leak
      // into RTP timestamps. Every encoded frame is sent exactly once, in
      // order; dropping would break the inter-frame reference chain.
      await this._sendFrame(buf, frametime);
      const sendTime = performance.now() - sendStart;
      // EMA of non-negative samples seeded at 0 stays >= 0; clamp the top
      // so one slow frame can't bias pacing for long.
      this._sendEmaMs = Math.min(
        this._sendEmaMs + 0.1 * (sendTime - this._sendEmaMs),
        5,
      );
      if (timingValid && sendTime > frametime) {
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
    };

    if (this._noSleep || !timingValid) {
      // Burst mode (or untimed frame): drain as fast as frames arrive.
      // The paced timeline restarts from scratch when noSleep is turned
      // off (resetTimingState), so nothing is advanced or repaid here.
      await sendNow();
      if (timingValid) publish(ptsMs);
      callback(null);
      return;
    }

    const now0 = performance.now();

    // --- Anchor / discontinuity ---
    // First frame, or a seek/loop/wrap (PTS backward or far forward):
    // rebase the per-stream origin and wall anchor, then send
    // immediately. Rebasing only here — never on mere lateness —
    // keeps every frame deliverable: no drops, no bursts.
    if (this._t0 === undefined || this._p0 === undefined) {
      // Late joiner: the partner is already running, so align this
      // stream's origin to the partner's anchor instead of the epoch —
      // otherwise every frame would start minutes late. The partner's
      // anchor is untouched.
      const anchor = this._syncStream?._t0;
      this._t0 = now0;
      this._p0 = anchor === undefined ? ptsMs : ptsMs - (now0 - anchor);
      await sendNow();
      publish(ptsMs);
      callback(null);
      return;
    }
    const lastPts = this._lastPts;
    const avg = this._avgFrametime;
    const jumpLimit = Math.max(1000, avg * 10);
    if (
      lastPts !== undefined &&
      (ptsMs < lastPts || ptsMs - lastPts > jumpLimit)
    ) {
      this._loggerSync.debug(
        { stats: { pts: ptsMs, lastPts, jumpLimit } },
        "PTS discontinuity. Rebasing presentation timeline",
      );
      this._p0 = ptsMs;
      this._t0 = now0;
      await sendNow();
      publish(ptsMs);
      callback(null);
      return;
    }

    // --- Nominal deadline (absolute PTS anchor) ---
    const nominal = this._t0 + (ptsMs - this._p0);
    const sleep = nominal - now0 - this._sendEmaMs - this._timerBiasEmaMs;

    // --- A/V sync trim: deadbanded warp, gentle when close ---
    // Ahead → stretch (slow down), capped small so a far-ahead stream
    // never parks/freezes: convergence comes from the behind side
    // hurrying. Behind → compress (hurry) progressively, ~25% of the
    // error per frame, so large gaps converge fast as decoder-safe
    // fast-forward instead of hundreds of 30%-of-frametime steps.
    // Neither side ever skips a frame: the wait is only shortened,
    // never negative, preserving the inter-frame reference chain.
    let syncTrim = 0;
    const syncError = this._syncErrorMs(ptsMs);
    if (syncError !== undefined && Math.abs(syncError) > this._syncTolerance) {
      if (syncError > 0) {
        const cap = SYNC_MAX_WARP_FRACTION * frametime;
        syncTrim = Math.min(
          syncError - this._syncTolerance,
          cap,
          SYNC_MAX_STRETCH_MS,
        );
      } else {
        const behindExcess = -(syncError + this._syncTolerance);
        const want = Math.max(
          behindExcess * 0.25,
          SYNC_MAX_WARP_FRACTION * frametime,
        );
        // Ceil at 75% of this sleep: the wait stays non-negative (at most
        // ~4x fast-forward per frame) while keeping minimum gaps the
        // event loop sustains. When already late (sleep <= 0) there is
        // nothing to compress — sending ASAP is already the fastest
        // possible pace.
        const maxCompress = sleep > 0 ? 0.75 * sleep : 0;
        syncTrim = -Math.min(behindExcess, want, maxCompress);
      }
    }

    // --- Livestream catchup trim: queue-depth proportional speedup ---
    // backlogMs is media-time depth, so audio (20ms) and video (33ms)
    // behave identically. Pure P-controller: when the queue drains the
    // speedup vanishes by itself — nothing is accumulated or repaid,
    // because the nominal deadline is absolute.
    let catchupSaving = 0;
    if (this._livestreamCatchup && sleep > 0) {
      const backlogMs = this.writableLength * avg;
      const excess = backlogMs - this._catchupThresholdMs;
      if (excess > 0) {
        const u = Math.min(
          1 - this._catchupMinFactor,
          excess * this._catchupGainPerMs,
        );
        if (u > 0) catchupSaving = sleep * u;
      }
    }

    // Priority: draining beats aligning. Stretching (waiting longer)
    // while frames pile up — or while already late — only grows delay,
    // and the behind side's compress still converges alignment. So an
    // ahead-stream waits at most until its nominal deadline, never past
    // it, whenever there is backlog to drain or lateness to absorb.
    if (syncTrim > 0 && (catchupSaving > 0 || sleep - catchupSaving <= 0)) {
      syncTrim = 0;
    }

    const target =
      nominal -
      this._sendEmaMs -
      this._timerBiasEmaMs +
      syncTrim -
      catchupSaving;

    if (this._loggerSleep.enabled.trace) {
      this._loggerSleep.trace(
        {
          stats: {
            pts: ptsMs,
            nominal,
            sleep,
            syncError,
            syncTrim,
            catchupSaving,
            target,
            frametime,
          },
        },
        `Sleeping for ${Math.max(0, target - now0).toFixed(2)}ms`,
      );
    } else if (this._loggerSync.enabled.debug && syncTrim !== 0) {
      this._loggerSync.debug(
        { stats: { pts: ptsMs, syncError, syncTrim, frametime } },
        syncTrim > 0
          ? "Stream is ahead. Stretching sleep for this frame"
          : "Stream is behind. Compressing sleep for this frame",
      );
    } else if (this._loggerSleep.enabled.debug && catchupSaving > 0) {
      this._loggerSleep.debug(
        {
          stats: {
            pts: ptsMs,
            queueLength: this.writableLength,
            backlogMs: this.writableLength * avg,
            frametime,
            sleep,
            catchupSaving,
          },
        },
        `Livestream catchup: queue backed up. Sleeping for ${(sleep - catchupSaving).toFixed(2)}ms instead of ${sleep.toFixed(2)}ms`,
      );
    }

    // Exactly one timer per frame. Late (target <= now) → send
    // immediately; the next deadline is unaffected since it is
    // PTS-absolute, so lateness stays bounded per frame.
    const wait = target - performance.now();
    if (Number.isFinite(wait) && wait > 0) {
      await setTimeout(wait);
      const late = performance.now() - target;
      const sample = Math.min(Math.max(late, 0), 10);
      this._timerBiasEmaMs = Math.min(
        this._timerBiasEmaMs + 0.1 * (sample - this._timerBiasEmaMs),
        TIMER_BIAS_MAX_MS,
      );
    }

    await sendNow();
    publish(ptsMs);
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
