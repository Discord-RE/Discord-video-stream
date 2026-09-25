import { Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { Log } from "debug-level";
import type { Packet } from "node-av";
import Queue from "yocto-queue";

type QueuedFrame = {
  data: Buffer;
  /** Media timestamp of the frame, in milliseconds */
  pts: number;
  /** Media duration of the frame, in milliseconds */
  frametime: number;
};

type BlockEvent = { at: number; waited: number };

/**
 * Adaptive jitter-buffer pacer for live / pseudo-live media output.
 *
 * Instead of assuming the input outpaces the clock, it observes input pacing
 * (arrival wall time vs. media time) and adapts two knobs:
 *
 * - `targetDelay`: desired buffer level (media ms). Starts minimal; grows
 *   when output actually starves (block events, e.g. HLS segment fetch
 *   gaps), decays toward a floor derived from recent blocking. Smooth live
 *   sources stay at ~30ms; bursty sources earn ~one segment of headroom.
 * - `outputRate`: proportional correction of the playout clock around 1x.
 *   Above-realtime drain is only allowed while arrivals look fresh, smooth
 *   and ~realtime (a startup burst); anything else paces at 1x and lets
 *   backpressure absorb the difference.
 *
 * Backpressure holds `_write` callbacks once media exceeds target + margin
 * (lean margin, temporarily widened after proven stalls), throttling
 * ahead-of-realtime input to ~1x. Intermediate stream buffers stay shallow
 * so this media-time queue is the single governor of pipeline latency.
 *
 * A/V sync: with `syncStream` set, this stream skews its playout *rate*
 * (never jumps the clock), so the media-time offset to the master decays
 * gradually within `syncTolerance`.
 *
 * File/VOD input (sustained faster-than-realtime by nature) is out of scope
 * for the adaptation: unless `isLive` is set, the target stays at its
 * minimum and the rate at 1x, keeping only backpressure and A/V sync.
 */
export class BaseMediaStream extends Writable {
  private _pts?: number;
  private _sync = true;
  private _syncTolerance = 20;
  private _syncStream?: BaseMediaStream;
  private _syncEngaged = false;
  private _noSleep: boolean;
  private readonly _isLive: boolean;

  private readonly _lgSend: Log;
  private readonly _lgSync: Log;
  private readonly _lgSleep: Log;
  private readonly _lgBuffer: Log;

  // Jitter buffer state.
  private readonly _queue = new Queue<QueuedFrame>();
  private _bufferedMs = 0;
  private _targetDelayMs: number;
  private _outputRate = 1;
  private _nextPlayoutTime?: number;
  private _lastFrametime = 20;

  // Input observation state.
  private _lastArrivalWall?: number;
  private _lastArrivalPts?: number;
  private _speedSamples: { wall: number; pts: number }[] = [];
  private _blockEvents: BlockEvent[] = [];
  private _lastBlockWall = 0;
  private _lastDecayTick = performance.now();

  // Playout loop lifecycle.
  private _upstreamEnded = false;
  private _playoutFinished = false;
  private _destroyedByUs = false;
  private _loopStarted = false;
  private _loopDone?: Promise<void>;
  private _wake?: () => void;

  // Backpressure: held _write callbacks while over the cap.
  private _heldCallbacks: ((error?: Error | null) => void)[] = [];
  private _backpressureWaits = 0;
  private _slowSends = 0;

  private static readonly MIN_TARGET_MS = 30;
  private static readonly MAX_TARGET_MS = 15_000;
  private static readonly MIN_CAP_MS = 500;
  private static readonly MAX_CAP_MS = 30_000;
  /** Burst headroom above the target, granted only after a proven stall. */
  private static readonly CAP_MARGIN_MS = 4_000;
  /** Lean base headroom: enough for the rate controller to work with. */
  private static readonly CAP_MARGIN_LOW_MS = 500;
  /** How long a stall keeps the wide headroom before it decays. */
  private static readonly MARGIN_HOLD_MS = 10_000;
  /** Starvation/blocking longer than this counts as a genuine input stall. */
  private static readonly BLOCK_MS = 250;
  private static readonly MIN_RATE = 0.85;
  /** Max rate used to drain a buffered excess back towards the target. */
  private static readonly MAX_RATE_DRAIN = 1.5;
  /** Proportional control time constant: buffer error / this => rate offset. */
  private static readonly RATE_TC_MS = 1_000;
  /** Trailing window for input-speed estimation (bursts age out fast). */
  private static readonly SPEED_WINDOW_MS = 750;
  private static readonly SPEED_MIN_SPAN_MS = 200;
  /** Arrivals older than this are stale; speed is unknown during gaps. */
  private static readonly SPEED_FRESH_MS = 500;
  private static readonly SPEED_SLOW = 0.8;
  private static readonly SPEED_FAST = 1.3;
  /** Trailing window for the inter-arrival gap check. */
  private static readonly GAP_WINDOW_MS = 250;
  /**
   * Arrivals are trusted for speedup only below this gap: throttled input
   * runs at release pace (bursts + holds), so its average can read realtime
   * while its gaps give it away.
   */
  private static readonly DRAIN_MAX_GAP_MS = 150;
  private static readonly DECAY_INTERVAL_MS = 5_000;
  private static readonly BLOCK_WINDOW_MS = 60_000;
  /**
   * A/V sync correction time constant: offset / this => rate skew. Small
   * enough that a pace mismatch (e.g. the buffer controller draining at
   * 1.5x against a 1x master) settles within a small standing offset
   * (TC x pace error), large enough that pts quantization (one frametime
   * per send) only wobbles the sleep by a few ms.
   */
  private static readonly SYNC_TC_MS = 150;
  /** A/V sync rate skew bound (fraction of realtime) in either direction. */
  private static readonly MAX_SYNC_SKEW = 0.5;

  constructor(type: string, noSleep = false, isLive = false) {
    // Shallow stream buffer on purpose: the media-time queue below (plus
    // backpressure) is the single governor of buffering and latency.
    super({ objectMode: true, highWaterMark: 16 });
    const lg = (ch: string) => new Log(`stream:${type}:${ch}`);
    this._lgSend = lg("send");
    this._lgSync = lg("sync");
    this._lgSleep = lg("sleep");
    this._lgBuffer = lg("buffer");
    this._noSleep = noSleep;
    this._isLive = isLive;
    this._targetDelayMs = BaseMediaStream.MIN_TARGET_MS;
  }

  // --- public API ---

  get sync(): boolean {
    return this._sync;
  }
  set sync(val: boolean) {
    this._sync = val;
    this._lgSync.debug(`Sync ${val ? "enabled" : "disabled"}`);
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
    // Disengage the clock so pacing re-anchors cleanly when it resumes.
    if (!val) this.resetClock();
  }
  /** Whether the input is declared live (adaptive jitter-buffer pacing). */
  get isLive(): boolean {
    return this._isLive;
  }
  get pts(): number | undefined {
    return this._pts;
  }
  get syncTolerance() {
    return this._syncTolerance;
  }
  set syncTolerance(n: number) {
    if (n >= 0) this._syncTolerance = n;
  }
  /** Current adaptive jitter buffer target, in milliseconds. */
  get targetDelay(): number {
    return this._targetDelayMs;
  }
  /** Current smoothed output speed factor (excludes the sync skew). */
  get outputRate(): number {
    return this._outputRate;
  }
  /** Media time currently held in the jitter buffer, in milliseconds. */
  get bufferedDuration(): number {
    return this._bufferedMs;
  }
  /** How many times a writer was held back by buffer backpressure. */
  get backpressureWaits(): number {
    return this._backpressureWaits;
  }
  get playoutFinished(): boolean {
    return this._playoutFinished;
  }

  protected async _sendFrame(
    _frame: Buffer,
    _frametime: number,
  ): Promise<void> {
    throw new Error("Not implemented");
  }

  // --- buffering & backpressure ---

  private get bufferCapMs(): number {
    // Wide headroom only for a while after a proven stall (absorb bursts,
    // ride out gaps); stay lean otherwise so steady-state latency is low
    // from the very start.
    const recentStall =
      this._lastBlockWall !== 0 &&
      performance.now() - this._lastBlockWall < BaseMediaStream.MARGIN_HOLD_MS;
    const margin = recentStall
      ? BaseMediaStream.CAP_MARGIN_MS
      : BaseMediaStream.CAP_MARGIN_LOW_MS;
    return Math.min(
      BaseMediaStream.MAX_CAP_MS,
      Math.max(BaseMediaStream.MIN_CAP_MS, this._targetDelayMs + margin),
    );
  }

  private releaseBackpressure() {
    // Release one writer per frame sent (not a batch at a low watermark):
    // the upstream then advances exactly at output pace instead of flooding
    // in bursts, which would sawtooth both the buffer and the arrivals.
    if (this._heldCallbacks.length === 0) return;
    if (this._bufferedMs > this.bufferCapMs) return;
    this._heldCallbacks.shift()?.(null);
  }

  // --- input observation ---

  private observeArrival(now: number, pts: number) {
    if (!this._isLive) return;
    const prevWall = this._lastArrivalWall;
    const prevPts = this._lastArrivalPts;
    this._lastArrivalWall = now;
    this._lastArrivalPts = pts;
    if (prevWall === undefined || prevPts === undefined) return;
    if (!Number.isFinite(pts)) return;
    // Gaps observed while we hold the writer measure our own throttling,
    // not the input: only free-running arrivals say anything about pacing.
    if (this._heldCallbacks.length > 0) return;
    const mediaAdvance = pts - prevPts;
    // A discontinuity (seek, track switch) resets the baseline instead of
    // polluting it.
    if (Math.abs(mediaAdvance) > 30_000) {
      this._speedSamples.length = 0;
      return;
    }
    this._speedSamples.push({ wall: now, pts });
    while (
      this._speedSamples.length > 1 &&
      now - this._speedSamples[0].wall > BaseMediaStream.SPEED_WINDOW_MS
    ) {
      this._speedSamples.shift();
    }
    // How far the input fell behind the media timeline between packets.
    // Steady inputs sit at ~0 or below; an input stall (HLS segment fetch
    // gap) shows a large positive value while media barely advances.
    const lag = now - prevWall - mediaAdvance;
    if (lag > BaseMediaStream.BLOCK_MS) this.recordBlock(lag);
  }

  private recordBlock(waitedMs: number) {
    if (!this._isLive) return;
    if (waitedMs < BaseMediaStream.BLOCK_MS) return;
    const now = performance.now();
    this._blockEvents.push({ at: now, waited: waitedMs });
    // A proven stall earns burst headroom for a while (see bufferCapMs).
    this._lastBlockWall = now;
    // Grow the target so the buffer covers the observed stall (plus margin).
    const candidate = waitedMs * 1.25 + 100;
    if (candidate > this._targetDelayMs) {
      this._targetDelayMs = Math.min(BaseMediaStream.MAX_TARGET_MS, candidate);
      this._lgBuffer.debug(
        { stats: { waited: waitedMs, target: this._targetDelayMs } },
        `Input blocked ${waitedMs.toFixed(0)}ms; target -> ${this._targetDelayMs.toFixed(0)}ms`,
      );
    }
  }

  /** Floor for target decay: blocking in the last minute keeps it high. */
  private decayFloor(now: number): number {
    while (
      this._blockEvents.length > 0 &&
      now - this._blockEvents[0].at > BaseMediaStream.BLOCK_WINDOW_MS
    ) {
      this._blockEvents.shift();
    }
    let floor = BaseMediaStream.MIN_TARGET_MS;
    for (const ev of this._blockEvents) {
      floor = Math.max(
        floor,
        Math.min(BaseMediaStream.MAX_TARGET_MS, ev.waited * 1.25 + 100),
      );
    }
    return floor;
  }

  private maybeDecayTarget(now: number) {
    if (!this._isLive) return;
    if (now - this._lastDecayTick < BaseMediaStream.DECAY_INTERVAL_MS) return;
    this._lastDecayTick = now;
    const floor = this.decayFloor(now);
    if (this._targetDelayMs > floor) {
      this._targetDelayMs = Math.max(
        floor,
        this._targetDelayMs - Math.max(100, this._targetDelayMs * 0.15),
      );
      this._lgBuffer.debug(
        { stats: { target: this._targetDelayMs, floor } },
        `Input stable; target -> ${this._targetDelayMs.toFixed(0)}ms`,
      );
    }
  }

  // --- rate controller ---

  /**
   * Estimated input speed (media ms per wall ms) over the trailing window,
   * or undefined when unknown: too few samples, or no fresh arrivals
   * (input idle, e.g. an HLS segment gap).
   */
  private get inputSpeed(): number | undefined {
    const s = this._speedSamples;
    if (s.length < 2) return undefined;
    const first = s[0];
    const last = s[s.length - 1];
    const wallSpan = last.wall - first.wall;
    if (wallSpan < BaseMediaStream.SPEED_MIN_SPAN_MS) return undefined;
    if (performance.now() - last.wall > BaseMediaStream.SPEED_FRESH_MS)
      return undefined;
    const mediaSpan = last.pts - first.pts;
    if (mediaSpan < 0) return undefined;
    return mediaSpan / wallSpan;
  }

  /**
   * Largest inter-arrival wall gap in the trailing gap window, or undefined
   * when too sparse to say. The window is deliberately short: a single
   * hold/release stall must stop vetoing speedup shortly after the writer
   * runs freely again, or hovering near the cap would lock the gate shut
   * (and the buffer high) permanently.
   */
  private get maxArrivalGap(): number | undefined {
    const s = this._speedSamples;
    const cutoff = performance.now() - BaseMediaStream.GAP_WINDOW_MS;
    let max = 0;
    let count = 0;
    let prev = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i].wall < cutoff) continue;
      if (prev >= 0) max = Math.max(max, s[i].wall - s[prev].wall);
      prev = i;
      count++;
    }
    return count >= 2 ? max : undefined;
  }

  /**
   * Proportional controller: steer the buffer level towards the target.
   *
   * Drain a buffered excess faster than realtime only when fresh arrivals
   * show a smooth ~realtime input (e.g. a live source after a startup
   * burst). Everything else (bursty/throttled arrivals, idle gaps, slower
   * input) paces at realtime; backpressure / the buffered media absorbs the
   * difference. Judging by buffer level alone would strand a transient
   * burst's latency in the buffer forever. (Sustained faster-than-realtime
   * input is out of scope: `isLive: false` (the default) pins this whole
   * controller at 1x.)
   */
  private updateOutputRate() {
    if (!this._isLive) {
      this._outputRate = 1;
      return;
    }
    const speed = this.inputSpeed;
    const gap = this.maxArrivalGap;
    const smoothRealtime =
      speed !== undefined &&
      speed >= BaseMediaStream.SPEED_SLOW &&
      speed <= BaseMediaStream.SPEED_FAST &&
      (gap === undefined || gap < BaseMediaStream.DRAIN_MAX_GAP_MS);
    const maxRate = smoothRealtime ? BaseMediaStream.MAX_RATE_DRAIN : 1;
    const desired =
      1 + (this._bufferedMs - this._targetDelayMs) / BaseMediaStream.RATE_TC_MS;
    // Smooth to avoid oscillation; the buffer integrates the rate anyway.
    const clamped = Math.min(
      maxRate,
      Math.max(BaseMediaStream.MIN_RATE, desired),
    );
    this._outputRate += (clamped - this._outputRate) * 0.15;
  }

  // --- A/V sync ---

  /** Whether an enabled master clock is still producing output. */
  private get syncMasterActive(): boolean {
    const master = this._syncStream;
    return (
      this._sync &&
      master !== undefined &&
      !master._destroyedByUs &&
      !master._playoutFinished
    );
  }

  private get ptsDelta(): number | undefined {
    const master = this._syncStream;
    if (this._pts === undefined || master?.pts === undefined) return undefined;
    return this._pts - master.pts;
  }

  /**
   * Gradual A/V sync: a *rate* multiplier applied on top of the buffer
   * controller, never a clock jump. Outside the tolerance band the playout
   * runs proportionally slower (ahead of the master) or faster (behind),
   * bounded to MAX_SYNC_SKEW, so the media-time offset decays smoothly
   * (time constant SYNC_TC_MS) instead of being corrected in frametime-
   * sized sleeps or by dropping the whole accumulated debt at once.
   */
  private syncSkew(): number {
    const delta = this.syncMasterActive ? this.ptsDelta : undefined;
    const correcting =
      delta !== undefined && Math.abs(delta) > this._syncTolerance;
    if (correcting !== this._syncEngaged) {
      this._syncEngaged = correcting;
      this._lgSync.debug(
        { stats: { pts: this._pts, pts_other: this._syncStream?.pts } },
        correcting ? "Sync correction engaged" : "Sync correction released",
      );
    }
    if (!correcting || delta === undefined) return 1;
    const skew = Math.min(
      (Math.abs(delta) - this._syncTolerance) / BaseMediaStream.SYNC_TC_MS,
      BaseMediaStream.MAX_SYNC_SKEW,
    );
    return delta > 0 ? 1 - skew : 1 + skew;
  }

  private resetClock() {
    this._nextPlayoutTime = undefined;
    this._outputRate = 1;
  }

  // --- playout loop ---

  /** Resolve on wakeup, or after `timeoutMs` when given. */
  private wait(timeoutMs?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const resume = () => {
        if (settled) return;
        settled = true;
        if (this._wake === resume) this._wake = undefined;
        resolve();
      };
      this._wake = resume;
      if (timeoutMs !== undefined) void setTimeout(timeoutMs).then(resume);
    });
  }

  private wakeup() {
    this._wake?.();
  }

  private startPlayoutLoop() {
    if (this._loopStarted) return;
    this._loopStarted = true;
    this._loopDone = this.playoutLoop().catch(() => {});
  }

  private async sendAndReport(frame: QueuedFrame) {
    const sendStart = performance.now();
    await this._sendFrame(frame.data, frame.frametime);
    this.reportSend(frame, performance.now() - sendStart);
  }

  private async playoutLoop(): Promise<void> {
    try {
      // Initial buffering: don't start the clock until roughly one target
      // worth of media is available (bounded wait so sparse live inputs
      // still start promptly).
      const deadline = performance.now() + 250;
      while (
        !this._noSleep &&
        !this._destroyedByUs &&
        !this._upstreamEnded &&
        this._bufferedMs < this._targetDelayMs &&
        performance.now() < deadline
      ) {
        await this.wait(50);
      }

      while (!this._destroyedByUs) {
        if (this._queue.size === 0) {
          if (this._upstreamEnded) break;
          const starvedAt = performance.now();
          while (
            this._queue.size === 0 &&
            !this._upstreamEnded &&
            !this._destroyedByUs
          ) {
            await this.wait();
          }
          if (this._destroyedByUs || this._queue.size === 0) break;
          const waited = performance.now() - starvedAt;
          if (waited > BaseMediaStream.BLOCK_MS) this.recordBlock(waited);
          // Resume immediately (no re-buffering stall); the grown target
          // slows the clock down via the rate controller to rebuild.
          this._nextPlayoutTime ??= performance.now();
          continue;
        }

        const frame = this._queue.dequeue()!;
        this._bufferedMs = Math.max(0, this._bufferedMs - frame.frametime);
        this.releaseBackpressure();

        const now = performance.now();
        this._nextPlayoutTime ??= now;

        if (this._noSleep) {
          await this.sendAndReport(frame);
          // Keep the clock disengaged while pacing is bypassed so it
          // re-anchors cleanly when pacing resumes.
          this._nextPlayoutTime = undefined;
        } else {
          this.updateOutputRate();
          this.maybeDecayTarget(now);
          const rate = Math.min(
            BaseMediaStream.MAX_RATE_DRAIN,
            this._outputRate * this.syncSkew(),
          );

          let due = this._nextPlayoutTime - now;
          if (due < -500) {
            // Hopelessly late (event loop stall, slow send): drop debt
            // instead of bursting to catch up.
            this._lgSleep.debug(
              { stats: { lateBy: -due } },
              "Playout is late. Re-anchoring clock",
            );
            this._nextPlayoutTime = now;
            due = 0;
          }
          if (due > 0) {
            this._lgSleep.debug(
              {
                stats: {
                  pts: frame.pts,
                  rate,
                  buffered: this._bufferedMs,
                  target: this._targetDelayMs,
                },
              },
              `Sleeping for ${due.toFixed(2)}ms at ${rate.toFixed(3)}x`,
            );
            await setTimeout(due);
            if (this._destroyedByUs) return;
          }

          await this.sendAndReport(frame);
          this._nextPlayoutTime += frame.frametime / rate;
        }

        this._pts = frame.pts;
        this.emit("pts", this._pts);
      }
    } finally {
      this._playoutFinished = true;
      this.wakeup();
      // Unblock any writers stuck in backpressure so _final can complete.
      const held = this._heldCallbacks;
      this._heldCallbacks = [];
      for (const cb of held) cb(null);
    }
  }

  private reportSend(frame: QueuedFrame, sendTime: number) {
    const ratio = frame.frametime > 0 ? sendTime / frame.frametime : 0;
    this._lgSend.debug(
      {
        stats: {
          pts: frame.pts,
          frame_size: frame.data.length,
          duration: sendTime,
          frametime: frame.frametime,
        },
      },
      `Frame sent in ${sendTime.toFixed(2)}ms (${(ratio * 100).toFixed(2)}% frametime)`,
    );
    if (ratio <= 1) {
      this._slowSends = 0;
      return;
    }
    if (++this._slowSends > 10) {
      this._lgSend.warn(
        {
          frame_size: frame.data.length,
          duration: sendTime,
          frametime: frame.frametime,
        },
        `Frame takes too long to send (${(ratio * 100).toFixed(2)}% frametime)`,
      );
    }
  }

  // --- stream implementation ---

  async _write(
    frame: Packet,
    _: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    const arrival = performance.now();
    const { data, pts, duration, timeBase } = frame;
    if (!data) {
      frame.free();
      callback();
      return;
    }

    let frametime = (Number(duration) / timeBase.den) * timeBase.num * 1000;
    if (!Number.isFinite(frametime) || frametime <= 0) {
      frametime = this._lastFrametime;
    } else {
      this._lastFrametime = frametime;
    }

    let ptsMs = (Number(pts) / timeBase.den) * timeBase.num * 1000;
    if (!Number.isFinite(ptsMs)) {
      ptsMs = (this._pts ?? 0) + frametime;
    }

    this.observeArrival(arrival, ptsMs);
    if (this._destroyedByUs) {
      frame.free();
      callback();
      return;
    }

    this._queue.enqueue({
      data: Buffer.from(data),
      pts: ptsMs,
      frametime,
    });
    this._bufferedMs += frametime;
    frame.free();

    this.startPlayoutLoop();
    this.wakeup();

    // Hold the writer once buffered media exceeds the cap: throttles
    // ahead-of-realtime input down to ~1x and absorbs bursty (HLS) input
    // without unbounded growth.
    if (this._bufferedMs > this.bufferCapMs) {
      this._backpressureWaits++;
      this._heldCallbacks.push(callback);
    } else {
      callback(null);
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    this._upstreamEnded = true;
    this.startPlayoutLoop();
    this.wakeup();
    void (async () => {
      try {
        await this._loopDone;
        callback(null);
      } catch (e) {
        callback(e as Error);
      }
    })();
  }

  _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this._destroyedByUs = true;
    this._upstreamEnded = true;
    this.wakeup();
    this._queue.clear();
    this._bufferedMs = 0;
    const held = this._heldCallbacks;
    this._heldCallbacks = [];
    for (const cb of held) cb(null);
    super._destroy(error, callback);
    this.syncStream = undefined;
  }
}
