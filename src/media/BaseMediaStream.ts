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

type BlockEvent = {
  at: number;
  waited: number;
};

/**
 * Jitter-buffer style pacer for media output.
 *
 * Instead of assuming the input always arrives faster than real-time and
 * blindly sleeping until the next PTS is due, this implementation observes
 * the *input pacing* (packet arrival times vs. media timestamps) and adapts
 * two things:
 *
 * 1. `targetDelay` - the desired jitter buffer level (in media ms). It starts
 *    small (<50ms) and only grows when the output actually starves, i.e. the
 *    playout loop has to wait for input. True live sources (RTSP/RTMP) and
 *    fast files (VOD) never starve a small buffer, so they keep a low
 *    (<50ms) buffer. Bursty pseudo-live sources (HLS) stall for whole segment
 *    durations, so the buffer grows until it covers (at least) one segment.
 *    The target slowly decays back towards a floor derived from recently
 *    observed blocking, so transient stalls don't permanently add latency.
 * 2. `outputRate` - a speed factor applied to the output clock. When the
 *    buffer holds more media than the target the clock runs slightly fast,
 *    when it holds less it runs slightly slow. Speedup past realtime is
 *    only used when fresh arrivals show the input running at ~realtime
 *    (e.g. draining a live source's startup burst); a sustained
 *    faster-than-realtime input is paced at realtime instead and throttled
 *    via backpressure. This keeps the buffer centred on the target without
 *    ever needing to know what kind of source is attached.
 *
 * Backpressure is applied once the buffered media exceeds the target by a
 * margin, which throttles fast (VOD/file) inputs down to ~1x media speed.
 * The margin shrinks once the input proves sustained faster-than-realtime,
 * keeping steady-state pipeline latency low; bursty/idle inputs keep a
 * larger headroom. Intermediate stream buffers are kept shallow on purpose
 * so this media-time-aware queue stays the single governor of latency.
 *
 * A/V sync is layered on top: a stream with `syncStream` set treats the
 * other stream as the master clock (in practice video syncs to audio) and
 * stretches/shrinks its own playout delay to stay within `syncTolerance`.
 */
export class BaseMediaStream extends Writable {
  private _pts?: number;
  private _syncTolerance = 20;
  private _loggerSend: Log;
  private _loggerSync: Log;
  private _loggerSleep: Log;
  private _loggerBuffer: Log;

  private _noSleep: boolean;
  private _sync = true;
  private _syncStream?: BaseMediaStream;

  // --- Jitter buffer state ---
  private readonly _queue = new Queue<QueuedFrame>();
  /** Media time currently buffered, in milliseconds */
  private _bufferedMs = 0;
  /** Desired buffer level, in milliseconds. Adapted at runtime. */
  private _targetDelayMs: number;
  /** Smoothed output speed factor. >1 drains the buffer, <1 fills it. */
  private _outputRate = 1;
  /** Wall-clock time (performance.now) the next frame is due. */
  private _nextPlayoutTime?: number;
  private _lastFrametime = 20;

  // --- Input observation state ---
  private _lastArrivalWall?: number;
  private _lastArrivalPts?: number;
  /** Trailing (wall, pts) samples used to estimate input speed. */
  private _speedSamples: { wall: number; pts: number }[] = [];
  /**
   * Wall time of the last genuine input stall (block event). Recent stalls
   * prove the input needs burst headroom; otherwise the margin stays lean
   * so steady-state pipeline latency (e.g. volume-command latency) stays low.
   */
  private _lastBlockWall = 0;
  private _blockEvents: BlockEvent[] = [];
  private _lastDecayTick = performance.now();

  // --- Playout loop lifecycle ---
  private _upstreamEnded = false;
  private _playoutFinished = false;
  private _destroyedByUs = false;
  private _loopStarted = false;
  private _loopDone: Promise<void> | undefined;
  private _wakeLoop: (() => void) | undefined;

  // --- Backpressure (held _write callbacks while over cap) ---
  private _heldCallbacks: ((error?: Error | null) => void)[] = [];
  private _backpressureWaits = 0;
  /**
   * Wall-clock time of the last backpressure release. Gaps in _write()
   * invocations that overlap a period where we held the writer measure our
   * own throttling, not input blocking, and are ignored by observeArrival().
   */
  private _lastBpRelease = 0;

  private _frameSendDeadlineExceededCount = 0;

  private static readonly MIN_TARGET_MS = 30;
  private static readonly MAX_TARGET_MS = 15_000;
  private static readonly MIN_CAP_MS = 500;
  private static readonly MAX_CAP_MS = 30_000;
  /**
   * Burst headroom above the target, granted only after genuine input stalls
   * proved it necessary (HLS segment gaps, jittery live). Otherwise the lean
   * base margin applies so steady-state latency stays low from the start.
   */
  private static readonly CAP_MARGIN_MS = 4_000;
  /** Lean base headroom: just enough for the rate controller to work with. */
  private static readonly CAP_MARGIN_LOW_MS = 500;
  /** How long a stall keeps the large headroom before it decays. */
  private static readonly MARGIN_HOLD_MS = 10_000;
  /** Waits longer than this while starved count as input blocking. */
  private static readonly BLOCK_EVENT_THRESHOLD_MS = 250;
  /** Starvation shorter than this is treated as normal jitter, not blocking. */
  private static readonly UNDERFLOW_THRESHOLD_MS = 150;
  private static readonly MIN_RATE = 0.85;
  /** Max rate used to drain a buffered excess back towards the target. */
  private static readonly MAX_RATE_DRAIN = 1.5;
  /** Proportional control time constant: error / this => rate offset. */
  private static readonly RATE_TIME_CONSTANT_MS = 1_000;
  /** Trailing window over which input speed is estimated. Kept short so a
   * startup burst stops dominating the estimate quickly once the input
   * settles (burst samples age out within one window). */
  private static readonly SPEED_WINDOW_MS = 750;
  /** Minimum wall span needed for a usable speed estimate. */
  private static readonly SPEED_MIN_SPAN_MS = 200;
  /**
   * Arrivals are trusted for speedup only below this inter-arrival gap.
   * Throttled input runs at release pace (bursts + long stalls), so its
   * average can masquerade as realtime while its gaps give it away.
   */
  private static readonly DRAIN_MAX_GAP_MS = 300;
  /** Arrivals older than this are stale; speed is unknown during gaps. */
  private static readonly SPEED_FRESH_MS = 500;
  /** Above this input speed the input is faster than realtime (VOD-like). */
  private static readonly SPEED_FAST = 1.3;
  /** Below this input speed the input is slower than realtime. */
  private static readonly SPEED_SLOW = 0.8;
  private static readonly DECAY_INTERVAL_MS = 5_000;
  private static readonly BLOCK_WINDOW_MS = 60_000;

  constructor(type: string, noSleep = false) {
    // Small object count: this stream's media-time-aware queue (plus
    // backpressure) is the single governor of buffering. A deep Writable
    // buffer would park seconds of media invisibly inside the stream and
    // inflate pipeline latency (e.g. volume-command latency on VOD).
    super({ objectMode: true, highWaterMark: 16 });
    this._loggerSend = new Log(`stream:${type}:send`);
    this._loggerSync = new Log(`stream:${type}:sync`);
    this._loggerSleep = new Log(`stream:${type}:sleep`);
    this._loggerBuffer = new Log(`stream:${type}:buffer`);
    this._noSleep = noSleep;
    this._targetDelayMs = BaseMediaStream.MIN_TARGET_MS;
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
  /** Current adaptive jitter buffer target, in milliseconds. */
  get targetDelay(): number {
    return this._targetDelayMs;
  }
  /** Current smoothed output speed factor. */
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

  private get ptsDelta() {
    if (this.pts !== undefined && this.syncStream?.pts !== undefined)
      return this.pts - this.syncStream.pts;
    return undefined;
  }

  /** Whether the master clock is still producing output to sync against. */
  private get syncMasterActive() {
    const master = this._syncStream;
    return (
      master !== undefined && !master._destroyedByUs && !master._playoutFinished
    );
  }

  private resetTimingCompensation() {
    this._nextPlayoutTime = undefined;
    this._outputRate = 1;
  }

  private get capMarginMs(): number {
    // Large headroom only shortly after a proven stall (bursty/idle input
    // needs room to absorb bursts and ride out gaps). Otherwise stay lean:
    // steady-state pipeline latency (and e.g. volume-command latency) is set
    // by how much media we allow to stand, so a fast input is throttled
    // close to the target from the very start.
    if (
      this._lastBlockWall !== 0 &&
      performance.now() - this._lastBlockWall <
        BaseMediaStream.MARGIN_HOLD_MS
    ) {
      return BaseMediaStream.CAP_MARGIN_MS;
    }
    return BaseMediaStream.CAP_MARGIN_LOW_MS;
  }

  private get bufferCapMs() {
    return Math.min(
      BaseMediaStream.MAX_CAP_MS,
      Math.max(BaseMediaStream.MIN_CAP_MS, this._targetDelayMs + this.capMarginMs),
    );
  }

  private wakePlayoutLoop() {
    this._wakeLoop?.();
    this._wakeLoop = undefined;
  }

  private waitForWakeOrTimeout(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const mine = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this._wakeLoop = mine;
      void setTimeout(ms).then(() => {
        // Only clear/expire our own waiter; a newer waiter may exist if
        // wake and timeout raced.
        if (this._wakeLoop === mine && !settled) {
          settled = true;
          this._wakeLoop = undefined;
          resolve();
        }
      });
    });
  }

  private observeArrival(now: number, pts: number) {
    const lastWall = this._lastArrivalWall;
    const lastPts = this._lastArrivalPts;
    this._lastArrivalWall = now;
    this._lastArrivalPts = pts;
    if (lastWall === undefined || lastPts === undefined) return;
    if (!Number.isFinite(pts)) return;
    // A _write() gap that overlaps a period where we held the writer back
    // ourselves (backpressure) measures our own throttling, not the input.
    // Only gaps observed while the writer ran freely say anything about
    // input pacing.
    if (this._heldCallbacks.length > 0 || lastWall < this._lastBpRelease)
      return;
    const mediaAdvance = pts - lastPts;
    // A discontinuity (seek, track switch) resets the observation baseline
    // instead of polluting it.
    if (Math.abs(mediaAdvance) > 30_000) {
      this._speedSamples.length = 0;
      return;
    }
    // Trailing window for input-speed estimation.
    this._speedSamples.push({ wall: now, pts });
    while (
      this._speedSamples.length > 1 &&
      now - this._speedSamples[0].wall > BaseMediaStream.SPEED_WINDOW_MS
    ) {
      this._speedSamples.shift();
    }
    const wallGap = now - lastWall;
    // How far the input fell behind the media timeline between these two
    // packets. Steady/fast inputs (live, VOD) sit at ~0 or below; a bursty
    // input (HLS segment fetch gap) shows a large positive value while the
    // media timeline barely advanced.
    const lag = wallGap - mediaAdvance;
    if (lag > BaseMediaStream.BLOCK_EVENT_THRESHOLD_MS) {
      this.recordBlockEvent(lag);
    }
  }

  private recordBlockEvent(waitedMs: number) {
    if (waitedMs < BaseMediaStream.BLOCK_EVENT_THRESHOLD_MS) return;
    const now = performance.now();
    this._blockEvents.push({ at: now, waited: waitedMs });
    // A proven stall earns burst headroom for a while (see capMarginMs).
    this._lastBlockWall = now;
    // Grow the target so the buffer covers the observed stall (plus margin),
    // e.g. a full HLS segment fetch gap.
    const candidate = waitedMs * 1.25 + 100;
    if (candidate > this._targetDelayMs) {
      this._targetDelayMs = Math.min(BaseMediaStream.MAX_TARGET_MS, candidate);
      this._loggerBuffer.debug(
        {
          stats: {
            waited: waitedMs,
            target: this._targetDelayMs,
          },
        },
        `Input blocked for ${waitedMs.toFixed(0)}ms. Growing jitter buffer to ${this._targetDelayMs.toFixed(0)}ms`,
      );
    }
  }

  private pruneBlockEvents(now: number) {
    while (
      this._blockEvents.length > 0 &&
      now - this._blockEvents[0].at > BaseMediaStream.BLOCK_WINDOW_MS
    ) {
      this._blockEvents.shift();
    }
  }

  /** Floor for target decay: recent blocking keeps the target high. */
  private decayFloor(now: number) {
    this.pruneBlockEvents(now);
    let floor = BaseMediaStream.MIN_TARGET_MS;
    for (const ev of this._blockEvents) {
      if (ev.waited < BaseMediaStream.BLOCK_EVENT_THRESHOLD_MS) continue;
      floor = Math.max(
        floor,
        Math.min(BaseMediaStream.MAX_TARGET_MS, ev.waited * 1.25 + 100),
      );
    }
    return floor;
  }

  private maybeDecayTarget(now: number) {
    if (now - this._lastDecayTick < BaseMediaStream.DECAY_INTERVAL_MS) return;
    this._lastDecayTick = now;
    const floor = this.decayFloor(now);
    if (this._targetDelayMs > floor) {
      this._targetDelayMs = Math.max(
        floor,
        this._targetDelayMs - Math.max(100, this._targetDelayMs * 0.15),
      );
      this._loggerBuffer.debug(
        { stats: { target: this._targetDelayMs, floor } },
        `Input stable. Decaying jitter buffer to ${this._targetDelayMs.toFixed(0)}ms`,
      );
    }
  }

  /**
   * Estimated input speed (media ms per wall-clock ms) over the trailing
   * window, or undefined when unknown: too few samples, or no fresh
   * arrivals (input idle, e.g. an HLS segment gap).
   */
  private get inputSpeed(): number | undefined {
    const samples = this._speedSamples;
    if (samples.length < 2) return undefined;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const wallSpan = last.wall - first.wall;
    if (wallSpan < BaseMediaStream.SPEED_MIN_SPAN_MS) return undefined;
    if (performance.now() - last.wall > BaseMediaStream.SPEED_FRESH_MS)
      return undefined;
    const mediaSpan = last.pts - first.pts;
    if (mediaSpan < 0) return undefined;
    return mediaSpan / wallSpan;
  }

  /**
   * Largest inter-arrival wall gap in the trailing window, or undefined when
   * too sparse to say. Bursty or throttled input shows large gaps even when
   * its average speed reads realtime.
   */
  private get maxArrivalGap(): number | undefined {
    const samples = this._speedSamples;
    if (samples.length < 2) return undefined;
    let max = 0;
    for (let i = 1; i < samples.length; i++) {
      max = Math.max(max, samples[i].wall - samples[i - 1].wall);
    }
    return max;
  }

  /** Proportional controller: steer the buffer level towards the target. */
  private updateOutputRate() {
    const excess = this._bufferedMs - this._targetDelayMs;
    const speed = this.inputSpeed;
    // Drain a buffered excess faster than realtime only when fresh arrivals
    // show a smooth ~realtime input (e.g. a live source after an initial
    // burst). A sustained faster-than-realtime input (VOD), a slower input,
    // idle gaps, or bursty/throttled arrivals (large inter-arrival gaps give
    // those away even when their average reads realtime) pace at realtime
    // instead; backpressure / the buffered media absorbs the difference.
    // Judging by buffer level alone would strand a transient burst's latency
    // in the buffer forever, mistaking a live stream for VOD.
    const gap = this.maxArrivalGap;
    const realtimeInput =
      speed !== undefined &&
      speed >= BaseMediaStream.SPEED_SLOW &&
      speed <= BaseMediaStream.SPEED_FAST &&
      (gap === undefined || gap < BaseMediaStream.DRAIN_MAX_GAP_MS);
    const maxRate = realtimeInput ? BaseMediaStream.MAX_RATE_DRAIN : 1;
    let desired = 1 + excess / BaseMediaStream.RATE_TIME_CONSTANT_MS;
    desired = Math.min(maxRate, Math.max(BaseMediaStream.MIN_RATE, desired));
    // Smooth to avoid oscillation; the buffer integrates the rate anyway.
    this._outputRate += (desired - this._outputRate) * 0.15;
  }

  /**
   * Extra delay (ms) to stay in sync with the master stream.
   * Positive => this stream is ahead and must wait.
   * Negative => this stream is behind and must skip sleeping.
   */
  private syncCorrection(): number | undefined {
    if (!this._sync || !this.syncMasterActive) return undefined;
    const delta = this.ptsDelta;
    if (delta === undefined) return undefined;
    if (delta > this._syncTolerance) {
      // Ahead of master: trim a fraction of the lead per frame so the
      // slave eases back into the tolerance band without oscillation.
      // (Correcting the full lead every frame would over-brake and swing
      // the slave behind instead.)
      return Math.min(delta * 0.5, 250);
    }
    if (delta < -this._syncTolerance) {
      // Behind master: don't sleep, drop accumulated debt.
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
      return Number.NEGATIVE_INFINITY;
    }
    return 0;
  }

  private async waitForData(): Promise<boolean> {
    // Returns true when there is data to play, false when the loop should
    // terminate (upstream ended and drained, or destroyed).
    while (
      this._queue.size === 0 &&
      !this._upstreamEnded &&
      !this._destroyedByUs
    ) {
      await new Promise<void>((resolve) => {
        this._wakeLoop = resolve;
      });
      this._wakeLoop = undefined;
    }
    return this._queue.size > 0;
  }

  private releaseBackpressure() {
    if (this._heldCallbacks.length === 0) return;
    // Hysteresis: only release once drained comfortably below the cap.
    if (this._bufferedMs > this.bufferCapMs * 0.7) return;
    const cbs = this._heldCallbacks;
    this._heldCallbacks = [];
    this._lastBpRelease = performance.now();
    for (const cb of cbs) cb(null);
  }

  private startPlayoutLoop() {
    if (this._loopStarted) return;
    this._loopStarted = true;
    this._loopDone = this.playoutLoop().catch(() => {});
  }

  private async playoutLoop(): Promise<void> {
    try {
      // Initial buffering: don't start the clock until roughly one target
      // worth of media is available (bounded wait so sparse live inputs
      // still start promptly).
      if (
        !this._noSleep &&
        !this._destroyedByUs &&
        !this._upstreamEnded &&
        this._bufferedMs < this._targetDelayMs
      ) {
        const deadline = performance.now() + 250;
        while (
          !this._destroyedByUs &&
          !this._upstreamEnded &&
          this._bufferedMs < this._targetDelayMs &&
          performance.now() < deadline
        ) {
          await this.waitForWakeOrTimeout(50);
        }
      }

      while (!this._destroyedByUs) {
        if (this._queue.size === 0) {
          if (this._upstreamEnded) break;
          const starvedAt = performance.now();
          const ok = await this.waitForData();
          if (!ok || this._destroyedByUs) break;
          if (this._upstreamEnded && this._queue.size === 0) break;
          const waited = performance.now() - starvedAt;
          if (
            this._queue.size > 0 &&
            waited > BaseMediaStream.UNDERFLOW_THRESHOLD_MS
          ) {
            // Playout starved: the buffer was too small for this input.
            this.recordBlockEvent(waited);
          }
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

        if (!this._noSleep) {
          this.updateOutputRate();
          this.maybeDecayTarget(now);

          let correction = this.syncCorrection();
          if (correction === Number.NEGATIVE_INFINITY) {
            // Behind master: send immediately, clock re-anchored above.
            correction = undefined;
            this._nextPlayoutTime = now;
          }

          let due = this._nextPlayoutTime - now + (correction ?? 0);
          if (due < -500) {
            // Hopelessly late (event loop stall, slow send): drop debt
            // instead of bursting to catch up.
            this._loggerSleep.debug(
              { stats: { lateBy: -due } },
              "Playout is late. Re-anchoring clock",
            );
            this._nextPlayoutTime = now;
            due = correction !== undefined && correction > 0 ? correction : 0;
          }
          if (due > 0) {
            this._loggerSleep.debug(
              {
                stats: {
                  pts: frame.pts,
                  rate: this._outputRate,
                  buffered: this._bufferedMs,
                  target: this._targetDelayMs,
                },
              },
              `Sleeping for ${due.toFixed(2)}ms at ${this._outputRate.toFixed(3)}x`,
            );
            await setTimeout(due);
            if (this._destroyedByUs) return;
          }

          const sendStart = performance.now();
          await this._sendFrame(frame.data, frame.frametime);
          const sendTime = performance.now() - sendStart;
          this.reportSend(frame, sendTime);

          this._nextPlayoutTime += frame.frametime / this._outputRate;
        } else {
          const sendStart = performance.now();
          await this._sendFrame(frame.data, frame.frametime);
          const sendTime = performance.now() - sendStart;
          this.reportSend(frame, sendTime);
          // Keep the clock disengaged while pacing is bypassed so it
          // re-anchors cleanly when pacing resumes.
          this._nextPlayoutTime = undefined;
        }

        this._pts = frame.pts;
        this.emit("pts", this._pts);
      }
    } finally {
      this._playoutFinished = true;
      this.wakePlayoutLoop();
      // Unblock any writers stuck in backpressure so _final can complete.
      const cbs = this._heldCallbacks;
      this._heldCallbacks = [];
      if (cbs.length > 0) this._lastBpRelease = performance.now();
      for (const cb of cbs) cb(null);
    }
  }

  private reportSend(frame: QueuedFrame, sendTime: number) {
    const ratio = frame.frametime > 0 ? sendTime / frame.frametime : 0;
    this._loggerSend.debug(
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
    if (ratio > 1) {
      this._frameSendDeadlineExceededCount++;
      if (this._frameSendDeadlineExceededCount > 10)
        this._loggerSend.warn(
          {
            frame_size: frame.data.length,
            duration: sendTime,
            frametime: frame.frametime,
          },
          `Frame takes too long to send (${(ratio * 100).toFixed(2)}% frametime)`,
        );
    } else {
      this._frameSendDeadlineExceededCount = 0;
    }
  }

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
    this.wakePlayoutLoop();

    // Backpressure: hold the writer once buffered media exceeds the cap.
    // This throttles faster-than-realtime inputs (VOD) down to ~1x and
    // absorbs bursty (HLS) input without unbounded growth.
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
    this.wakePlayoutLoop();
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
    this.wakePlayoutLoop();
    this._queue.clear();
    this._bufferedMs = 0;
    const cbs = this._heldCallbacks;
    this._heldCallbacks = [];
    for (const cb of cbs) cb(null);
    super._destroy(error, callback);
    this.syncStream = undefined;
  }
}
