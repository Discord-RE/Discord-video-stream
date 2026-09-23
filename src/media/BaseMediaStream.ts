import { Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { Log } from "debug-level";
import type { Packet } from "node-av";

export type BaseMediaStreamOptions = {
  noSleep?: boolean;
  livestreamCatchup?: boolean;
  /**
   * Media-time backlog (ms) at which catchup engages. Once engaged it
   * stays engaged until the backlog drains to `catchupLowerBoundMs`
   * (hysteresis), so small transient queues never trigger speedup.
   */
  catchupUpperBoundMs?: number;
  /**
   * Media-time backlog (ms) at which an engaged catchup releases.
   * While engaged, the controller drives the backlog down to this
   * bound — the P-controller setpoint.
   */
  catchupLowerBoundMs?: number;
  /**
   * Catchup aggressiveness: each reference-interval (~33ms) of backlog
   * above the lower bound adds roughly (1 - speedupFactor) speedup, so
   * the default 0.9 still nudges gently on a small excess but reaches
   * near-flat-out fast-forward once a few hundred ms pile up.
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
  /**
   * Proportional gain for the slowdown side of the regulator: when the
   * queue falls below `catchupLowerBoundMs`, each frame is stretched by
   * `catchupSlowdownFactor × deficit` ms (capped at the lower bound) so
   * input refills the queue. Settles near factor/(1+factor) of the
   * bound (0.5 → ~67ms with the 200ms default); higher gains regulate
   * tighter toward the bound. Unlike the other factors this is a gain,
   * not a fraction — any finite value > 0 is accepted.
   */
  catchupSlowdownFactor?: number;
};

// Reference frame interval (~33ms @ 30fps) for catchup tuning.
const CATCHUP_REF_FRAMETIME_MS = 1000 / 30;

// Defaults for catchup tuning — field initializers and constructor fallbacks.
// Invalid values are rejected by the validating setters (RangeError).
const DEFAULT_CATCHUP = {
  upperBoundMs: 1000,
  lowerBoundMs: 200,
  speedupFactor: 0.9,
  minFactor: 0.2,
  slowdownFactor: 0.5,
};

// Per-frame warp for small A/V errors. Small steps converge smoothly;
// large behind-errors compress progressively (see below) so seconds-scale
// gaps converge fast without dropping frames.
const SYNC_MAX_WARP_FRACTION = 0.3;
// Hard cap on a single sync stretch — large jumps are discontinuities
// (seek/loop) and handled by rebasing, not waiting.
const SYNC_MAX_STRETCH_MS = 100;

// Learned setTimeout bias, subtracted from next sleep so sends land
// centered on the deadline. Clamped: removes average bias only, never
// hurries a frame.
const TIMER_BIAS_MAX_MS = 3;

function assertBound(name: string, n: number): void {
  if (!Number.isFinite(n) || n < 0)
    throw new RangeError(`${name} must be a finite number >= 0, got ${n}`);
}

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
  // errors stay bounded. Each stream owns its anchor; a late-joining
  // stream aligns to the partner's anchor, and the sync trim absorbs
  // any residual skew.
  private _t0?: number;
  private _p0?: number;

  private _livestreamCatchup = false;
  private _catchupUpperBoundMs: number = DEFAULT_CATCHUP.upperBoundMs;
  private _catchupLowerBoundMs: number = DEFAULT_CATCHUP.lowerBoundMs;
  // Schmitt latch: engaged at >= upper, released at <= lower, held in
  // between — prevents on/off chatter around a single threshold.
  private _catchupEngaged = false;
  private _catchupSpeedupFactor: number = DEFAULT_CATCHUP.speedupFactor;
  private _catchupMinFactor: number = DEFAULT_CATCHUP.minFactor;
  private _catchupSlowdownFactor: number = DEFAULT_CATCHUP.slowdownFactor;
  // Smoothed frame interval (ms), seeded ~33ms so call sites never deal
  // with undefined. Survives resetTimingState; adapts within a few frames
  // if content changes.
  private _avgFrametime: number = CATCHUP_REF_FRAMETIME_MS;
  // EMAs of send cost and timer overshoot, used to center sends on the
  // deadline without extra wakeups.
  private _sendEmaMs = 0;
  private _timerBiasEmaMs = 0;

  constructor(type: string, options: BaseMediaStreamOptions = {}) {
    super({ objectMode: true, highWaterMark: 128 });
    this._loggerSend = new Log(`stream:${type}:send`);
    this._loggerSync = new Log(`stream:${type}:sync`);
    this._loggerSleep = new Log(`stream:${type}:sleep`);
    const {
      noSleep = false,
      livestreamCatchup = false,
      catchupUpperBoundMs = DEFAULT_CATCHUP.upperBoundMs,
      catchupLowerBoundMs = DEFAULT_CATCHUP.lowerBoundMs,
      catchupSpeedupFactor = DEFAULT_CATCHUP.speedupFactor,
      catchupMinFactor = DEFAULT_CATCHUP.minFactor,
      catchupSlowdownFactor = DEFAULT_CATCHUP.slowdownFactor,
    } = options;
    this._noSleep = noSleep;
    this._livestreamCatchup = livestreamCatchup;
    // Bounds: validate individually, cross-check as a pair, then assign
    // directly — going through the setters first would compare each
    // bound against the other's default and reject valid pairs.
    assertBound("catchupUpperBoundMs", catchupUpperBoundMs);
    assertBound("catchupLowerBoundMs", catchupLowerBoundMs);
    if (catchupLowerBoundMs > catchupUpperBoundMs)
      throw new RangeError(
        `catchupLowerBoundMs (${catchupLowerBoundMs}) must be <= catchupUpperBoundMs (${catchupUpperBoundMs})`,
      );
    this._catchupUpperBoundMs = catchupUpperBoundMs;
    this._catchupLowerBoundMs = catchupLowerBoundMs;
    this.catchupSpeedupFactor = catchupSpeedupFactor;
    this.catchupMinFactor = catchupMinFactor;
    this.catchupSlowdownFactor = catchupSlowdownFactor;
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
    if (!Number.isFinite(n) || n < 0)
      throw new RangeError(
        `syncTolerance must be a finite number >= 0, got ${n}`,
      );
    this._syncTolerance = n;
  }
  get livestreamCatchup(): boolean {
    return this._livestreamCatchup;
  }
  set livestreamCatchup(val: boolean) {
    // Any toggle starts fresh: disengaged, re-arms at the upper bound.
    if (this._livestreamCatchup !== val) this._catchupEngaged = false;
    this._livestreamCatchup = val;
  }
  get catchupUpperBoundMs(): number {
    return this._catchupUpperBoundMs;
  }
  set catchupUpperBoundMs(n: number) {
    assertBound("catchupUpperBoundMs", n);
    if (n < this._catchupLowerBoundMs)
      throw new RangeError(
        `catchupUpperBoundMs (${n}) must be >= catchupLowerBoundMs (${this._catchupLowerBoundMs})`,
      );
    this._catchupUpperBoundMs = n;
  }
  get catchupLowerBoundMs(): number {
    return this._catchupLowerBoundMs;
  }
  set catchupLowerBoundMs(n: number) {
    assertBound("catchupLowerBoundMs", n);
    if (n > this._catchupUpperBoundMs)
      throw new RangeError(
        `catchupLowerBoundMs (${n}) must be <= catchupUpperBoundMs (${this._catchupUpperBoundMs})`,
      );
    this._catchupLowerBoundMs = n;
  }
  get catchupSpeedupFactor(): number {
    return this._catchupSpeedupFactor;
  }
  set catchupSpeedupFactor(n: number) {
    if (!Number.isFinite(n) || n <= 0 || n >= 1)
      throw new RangeError(
        `catchupSpeedupFactor must be a finite number in (0, 1), got ${n}`,
      );
    this._catchupSpeedupFactor = n;
  }
  get catchupMinFactor(): number {
    return this._catchupMinFactor;
  }
  set catchupMinFactor(n: number) {
    if (!Number.isFinite(n) || n <= 0 || n >= 1)
      throw new RangeError(
        `catchupMinFactor must be a finite number in (0, 1), got ${n}`,
      );
    this._catchupMinFactor = n;
  }
  get catchupSlowdownFactor(): number {
    return this._catchupSlowdownFactor;
  }
  set catchupSlowdownFactor(n: number) {
    if (!Number.isFinite(n) || n <= 0)
      throw new RangeError(
        `catchupSlowdownFactor must be a finite number > 0, got ${n}`,
      );
    this._catchupSlowdownFactor = n;
  }
  protected async _sendFrame(
    _frame: Buffer,
    _frametime: number,
  ): Promise<void> {
    throw new Error("Not implemented");
  }
  // P-controller gain: speedup per ms of backlog above the lower bound.
  private get _catchupSpeedupGainPerMs(): number {
    return (1 - this._catchupSpeedupFactor) / CATCHUP_REF_FRAMETIME_MS;
  }
  private resetTimingState() {
    this._t0 = undefined;
    this._p0 = undefined;
    this._pts = undefined;
    this._catchupEngaged = false;
  }

  // A/V sync error: this stream's media elapsed minus partner's last
  // sent elapsed. undefined when not applicable.
  private _syncErrorMs(ownPtsMs: number): number | undefined {
    const other = this._syncStream;
    if (!this._sync || other === undefined || other.writableEnded)
      return undefined;
    if (this._p0 === undefined || other._p0 === undefined) return undefined;
    if (other._pts === undefined || !Number.isFinite(other._pts))
      return undefined;
    return ownPtsMs - this._p0 - (other._pts - other._p0);
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

    // Send, then publish PTS for partner sync and listeners. Untimed
    // frames are sent but never published: garbage PTS would corrupt the
    // sync timeline.
    const sendAndPublish = async () => {
      const sendStart = performance.now();
      // Always the nominal frametime — pacing warp must never leak
      // into RTP timestamps.
      await this._sendFrame(buf, frametime);
      const sendTime = performance.now() - sendStart;
      // Clamp top so one slow frame can't bias pacing for long.
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
      if (timingValid) {
        this._pts = ptsMs;
        this.emit("pts", ptsMs);
      }
    };

    if (this._noSleep || !timingValid) {
      // Burst mode (or untimed frame): drain ASAP.
      await sendAndPublish();
      callback(null);
      return;
    }

    const nowMs = performance.now();

    // First frame or PTS discontinuity (seek/loop/wrap): rebase and
    // send immediately. Never rebase on mere lateness.
    if (this._t0 === undefined || this._p0 === undefined) {
      // Late joiner: the partner is already running, so align this
      // stream's origin to the partner's anchor instead of the epoch —
      // otherwise every frame would start minutes late. The partner's
      // anchor is untouched.
      const anchor = this._syncStream?._t0;
      this._t0 = nowMs;
      this._p0 = anchor === undefined ? ptsMs : ptsMs - (nowMs - anchor);
      await sendAndPublish();
      callback(null);
      return;
    }
    const lastPts = this._pts;
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
      this._t0 = nowMs;
      await sendAndPublish();
      callback(null);
      return;
    }

    // --- Nominal deadline ---
    const nominalMs = this._t0 + (ptsMs - this._p0);
    const sleepMs = nominalMs - nowMs - this._sendEmaMs - this._timerBiasEmaMs;

    // --- A/V sync trim ---
    // Ahead → stretch (slow down), capped so a far-ahead stream never
    // parks. Behind → compress (hurry) progressively, ~25% of error per
    // frame — fast convergence without skipping, preserving the
    // inter-frame reference chain.
    let syncTrimMs = 0;
    const syncErrorMs = this._syncErrorMs(ptsMs);
    if (
      syncErrorMs !== undefined &&
      Math.abs(syncErrorMs) > this._syncTolerance
    ) {
      if (syncErrorMs > 0) {
        const warpCapMs = SYNC_MAX_WARP_FRACTION * frametime;
        syncTrimMs = Math.min(
          syncErrorMs - this._syncTolerance,
          warpCapMs,
          SYNC_MAX_STRETCH_MS,
        );
      } else {
        const behindExcessMs = -(syncErrorMs + this._syncTolerance);
        const behindWantMs = Math.max(
          behindExcessMs * 0.25,
          SYNC_MAX_WARP_FRACTION * frametime,
        );
        // Ceil at 75% of sleepMs: non-negative wait, max ~4x fast-forward
        // per frame. When already late (sleepMs <= 0), compress = 0.
        const maxCompressMs = sleepMs > 0 ? 0.75 * sleepMs : 0;
        syncTrimMs = -Math.min(behindExcessMs, behindWantMs, maxCompressMs);
      }
    }

    // --- Livestream catchup trim: hysteretic 3-zone queue regulator ---
    // backlogMs is media-time so audio (20ms) and video (33ms) behave
    // identically. Zones: >= upper → speed up (Schmitt latch, released
    // at <= lower so transient queues never trigger speedup and a drain
    // is never abandoned early); between the bounds → hold; below the
    // lower bound → slow down proportionally to the deficit so input
    // refills the queue (with PTS-absolute deadlines this manifests as
    // a send-phase offset ≈ the settled queue depth, i.e. a jitter
    // buffer with bounded added latency). No accumulation anywhere —
    // nominal deadlines stay absolute.
    let catchupSpeedupMs = 0;
    let catchupSlowdownMs = 0;
    if (this._livestreamCatchup) {
      const backlogMs = this.writableLength * avg;
      if (backlogMs <= this._catchupLowerBoundMs) this._catchupEngaged = false;
      else if (backlogMs >= this._catchupUpperBoundMs)
        this._catchupEngaged = true;
      if (this._catchupEngaged && sleepMs > 0) {
        const excessMs = backlogMs - this._catchupLowerBoundMs;
        const speedup = Math.min(
          1 - this._catchupMinFactor,
          excessMs * this._catchupSpeedupGainPerMs,
        );
        if (speedup > 0) catchupSpeedupMs = sleepMs * speedup;
      } else if (!this._catchupEngaged) {
        // Shallow queue: stretch this frame so input accumulates during
        // the wait. Mutually exclusive with speedup (the latch always
        // releases at <= lower before we get here). Capped at the lower
        // bound so a single wait never exceeds the configured depth.
        const deficitMs = this._catchupLowerBoundMs - backlogMs;
        if (deficitMs > 0)
          catchupSlowdownMs = Math.min(
            this._catchupLowerBoundMs,
            deficitMs * this._catchupSlowdownFactor,
          );
      }
    }

    // Suppress stretch when there's backlog to drain or lateness to
    // absorb — draining beats aligning. Symmetrically, AV sync beats
    // buffer rebuild: hurrying (behind the partner) must not be
    // cancelled out by a shallow-queue stretch.
    if (
      syncTrimMs > 0 &&
      (catchupSpeedupMs > 0 || sleepMs - catchupSpeedupMs <= 0)
    ) {
      syncTrimMs = 0;
    }
    if (syncTrimMs < 0) catchupSlowdownMs = 0;

    const targetMs =
      nominalMs -
      this._sendEmaMs -
      this._timerBiasEmaMs +
      syncTrimMs -
      catchupSpeedupMs +
      catchupSlowdownMs;

    if (this._loggerSleep.enabled.trace) {
      this._loggerSleep.trace(
        {
          stats: {
            pts: ptsMs,
            nominalMs,
            sleepMs,
            syncErrorMs,
            syncTrimMs,
            catchupSpeedupMs,
            catchupEngaged: this._catchupEngaged,
            catchupSlowdownMs,
            targetMs,
            frametime,
          },
        },
        `Sleeping for ${Math.max(0, targetMs - nowMs).toFixed(2)}ms`,
      );
    } else if (this._loggerSync.enabled.debug && syncTrimMs !== 0) {
      this._loggerSync.debug(
        { stats: { pts: ptsMs, syncErrorMs, syncTrimMs, frametime } },
        syncTrimMs > 0
          ? "Stream is ahead. Stretching sleep for this frame"
          : "Stream is behind. Compressing sleep for this frame",
      );
    } else if (this._loggerSleep.enabled.debug && catchupSpeedupMs > 0) {
      this._loggerSleep.debug(
        {
          stats: {
            pts: ptsMs,
            queueLength: this.writableLength,
            backlogMs: this.writableLength * avg,
            frametime,
            sleepMs,
            catchupSpeedupMs,
          },
        },
        `Livestream catchup: queue backed up. Sleeping for ${(sleepMs - catchupSpeedupMs).toFixed(2)}ms instead of ${sleepMs.toFixed(2)}ms`,
      );
    } else if (this._loggerSleep.enabled.debug && catchupSlowdownMs > 0) {
      this._loggerSleep.debug(
        {
          stats: {
            pts: ptsMs,
            queueLength: this.writableLength,
            backlogMs: this.writableLength * avg,
            frametime,
            sleepMs,
            catchupSlowdownMs,
          },
        },
        `Livestream catchup: queue below lower bound. Sleeping ${catchupSlowdownMs.toFixed(2)}ms longer`,
      );
    }

    // One timer per frame. Late frames send immediately; PTS-absolute
    // deadline keeps lateness bounded per frame.
    const waitMs = targetMs - performance.now();
    if (waitMs > 0) {
      await setTimeout(waitMs);
      const lateMs = performance.now() - targetMs;
      const sampleMs = Math.min(Math.max(lateMs, 0), 10);
      this._timerBiasEmaMs = Math.min(
        this._timerBiasEmaMs + 0.1 * (sampleMs - this._timerBiasEmaMs),
        TIMER_BIAS_MAX_MS,
      );
    }

    await sendAndPublish();
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
