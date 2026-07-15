/**
 * Per-track audio-level metering (M2, docs/calls.md: "Web-Audio level meters
 * driving avatar rings (local + remote)"). Framework-agnostic, pure TS — no
 * DOM/React imports, same discipline as `audio-call.ts` and
 * `ice-gathering.ts`: the platform object that actually taps the audio graph
 * (a real Web Audio `AnalyserNode`, wired to a `MediaStreamAudioSourceNode`)
 * is constructed OUTSIDE this file — by `bridge/index.ts`, the layer allowed
 * to reach for `AudioContext`/`navigator` — and handed in here as an
 * {@link AnalyserLike}. That mirrors how `audio-call.ts` never calls
 * `getUserMedia`/`new RTCPeerConnection` directly and instead takes
 * `AudioCallMediaFactories`.
 *
 * `AnalyserNode`/`AudioContext` are ambient "DOM" lib *types* (like
 * `RTCPeerConnection` elsewhere in engine/) — referencing the type below adds
 * no import and does not violate the engine/ui boundary; only actually
 * constructing one would, so we don't.
 *
 * ── DESIGN ─────────────────────────────────────────────────────────────────
 *
 * {@link computeRmsLevel} is a pure function (byte time-domain buffer → 0..1
 * level) so the perceptual mapping is unit-testable with hand-built arrays,
 * no Web Audio involved at all.
 *
 * {@link TrackLevelMeter} polls an {@link AnalyserLike} on an interval (NOT
 * `requestAnimationFrame` — that is a DOM/window API; `setInterval` is an
 * ambient global available in Node too, keeping this file callable from
 * `node --test`) and applies a simple exponential moving average so a
 * CSS-driven ring doesn't jitter frame to frame, matching the "glowing ring
 * reacts to voice level" look (Discord/Jitsi style) rather than a raw VU
 * meter. Timers are injectable (same pattern as `ice-gathering.ts`'s
 * `setTimeoutFn`) for deterministic tests.
 */

/**
 * The subset of a real Web Audio `AnalyserNode` the meter needs. A real
 * `AnalyserNode` is structurally assignable to this; so is a test fake that
 * just hands back a canned buffer.
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
 * while near silence stays dark. Exposed as a constant (not hardcoded inline)
 * so a future tuning pass has one place to change it. */
export const DEFAULT_LEVEL_GAIN = 9;

/** Noise gate applied AFTER {@link DEFAULT_LEVEL_GAIN} (in the same boosted
 * 0..1 space): ambient room noise/self-noise reads as a small but non-zero
 * boosted level, which would light the ring green even when nobody is talking.
 * Anything at or below this floor is forced to exactly 0 ("no green at rest"),
 * and everything above is rescaled `(x - gate)/(1 - gate)` so real speech still
 * spans the full range rather than being uniformly dimmed by the subtraction.
 * Scaled with {@link DEFAULT_LEVEL_GAIN} so the *silence floor* (the raw RMS
 * below which the ring stays dark) is held constant as the gain rises — gate /
 * gain ≈ 0.01 raw RMS either way, so bumping the gain makes the ring more
 * sensitive ABOVE the floor without letting ambient noise back in. */
export const DEFAULT_LEVEL_NOISE_GATE = 0.09;

/** Default poll interval. 10Hz is smooth enough for a CSS-animated ring and
 * cheap enough to run per-track for the lifetime of a call. */
export const DEFAULT_LEVEL_INTERVAL_MS = 100;

/** Default exponential-moving-average smoothing factor (0..1, weight kept
 * from the previous sample). Higher = smoother/slower to react. */
export const DEFAULT_LEVEL_SMOOTHING = 0.5;

/**
 * Pure RMS-based level computation from a Web-Audio time-domain byte buffer
 * (values 0..255, silence centered on 128 per the Web Audio spec). Returns a
 * value in `[0, 1]`: 0 is silence (or ambient noise below {@link
 * DEFAULT_LEVEL_NOISE_GATE}), 1 is "at or above the tuned loud threshold" (see
 * {@link DEFAULT_LEVEL_GAIN}), not "digital full scale".
 *
 * The pipeline is: RMS → `× gain` → noise gate (below the gate → 0, above →
 * rescaled to `[0, 1]`) → clamp. The gate is what keeps a resting ring truly
 * dark rather than faintly lit by ambient noise.
 *
 * An empty buffer (a degenerate/misconfigured analyser) returns 0 rather
 * than throwing or dividing by zero.
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
  // Noise gate: below the floor is silence; above it, rescale so real speech
  // still reaches 1 instead of being uniformly dimmed by the subtraction.
  const gate = Math.min(Math.max(noiseGate, 0), 0.999);
  if (boosted <= gate) return 0;
  const rescaled = (boosted - gate) / (1 - gate);
  return Math.min(1, Math.max(0, rescaled));
}

export interface TrackLevelMeterOptions {
  /** The (bridge-constructed) analyser tapping this track's audio. */
  analyser: AnalyserLike;
  /** Poll interval in ms. Default {@link DEFAULT_LEVEL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Gain forwarded to {@link computeRmsLevel}. Default {@link DEFAULT_LEVEL_GAIN}. */
  gain?: number;
  /** Noise gate forwarded to {@link computeRmsLevel}. Default {@link DEFAULT_LEVEL_NOISE_GATE}. */
  noiseGate?: number;
  /** EMA smoothing factor, see {@link DEFAULT_LEVEL_SMOOTHING}. Default that. */
  smoothing?: number;
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
 * metered track (docs/calls.md: "local + remote" — the bridge owns two).
 *
 * Not started automatically: call {@link start} once the underlying track is
 * live and {@link stop} on teardown (mirrors `AudioCallEngine`'s own
 * start/stop-on-`end()` discipline, so a torn-down call can't leave a poll
 * loop running against a closed/disconnected analyser).
 */
export class TrackLevelMeter {
  private readonly analyser: AnalyserLike;
  private readonly buffer: Uint8Array;
  private readonly intervalMs: number;
  private readonly gain: number;
  private readonly noiseGate: number;
  private readonly smoothing: number;
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
    this.intervalMs = options.intervalMs ?? DEFAULT_LEVEL_INTERVAL_MS;
    this.gain = options.gain ?? DEFAULT_LEVEL_GAIN;
    this.noiseGate = options.noiseGate ?? DEFAULT_LEVEL_NOISE_GATE;
    this.smoothing = options.smoothing ?? DEFAULT_LEVEL_SMOOTHING;
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
   * Begin polling. Idempotent (a second call while already running is a
   * no-op). Takes one sample synchronously so `level`/`onLevel` reflect
   * something before the first interval tick.
   */
  start(): void {
    if (this.handle != null) return;
    this.sample();
    this.handle = this.setIntervalFn(() => this.sample(), this.intervalMs);
  }

  /** Stop polling. Idempotent; safe to call even if never started. Does NOT
   * reset `level` — the last known level stays readable until the caller
   * discards this instance. */
  stop(): void {
    if (this.handle == null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /**
   * Take one reading now (also what the interval calls). Exposed so tests
   * (and a caller that wants an immediate reading, e.g. right after `start`)
   * don't have to wait on the injected timer.
   */
  sample(): number {
    this.analyser.getByteTimeDomainData(this.buffer);
    const raw = computeRmsLevel(this.buffer, this.gain, this.noiseGate);
    this.currentLevel = this.currentLevel * this.smoothing + raw * (1 - this.smoothing);
    this.onLevelCb?.(this.currentLevel);
    return this.currentLevel;
  }
}
