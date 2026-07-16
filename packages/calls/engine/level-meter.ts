/**
 * Per-track audio-level metering driving the UI's speaking rings.
 *
 * Pure TS, no DOM/React imports: the real Web Audio `AnalyserNode` is
 * constructed by `bridge/index.ts` (the layer allowed to touch
 * `AudioContext`) and handed in as an {@link AnalyserLike} — same injection
 * discipline as `audio-call.ts`. {@link TrackLevelMeter} polls on
 * `setInterval` (NOT `requestAnimationFrame`, a DOM/window API; `setInterval`
 * exists in Node too so `node --test` can run this) and applies an EMA so a
 * CSS-driven ring doesn't jitter frame to frame. Timers are injectable for
 * deterministic tests.
 */

/**
 * The subset of a real Web Audio `AnalyserNode` the meter needs. A real
 * `AnalyserNode` is structurally assignable to this; so is a test fake.
 */
export interface AnalyserLike {
  /** Determines the byte buffer size the meter allocates (`fftSize` samples). */
  readonly fftSize: number;
  /** Fills `array` with the current time-domain waveform (0..255, centered
   * on 128) — same contract as `AnalyserNode.getByteTimeDomainData`. */
  getByteTimeDomainData(array: Uint8Array): void;
}

/** Perceptual gain applied to raw RMS before the noise gate + clamp to 0..1.
 * Speech RMS on a raw 0..255 time-domain buffer is typically small (a
 * normal-volume voice rarely pushes the full-scale RMS much past ~0.15-0.2),
 * so an un-boosted ring would look almost dark during normal talking; this
 * multiplier is tuned so normal speaking volume reads as a clearly-lit ring
 * while near silence stays dark. */
export const DEFAULT_LEVEL_GAIN = 9;

/** Noise gate applied AFTER {@link DEFAULT_LEVEL_GAIN} (in the same boosted
 * 0..1 space): ambient room noise would otherwise light the ring when nobody
 * talks. At or below the floor → exactly 0; above it, rescaled
 * `(x - gate)/(1 - gate)` so real speech still spans the full range. Scaled
 * with the gain so the raw-RMS silence floor stays constant (gate / gain
 * ≈ 0.01 raw RMS) as the gain is tuned. */
export const DEFAULT_LEVEL_NOISE_GATE = 0.09;

/** Poll interval. 10Hz is smooth enough for a CSS-animated ring and cheap
 * enough to run per-track for the lifetime of a call. */
export const DEFAULT_LEVEL_INTERVAL_MS = 100;

/** Exponential-moving-average smoothing factor (0..1, weight kept from the
 * previous sample). Higher = smoother/slower to react. */
export const DEFAULT_LEVEL_SMOOTHING = 0.5;

/**
 * Pure RMS level from a Web-Audio time-domain byte buffer (0..255, silence
 * centered on 128). Returns 0..1: RMS → `× gain` → noise gate → clamp.
 * An empty buffer returns 0 rather than dividing by zero. `gain`/`noiseGate`
 * params exist so tests can pin the gate boundary exactly.
 */
export function computeRmsLevel(
  timeDomainData: Uint8Array,
  gain: number = DEFAULT_LEVEL_GAIN,
  noiseGate: number = DEFAULT_LEVEL_NOISE_GATE
): number {
  const { length } = timeDomainData;
  if (length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < length; i++) {
    const normalized = (timeDomainData[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / length);
  const boosted = rms * gain;
  const gate = Math.min(Math.max(noiseGate, 0), 0.999);
  if (boosted <= gate) return 0;
  const rescaled = (boosted - gate) / (1 - gate);
  return Math.min(1, Math.max(0, rescaled));
}

export interface TrackLevelMeterOptions {
  /** The (bridge-constructed) analyser tapping this track's audio. */
  analyser: AnalyserLike;
  /** Called with the smoothed 0..1 level on every sample, including the
   * synchronous one taken by {@link TrackLevelMeter.start}. */
  onLevel?(level: number): void;
  /** Injectable timer, default global `setInterval`. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  /** Injectable timer, default global `clearInterval`. */
  clearIntervalFn?: (handle: unknown) => void;
}

/**
 * Polls one {@link AnalyserLike} and exposes a smoothed 0..1 level, both via
 * {@link level}/{@link sample} (pull) and `onLevel` (push). One instance per
 * metered track (local + remote — the bridge owns two).
 *
 * Not started automatically: call {@link start} once the track is live and
 * {@link stop} on teardown, so a torn-down call can't leave a poll loop
 * running against a disconnected analyser.
 */
export class TrackLevelMeter {
  private readonly analyser: AnalyserLike;
  private readonly buffer: Uint8Array;
  private readonly onLevelCb: ((level: number) => void) | undefined;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private handle: unknown = null;
  private currentLevel = 0;

  constructor(options: TrackLevelMeterOptions) {
    this.analyser = options.analyser;
    // fftSize may be 0/undefined on a pathological fake; guard so the
    // allocation never throws (RangeError on a negative/NaN length).
    const size = Number.isFinite(this.analyser.fftSize) && this.analyser.fftSize > 0
      ? this.analyser.fftSize
      : 32;
    this.buffer = new Uint8Array(size);
    this.onLevelCb = options.onLevel;
    this.setIntervalFn = options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h as never));
  }

  /** The most recently computed smoothed level (0..1). 0 before the first sample. */
  get level(): number {
    return this.currentLevel;
  }

  /** Whether {@link start} has been called without a matching {@link stop}. */
  get isRunning(): boolean {
    return this.handle != null;
  }

  /**
   * Begin polling. Idempotent. Takes one sample synchronously so
   * `level`/`onLevel` reflect something before the first interval tick.
   */
  start(): void {
    if (this.handle != null) return;
    this.sample();
    this.handle = this.setIntervalFn(() => this.sample(), DEFAULT_LEVEL_INTERVAL_MS);
  }

  /** Stop polling. Idempotent. Does NOT reset `level` — the last known level
   * stays readable until the caller discards this instance. */
  stop(): void {
    if (this.handle == null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /** Take one reading now (also what the interval calls). Exposed so tests
   * don't have to wait on the injected timer. */
  sample(): number {
    this.analyser.getByteTimeDomainData(this.buffer);
    const raw = computeRmsLevel(this.buffer);
    this.currentLevel =
      this.currentLevel * DEFAULT_LEVEL_SMOOTHING + raw * (1 - DEFAULT_LEVEL_SMOOTHING);
    this.onLevelCb?.(this.currentLevel);
    return this.currentLevel;
  }
}
