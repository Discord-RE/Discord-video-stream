import { Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { Log } from "debug-level";
import type { Packet } from "node-av";
import YoctoQueue from "yocto-queue";

// One arrived frame waiting in our own queue (see below).
type QueuedFrame = {
  buf: Buffer;
  ptsMs: number;
  frametime: number;
  timed: boolean;
};

export type BaseMediaStreamOptions = {
  noSleep?: boolean;
  /**
   * Floor of the adaptive jitter-buffer target (media ms). A steady
   * realtime source settles here — this is the steady-state latency
   * this stream adds, so keep it small for fast volume response.
   */
  jitterMinBufferMs?: number;
  /**
   * Ceiling of the adaptive jitter-buffer target (media ms).
   */
  jitterMaxBufferMs?: number;
  /**
   * Target growth per ms of measured input jitter:
   * target = min(target) + jitterGain * jitter.
   */
  jitterGain?: number;
  /**
   * Slowest playout rate (media seconds per wall second), in (0, 1].
   * Gentle slowdown stretches coverage while input refills.
   */
  minPlayoutRate?: number;
  /**
   * Fastest playout rate, in [1, 4]. Caps how fast deep queues drain.
   */
  maxPlayoutRate?: number;
  /**
   * Queue headroom above the jitter target before upstream is
   * throttled (media ms). The highWaterMark tracks
   * target + headroom + jitter, so a fast upstream shrinks the
   * buffer (low latency) while a bursty one re-opens room to absorb
   * bursts where the servo can see them. Defaults: 150 audio / 400
   * video (video bursts are burstier — keyframes — and a stalled
   * video pipe head-of-line-blocks audio in the shared demux loop).
   */
  bufferHeadroomMs?: number;
};

/** Per-codec pacing tunings each subclass supplies to the constructor. */
export type BaseMediaStreamTuning = {
  /** Static highWaterMark ceiling (packets): absolute cap on queued
   * media. The dynamic HWM never exceeds this. */
  hwmMaxFrames: number;
  /** Default headroom above the jitter target before throttling
   * upstream (media ms). */
  bufferHeadroomMs: number;
};

// Frame interval seed (~33ms @ 30fps) so call sites never deal with
// undefined before the first real frametime arrives.
const REF_FRAMETIME_MS = 1000 / 30;

const DEFAULT_JITTER = {
  minBufferMs: 30,
  maxBufferMs: 1000,
  gain: 2,
  minRate: 0.92,
  maxRate: 1.06,
};

// P-servo gain: +500ms of excess buffer → +5% playout rate. Small on
// purpose — large corrections come from sustained mild elevation,
// not from snaps (that's what caused rubber-banding).
const RATE_GAIN_PER_MS = 0.0001;
// Slew limit per frame: 1.00 → 1.06 takes ~12 frames (~0.4s video).
// Every rate change ramps — nothing in the output ever steps.
const RATE_SLEW_PER_FRAME = 0.005;
// Arrival gaps beyond this are starvation (idle), not jitter —
// excluded from the jitter estimate.
const STARVE_GAP_FACTOR = 8;
const STARVE_GAP_MIN_MS = 250;
// Resume after the due-chain falls this far behind: re-anchor to now
// instead of bursting to repay debt.
const RESUME_LAG_FACTOR = 4;
const RESUME_LAG_MIN_MS = 100;

// The dynamic HWM never drops below target + this many frametimes —
// throttling below the target would starve the servo (pinned negative
// error → pinned minimum rate).
const HWM_MIN_MARGIN_FRAMES = 2;
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

function assertNonNegative(name: string, n: number): void {
  if (!Number.isFinite(n) || n < 0)
    throw new RangeError(`${name} must be a finite number >= 0, got ${n}`);
}

export class BaseMediaStream extends Writable {
  private _pts?: number;
  private _syncTolerance = 20;
  private _loggerSend: Log;
  private _loggerSync: Log;
  private _loggerSleep: Log;
  private _loggerStats: Log;
  private _statsTimer?: NodeJS.Timeout;

  private _noSleep: boolean;
  private _sync = true;
  private _syncStream?: BaseMediaStream;
  private _frameSendDeadlineExceededCount = 0;

  // Wall anchor for the PTS origin — used ONLY for the A/V sync error
  // (media-elapsed comparison). Pacing itself is self-clocked (due
  // chain below), so input stalls/bursts can never inject debt.
  private _t0?: number;
  private _p0?: number;

  // --- Adaptive jitter buffer ---
  // Frames queue in our own yocto-queue — Node's internal buffer is
  // bypassed (HWM 0) so queue depth is exact and backpressure is ours
  // to exert: intake withholds write callbacks at the dynamic HWM
  // instead of mutating Node internals. A pump loop sends queued
  // frames in arrival order at the paced rate.
  // Target queued media adapts to measured input burstiness; the
  // playout rate steers the actual queue toward it. Steady realtime
  // input → target sits at the floor (low latency, fast volume
  // response). Bursty input → target grows to cover the gaps.
  // Flooding input (ffmpeg faster than realtime) → queue pins at the
  // dynamic HWM, the upstream-hold clamps the rate to exactly 1.0 and
  // backpressure throttles the source. No regime ever drops
  // frames or steps the rate, so bursty HLS meters out smoothly
  // instead of rubber-banding.
  private _jitterMinBufferMs: number = DEFAULT_JITTER.minBufferMs;
  private _jitterMaxBufferMs: number = DEFAULT_JITTER.maxBufferMs;
  private _jitterGain: number = DEFAULT_JITTER.gain;
  private _minPlayoutRate: number = DEFAULT_JITTER.minRate;
  private _maxPlayoutRate: number = DEFAULT_JITTER.maxRate;
  // Set in the constructor from the subclass tuning / option override.
  private _bufferHeadroomMs = 0;
  private _hwmMaxFrames: number;
  private _jitterMs = 0;
  // Owned by the jitterMinBufferMs/jitterMaxBufferMs setters (starts at
  // 0 so the constructor's min-setter establishes the floor).
  private _targetBufferMs = 0;
  private _playoutRate = 1;
  private _upstreamHold = false;
  private _nextDueMs?: number;
  private _lastArrivalMs?: number;
  private _lastArrivalPtsMs?: number;
  // Owned buffer + playout pump (see _pump). Intake is synchronous;
  // at most one write callback is ever withheld (serial _write).
  private _queue = new YoctoQueue<QueuedFrame>();
  private _intakeCallback?: (error?: Error | null) => void;
  private _pumpRunning = false;
  private _destroyed = false;
  private _wakePump?: () => void;
  // Aborted on destroy so an in-flight pacing sleep rejects instead of
  // waking up and sending a frame after teardown.
  private _abort = new AbortController();
  // Smoothed frame interval (ms), seeded ~33ms so call sites never deal
  // with undefined. Survives resetTimingState; adapts within a few frames
  // if content changes.
  private _avgFrametime: number = REF_FRAMETIME_MS;
  // EMAs of send cost and timer overshoot, used to center sends on the
  // deadline without extra wakeups.
  private _sendEmaMs = 0;
  private _timerBiasEmaMs = 0;

  constructor(
    type: string,
    options: BaseMediaStreamOptions,
    tuning: BaseMediaStreamTuning,
  ) {
    super({ objectMode: true, highWaterMark: 0 });
    this._loggerSend = new Log(`stream:${type}:send`);
    this._loggerSync = new Log(`stream:${type}:sync`);
    this._loggerSleep = new Log(`stream:${type}:sleep`);
    this._loggerStats = new Log(`stream:${type}:stats`);
    const {
      noSleep = false,
      jitterMinBufferMs = DEFAULT_JITTER.minBufferMs,
      jitterMaxBufferMs = DEFAULT_JITTER.maxBufferMs,
      jitterGain = DEFAULT_JITTER.gain,
      minPlayoutRate = DEFAULT_JITTER.minRate,
      maxPlayoutRate = DEFAULT_JITTER.maxRate,
      bufferHeadroomMs,
    } = options;
    this._noSleep = noSleep;
    this._hwmMaxFrames = tuning.hwmMaxFrames;
    this.bufferHeadroomMs = bufferHeadroomMs ?? tuning.bufferHeadroomMs;
    this.jitterMinBufferMs = jitterMinBufferMs;
    this.jitterMaxBufferMs = jitterMaxBufferMs;
    this.jitterGain = jitterGain;
    this.minPlayoutRate = minPlayoutRate;
    this.maxPlayoutRate = maxPlayoutRate;
    // Per-second jitter-buffer status snapshot. unref so the log timer
    // alone never keeps the process alive.
    this._statsTimer = setInterval(() => {
      if (this._destroyed || !this._loggerStats.enabled.debug) return;
      this._loggerStats.debug(
        {
          stats: {
            bufferMs: this.bufferMs,
            targetBufferMs: this._targetBufferMs,
            jitterMs: this._jitterMs,
            queueSize: this._queue.size,
            writableLength: this.writableLength,
            dynamicHwmFrames: this._dynamicHwmFrames(),
            playoutRate: this._playoutRate,
            upstreamHold: this._upstreamHold,
            avgFrametime: this._avgFrametime,
          },
        },
        "Jitter buffer status",
      );
    }, 1000);
    this._statsTimer.unref();
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
    assertNonNegative("syncTolerance", n);
    this._syncTolerance = n;
  }
  get jitterMinBufferMs(): number {
    return this._jitterMinBufferMs;
  }
  set jitterMinBufferMs(n: number) {
    assertNonNegative("jitterMinBufferMs", n);
    if (n > this._jitterMaxBufferMs)
      throw new RangeError(
        `jitterMinBufferMs (${n}) must be <= jitterMaxBufferMs (${this._jitterMaxBufferMs})`,
      );
    this._jitterMinBufferMs = n;
    this._targetBufferMs = Math.max(this._targetBufferMs, n);
  }
  get jitterMaxBufferMs(): number {
    return this._jitterMaxBufferMs;
  }
  set jitterMaxBufferMs(n: number) {
    assertNonNegative("jitterMaxBufferMs", n);
    if (n < this._jitterMinBufferMs)
      throw new RangeError(
        `jitterMaxBufferMs (${n}) must be >= jitterMinBufferMs (${this._jitterMinBufferMs})`,
      );
    this._jitterMaxBufferMs = n;
    this._targetBufferMs = Math.min(this._targetBufferMs, n);
  }
  get jitterGain(): number {
    return this._jitterGain;
  }
  set jitterGain(n: number) {
    assertNonNegative("jitterGain", n);
    this._jitterGain = n;
  }
  get minPlayoutRate(): number {
    return this._minPlayoutRate;
  }
  set minPlayoutRate(n: number) {
    if (!Number.isFinite(n) || n <= 0 || n > 1)
      throw new RangeError(
        `minPlayoutRate must be a finite number in (0, 1], got ${n}`,
      );
    this._minPlayoutRate = n;
  }
  get maxPlayoutRate(): number {
    return this._maxPlayoutRate;
  }
  set maxPlayoutRate(n: number) {
    if (!Number.isFinite(n) || n < 1 || n > 4)
      throw new RangeError(
        `maxPlayoutRate must be a finite number in [1, 4], got ${n}`,
      );
    this._maxPlayoutRate = n;
  }
  get bufferHeadroomMs(): number {
    return this._bufferHeadroomMs;
  }
  set bufferHeadroomMs(n: number) {
    assertNonNegative("bufferHeadroomMs", n);
    this._bufferHeadroomMs = n;
  }
  /** Current smoothed playout rate (media s per wall s). */
  get playoutRate(): number {
    return this._playoutRate;
  }
  /** Current adaptive buffer target (media ms). */
  get targetBufferMs(): number {
    return this._targetBufferMs;
  }
  /** Current input-burstiness estimate (ms). */
  get jitterMs(): number {
    return this._jitterMs;
  }
  /** Currently queued media (ms) — owned queue plus any Node-internal
   * backlog (nonzero only when the producer ignores backpressure). */
  get bufferMs(): number {
    return (this._queue.size + this.writableLength) * this._avgFrametime;
  }
  /** Currently queued frames. */
  get queueSize(): number {
    return this._queue.size;
  }
  protected async _sendFrame(
    _frame: Buffer,
    _frametime: number,
  ): Promise<void> {
    throw new Error("Not implemented");
  }
  // Dynamic highWaterMark (frames): target + headroom + jitter,
  // floored above the target so the servo never starves, capped at
  // the static maxima. Intake withholds write callbacks at/above
  // this level — backpressure via public stream semantics.
  private _dynamicHwmFrames(): number {
    const avg = this._avgFrametime;
    const capMs = this._hwmMaxFrames * avg;
    const floorMs = Math.min(
      capMs,
      this._targetBufferMs + HWM_MIN_MARGIN_FRAMES * avg,
    );
    const targetMs = Math.min(
      capMs,
      Math.max(
        floorMs,
        this._targetBufferMs + this._bufferHeadroomMs + this._jitterMs,
      ),
    );
    return Math.max(2, Math.round(targetMs / avg));
  }
  // Release the withheld intake callback once the queue has room.
  // After end(), hold it until the queue fully drains so 'finish'
  // can't fire with frames still unsent.
  private _maybeReleaseIntake(): void {
    const stashed = this._intakeCallback;
    if (!stashed) return;
    if (this._queue.size >= this._dynamicHwmFrames()) return;
    if (this.writableEnded && this._queue.size > 0) return;
    this._intakeCallback = undefined;
    stashed(null);
  }
  private _ensurePump(): void {
    if (this._pumpRunning || this._destroyed) return;
    this._pumpRunning = true;
    void this._pump();
  }
  // Playout pump: sends queued frames serially in arrival order.
  // Idles on a gate (no polling) until intake enqueues or destroy
  // wakes it. Pump errors destroy the stream, mirroring how a throw
  // inside _write used to surface.
  private async _pump(): Promise<void> {
    try {
      while (!this._destroyed) {
        const queued = this._queue.dequeue();
        if (!queued) {
          await new Promise<void>((resolve) => {
            this._wakePump = resolve;
          });
          this._wakePump = undefined;
          continue;
        }
        try {
          await this._paceAndSend(queued);
        } catch (err) {
          // AbortError here means destroy() raced the pacing sleep —
          // teardown already handled it; only fresh errors re-destroy.
          if (!this._destroyed) this.destroy(err as Error);
          return;
        }
        this._maybeReleaseIntake();
      }
    } finally {
      this._pumpRunning = false;
    }
  }
  private resetTimingState() {
    this._t0 = undefined;
    this._p0 = undefined;
    this._pts = undefined;
    this._nextDueMs = undefined;
    this._lastArrivalMs = undefined;
    this._lastArrivalPtsMs = undefined;
    this._jitterMs = 0;
    this._targetBufferMs = this._jitterMinBufferMs;
    this._playoutRate = 1;
    this._upstreamHold = false;
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

  // Observe input pacing: asymmetric-EMA jitter on |arrival gap - PTS
  // gap|, ignoring starvation idles. Retunes the buffer target.
  private _observeInput(nowMs: number, ptsMs: number): void {
    const lastT = this._lastArrivalMs;
    const lastP = this._lastArrivalPtsMs;
    this._lastArrivalMs = nowMs;
    this._lastArrivalPtsMs = ptsMs;
    if (lastT === undefined || lastP === undefined) return;
    const arrivalGapMs = nowMs - lastT;
    const starveMs = Math.max(
      STARVE_GAP_MIN_MS,
      STARVE_GAP_FACTOR * this._avgFrametime,
    );
    if (arrivalGapMs < 0 || arrivalGapMs >= starveMs) return;
    const sampleMs = Math.abs(arrivalGapMs - (ptsMs - lastP));
    if (!Number.isFinite(sampleMs)) return;
    const alpha = sampleMs > this._jitterMs ? 0.25 : 0.03;
    this._jitterMs += alpha * (sampleMs - this._jitterMs);
    this._targetBufferMs = Math.min(
      this._jitterMaxBufferMs,
      Math.max(
        this._jitterMinBufferMs,
        this._jitterMinBufferMs + this._jitterGain * this._jitterMs,
      ),
    );
  }

  // Intake: parse, observe, enqueue, then release the write callback
  // now (queue has room) or withhold it (backpressure at the dynamic
  // HWM). Fully synchronous — serial _write calls can't interleave,
  // so enqueue + release is atomic with respect to the pump.
  // Everything (paced, burst, untimed) flows through the queue, so
  // sends always leave in arrival order.
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
    const frametimeOk = Number.isFinite(frametime) && frametime > 0;
    if (frametimeOk) {
      this._avgFrametime += 0.15 * (frametime - this._avgFrametime);
    }
    const ptsMs = (Number(pts) / timeBase.den) * timeBase.num * 1000;
    const timed = frametimeOk && Number.isFinite(ptsMs);
    if (timed) this._observeInput(performance.now(), ptsMs);

    // Copy out and release native memory: the frame may wait in the
    // queue while earlier frames play out.
    const buf = Buffer.from(data);
    frame.free();

    this._queue.enqueue({ buf, ptsMs, frametime, timed });
    this._ensurePump();
    this._wakePump?.();
    // Single release path (room check + end-hold) — inline here would
    // let 'finish' fire with frames still queued after end().
    this._intakeCallback = callback;
    this._maybeReleaseIntake();
  }

  // One frame's paced journey: anchor/discontinuity handling, buffer
  // servo, sync trim, due-chain wait, send + publish. Runs serially in
  // the pump, so sends always leave in arrival order.
  private async _paceAndSend(queued: QueuedFrame): Promise<void> {
    const { buf, ptsMs, frametime, timed } = queued;

    if (this._noSleep || !timed) {
      // Burst mode (or untimed frame): drain ASAP. No pacing, no due
      // advance — and untimed frames are never published, since
      // garbage PTS would corrupt the sync timeline.
      await this._sendWithCost(buf, frametime, timed);
      if (timed) this._publishPts(ptsMs);
      return;
    }

    const nowMs = performance.now();
    const avg = this._avgFrametime;

    // First frame or PTS discontinuity (seek/loop/wrap): anchor and
    // send immediately. Never rebase on mere lateness.
    if (this._t0 === undefined || this._p0 === undefined) {
      // Late joiner: the partner is already running, so align this
      // stream's origin to the partner's anchor instead of the epoch —
      // otherwise every frame would start minutes late. The partner's
      // anchor is untouched.
      const anchor = this._syncStream?._t0;
      this._t0 = nowMs;
      this._p0 = anchor === undefined ? ptsMs : ptsMs - (nowMs - anchor);
      this._nextDueMs = nowMs;
      await this._sendPublishTimed(buf, frametime, ptsMs);
      return;
    }
    const lastPts = this._pts;
    const jumpLimit = Math.max(1000, avg * 10);
    if (
      lastPts !== undefined &&
      (ptsMs < lastPts || ptsMs - lastPts > jumpLimit)
    ) {
      this._loggerSync.debug(
        { stats: { pts: ptsMs, lastPts, jumpLimit } },
        "PTS discontinuity. Rebasing presentation timeline",
      );
      // Fresh timeline: shared reset, then re-anchor to this frame —
      // no debt, no burst.
      this.resetTimingState();
      this._t0 = nowMs;
      this._p0 = ptsMs;
      this._nextDueMs = nowMs;
      this._lastArrivalMs = nowMs;
      this._lastArrivalPtsMs = ptsMs;
      await this._sendPublishTimed(buf, frametime, ptsMs);
      return;
    }

    // --- Buffer servo ---
    // Error drives a P-controller. While an intake callback is
    // withheld, upstream is delivering faster than we drain (otherwise
    // the queue would have room) — so hold exactly 1.0 and let
    // backpressure throttle it. The alternative, sustained >1 output,
    // accumulates unbounded downstream debt. The hold self-clears when
    // the pump drains below the dynamic HWM and releases intake, and
    // every rate change is slew-limited below, so playout never steps.
    const bufferMs = this.bufferMs;
    const throttled = this._intakeCallback !== undefined;
    if (throttled !== this._upstreamHold) {
      this._upstreamHold = throttled;
      this._loggerSleep.debug(
        { stats: { bufferMs, queueSize: this._queue.size } },
        throttled
          ? "Upstream outrunning playout: holding 1.0x, backpressure throttles source"
          : "Intake released: resuming buffer servo",
      );
    }
    const errorMs = bufferMs - this._targetBufferMs;
    const rawRate = this._upstreamHold
      ? 1
      : Math.min(
          this._maxPlayoutRate,
          Math.max(this._minPlayoutRate, 1 + RATE_GAIN_PER_MS * errorMs),
        );
    const step = Math.min(
      RATE_SLEW_PER_FRAME,
      Math.max(-RATE_SLEW_PER_FRAME, rawRate - this._playoutRate),
    );
    this._playoutRate += step;
    const rate = this._playoutRate;

    // --- A/V sync trim ---
    // Ahead → stretch (slow down), capped so a far-ahead stream never
    // parks. Behind → compress (hurry) progressively, ~25% of error per
    // frame — fast convergence without skipping, preserving the
    // inter-frame reference chain. Additive on this frame only; the
    // servo absorbs any resulting buffer offset via feedback.
    let syncTrimMs = 0;
    const syncErrorMs = this._syncErrorMs(ptsMs);
    if (
      syncErrorMs !== undefined &&
      Math.abs(syncErrorMs) > this._syncTolerance
    ) {
      // Nominal sleep before trim, for the compress ceiling below.
      const due0 = this._nextDueMs ?? nowMs;
      const sleepMs = due0 + frametime / rate - nowMs;
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
        // Ceil at 75% of sleep: non-negative wait, max ~4x fast-forward
        // per frame. When already late (sleep <= 0), compress = 0.
        const maxCompressMs = sleepMs > 0 ? 0.75 * sleepMs : 0;
        syncTrimMs = -Math.min(behindExcessMs, behindWantMs, maxCompressMs);
      }
    }

    // --- Due chain ---
    // Self-clocked: each frame is due one (rate-adjusted) frametime
    // after the previous due. After a starvation gap the chain would
    // sit permanently behind, so re-anchor to now — resume, don't repay.
    const resumeLagMs = Math.max(RESUME_LAG_MIN_MS, RESUME_LAG_FACTOR * avg);
    let dueMs = this._nextDueMs;
    if (dueMs === undefined || nowMs - dueMs > resumeLagMs) dueMs = nowMs;
    dueMs += frametime / rate;
    this._nextDueMs = dueMs;

    const targetMs =
      dueMs - this._sendEmaMs - this._timerBiasEmaMs + syncTrimMs;

    if (this._loggerSleep.enabled.trace) {
      this._loggerSleep.trace(
        {
          stats: {
            pts: ptsMs,
            bufferMs,
            targetBufferMs: this._targetBufferMs,
            dynamicHwmFrames: this._dynamicHwmFrames(),
            queueSize: this._queue.size,
            jitterMs: this._jitterMs,
            rate,
            upstreamHold: this._upstreamHold,
            syncErrorMs,
            syncTrimMs,
            targetMs,
            frametime,
          },
        },
        `Sleeping for ${Math.max(0, targetMs - nowMs).toFixed(2)}ms`,
      );
    }

    // One timer per frame. Late frames send immediately; the due chain
    // re-anchors (above) instead of accumulating debt. Abortable: on
    // destroy the sleep rejects so no frame is sent after teardown.
    const waitMs = targetMs - performance.now();
    if (waitMs > 0) {
      await setTimeout(waitMs, undefined, { signal: this._abort.signal });
      const lateMs = performance.now() - targetMs;
      const sampleMs = Math.min(Math.max(lateMs, 0), 10);
      this._timerBiasEmaMs = Math.min(
        this._timerBiasEmaMs + 0.1 * (sampleMs - this._timerBiasEmaMs),
        TIMER_BIAS_MAX_MS,
      );
    }

    await this._sendPublishTimed(buf, frametime, ptsMs);
  }

  // Send + cost accounting. RTP timestamps always use the nominal
  // frametime — pacing warp must never leak into them.
  private async _sendWithCost(
    buf: Buffer,
    frametime: number,
    timed: boolean,
  ): Promise<void> {
    const sendStart = performance.now();
    await this._sendFrame(buf, frametime);
    this._noteSendCost(
      performance.now() - sendStart,
      buf.length,
      frametime,
      timed,
    );
  }

  // Timed send: nominal-frametime send + PTS publish for partner sync
  // and listeners.
  private async _sendPublishTimed(
    buf: Buffer,
    frametime: number,
    ptsMs: number,
  ): Promise<void> {
    await this._sendWithCost(buf, frametime, true);
    this._publishPts(ptsMs);
  }

  private _noteSendCost(
    sendTimeMs: number,
    frameSize: number,
    frametime: number,
    timed: boolean,
  ): void {
    // Clamp top so one slow frame can't bias pacing for long.
    this._sendEmaMs = Math.min(
      this._sendEmaMs + 0.1 * (sendTimeMs - this._sendEmaMs),
      5,
    );
    if (timed && sendTimeMs > frametime) {
      this._frameSendDeadlineExceededCount++;
      if (this._frameSendDeadlineExceededCount > 10) {
        this._loggerSend.warn(
          {
            frame_size: frameSize,
            duration: sendTimeMs,
            frametime,
          },
          `Frame takes too long to send (${((sendTimeMs / frametime) * 100).toFixed(2)}% frametime)`,
        );
      }
    } else {
      this._frameSendDeadlineExceededCount = 0;
    }
  }

  private _publishPts(ptsMs: number): void {
    if (this._destroyed) return;
    this._pts = ptsMs;
    this.emit("pts", ptsMs);
  }

  _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    // Teardown is immediate: kill the pacing sleep, drop every queued
    // frame, wake the pump (loop exits on _destroyed), release any
    // withheld intake. Nothing drains — end()'s finish-hold applies
    // only to a normal end, not destroy.
    this._destroyed = true;
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = undefined;
    }
    this._abort.abort();
    this._queue.clear();
    const wake = this._wakePump;
    this._wakePump = undefined;
    wake?.();
    const intake = this._intakeCallback;
    this._intakeCallback = undefined;
    super._destroy(error, callback);
    intake?.(error ?? undefined);
    this.syncStream = undefined;
  }
}
