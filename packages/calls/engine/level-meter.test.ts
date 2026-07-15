import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRmsLevel,
  TrackLevelMeter,
  DEFAULT_LEVEL_GAIN,
  DEFAULT_LEVEL_NOISE_GATE,
  type AnalyserLike,
} from './level-meter.ts';

// ── computeRmsLevel ──────────────────────────────────────────────────────────

test('computeRmsLevel: silence (all-128 buffer) is 0', () => {
  const silence = new Uint8Array(32).fill(128);
  assert.equal(computeRmsLevel(silence), 0);
});

test('computeRmsLevel: empty buffer is 0 (no throw, no NaN)', () => {
  assert.equal(computeRmsLevel(new Uint8Array(0)), 0);
});

test('computeRmsLevel: full-scale square wave clamps to 1', () => {
  const buf = new Uint8Array(32);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 2 === 0 ? 0 : 255;
  assert.equal(computeRmsLevel(buf), 1);
});

test('computeRmsLevel: louder signal yields a higher level than a quieter one', () => {
  const quiet = new Uint8Array(64);
  const loud = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    // Small-amplitude vs. larger-amplitude sine-like wobble around the 128 center.
    quiet[i] = 128 + Math.round(4 * Math.sin(i));
    loud[i] = 128 + Math.round(40 * Math.sin(i));
  }
  assert.ok(computeRmsLevel(loud) > computeRmsLevel(quiet));
});

test('computeRmsLevel: gain=0 always yields 0 regardless of signal', () => {
  const buf = new Uint8Array(16).fill(200);
  assert.equal(computeRmsLevel(buf, 0), 0);
});

test('computeRmsLevel: never negative and never exceeds 1 for arbitrary bytes', () => {
  for (const fillValue of [0, 1, 64, 127, 128, 129, 200, 255]) {
    const buf = new Uint8Array(8).fill(fillValue);
    const level = computeRmsLevel(buf, DEFAULT_LEVEL_GAIN * 10 /* stress the clamp */);
    assert.ok(level >= 0 && level <= 1, `level ${level} out of [0,1] for fill ${fillValue}`);
  }
});

// ── Noise gate + sensitivity (FIX 3) ──────────────────────────────────────────

test('computeRmsLevel: near-silence / ambient noise below the gate reads as exactly 0 (no green at rest)', () => {
  // Constant fill(128 + a) has RMS = a/128 exactly. a=1 → boosted ≈ 0.047,
  // below the 0.06 default gate.
  const nearSilence = new Uint8Array(32).fill(128 + 1);
  assert.equal(computeRmsLevel(nearSilence), 0);
});

test('computeRmsLevel: a signal just above the noise gate is a small positive level', () => {
  const justAbove = new Uint8Array(32).fill(128 + 2); // boosted ≈ 0.094 > 0.06
  const level = computeRmsLevel(justAbove);
  assert.ok(level > 0 && level < 0.2, `expected a small positive level, got ${level}`);
});

test('computeRmsLevel: loud speech reads high thanks to the boosted gain', () => {
  const loud = new Uint8Array(32).fill(128 + 100);
  assert.ok(computeRmsLevel(loud) > 0.9);
});

test('computeRmsLevel: the noise-gate boundary is exact (at/below → 0, just above → >0)', () => {
  // With gain 1 the boosted value equals the RMS, so a constant fill lands
  // exactly at a chosen gate: fill(128+13) → RMS = 13/128 ≈ 0.1016.
  const atGate = new Uint8Array(8).fill(128 + 13);
  assert.equal(computeRmsLevel(atGate, 1, 0.1016), 0, 'at-or-below the gate → 0');
  assert.ok(computeRmsLevel(atGate, 1, 0.09) > 0, 'above the gate → positive');
});

test('computeRmsLevel: rescaling above the gate still reaches full scale for loud input', () => {
  // The (x - gate)/(1 - gate) rescale must not permanently cap the max below 1.
  const loud = new Uint8Array(16).fill(128 + 120);
  assert.equal(computeRmsLevel(loud, DEFAULT_LEVEL_GAIN, DEFAULT_LEVEL_NOISE_GATE), 1);
});

// ── TrackLevelMeter ───────────────────────────────────────────────────────────

/** A fake analyser whose "waveform" is just whatever byte the test pushes. */
class FakeAnalyser implements AnalyserLike {
  readonly fftSize: number;
  private fillValue: number;

  constructor(fftSize: number, initialFillValue = 128) {
    this.fftSize = fftSize;
    this.fillValue = initialFillValue;
  }

  /** Simulate the track producing a signal at this amplitude around center. */
  setAmplitude(amplitude: number): void {
    this.fillValue = 128 + amplitude;
  }

  getByteTimeDomainData(array: Uint8Array): void {
    array.fill(this.fillValue);
  }
}

/** Deterministic fake interval: `tick()` invokes every scheduled callback once. */
function fakeIntervalHarness() {
  const callbacks = new Set<() => void>();
  return {
    setIntervalFn: (cb: () => void) => {
      callbacks.add(cb);
      return cb; // the "handle" is just the callback itself
    },
    clearIntervalFn: (handle: unknown) => {
      callbacks.delete(handle as () => void);
    },
    tick(times = 1): void {
      for (let i = 0; i < times; i++) {
        for (const cb of [...callbacks]) cb();
      }
    },
    activeCount(): number {
      return callbacks.size;
    },
  };
}

test('TrackLevelMeter.start takes an immediate sample without waiting for a tick', () => {
  const analyser = new FakeAnalyser(32, 128 + 60);
  const harness = fakeIntervalHarness();
  const meter = new TrackLevelMeter({
    analyser,
    smoothing: 0, // no smoothing — exercise the raw sample directly
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  assert.equal(meter.level, 0, 'no sample taken yet');
  meter.start();
  assert.ok(meter.level > 0, 'start() takes a synchronous first sample');
});

test('TrackLevelMeter: level rises and falls as the underlying signal changes (smoothing=0)', () => {
  const analyser = new FakeAnalyser(32, 128);
  const harness = fakeIntervalHarness();
  const levels: number[] = [];
  const meter = new TrackLevelMeter({
    analyser,
    smoothing: 0,
    onLevel: (level) => levels.push(level),
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  meter.start(); // silence
  assert.equal(meter.level, 0);

  analyser.setAmplitude(80);
  harness.tick();
  assert.ok(meter.level > 0, 'loud signal raises the level');
  const loudLevel = meter.level;

  analyser.setAmplitude(0);
  harness.tick();
  assert.equal(meter.level, 0, 'back to silence with no smoothing carry-over');
  assert.ok(levels.length === 3);
  assert.ok(loudLevel > 0);
});

test('TrackLevelMeter: smoothing dampens an instantaneous jump (EMA, not a raw pass-through)', () => {
  const analyser = new FakeAnalyser(32, 128);
  const harness = fakeIntervalHarness();
  const meter = new TrackLevelMeter({
    analyser,
    smoothing: 0.5,
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  meter.start(); // level 0
  analyser.setAmplitude(100);
  harness.tick();
  const afterOneTick = meter.level;
  const rawLoud = computeRmsLevel(new Uint8Array(32).fill(128 + 100));
  assert.ok(
    afterOneTick < rawLoud,
    `smoothed level (${afterOneTick}) should lag the raw instantaneous level (${rawLoud})`
  );
  assert.ok(afterOneTick > 0, 'but still moved off zero');

  harness.tick(20); // let it settle toward the raw level
  assert.ok(
    Math.abs(meter.level - rawLoud) < 0.01,
    'after enough ticks the EMA converges near the steady-state raw level'
  );
});

test('TrackLevelMeter.start is idempotent (a second start does not double-schedule)', () => {
  const analyser = new FakeAnalyser(32);
  const harness = fakeIntervalHarness();
  const meter = new TrackLevelMeter({
    analyser,
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  meter.start();
  meter.start();
  assert.equal(harness.activeCount(), 1);
  assert.equal(meter.isRunning, true);
});

test('TrackLevelMeter.stop clears the interval and is idempotent', () => {
  const analyser = new FakeAnalyser(32);
  const harness = fakeIntervalHarness();
  const meter = new TrackLevelMeter({
    analyser,
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  meter.start();
  meter.stop();
  assert.equal(harness.activeCount(), 0);
  assert.equal(meter.isRunning, false);
  meter.stop(); // no-op, must not throw
  assert.equal(harness.activeCount(), 0);
});

test('TrackLevelMeter: stop() without start() is a harmless no-op', () => {
  const analyser = new FakeAnalyser(32);
  const meter = new TrackLevelMeter({ analyser });
  assert.doesNotThrow(() => meter.stop());
  assert.equal(meter.isRunning, false);
});

test('TrackLevelMeter: degenerate fftSize (0) does not throw on construction or sample', () => {
  const analyser = new FakeAnalyser(0, 128 + 50);
  const harness = fakeIntervalHarness();
  const meter = new TrackLevelMeter({
    analyser,
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  assert.doesNotThrow(() => meter.start());
});
