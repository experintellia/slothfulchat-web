/**
 * Incoming-call ringtone + vibration, used only while an incoming call is in
 * the `ringing` state (docs/calls.md §Windowing).
 *
 * The tone is synthesized with a Web Audio oscillator — nothing to fetch,
 * license, or add to the CSP's `media-src` — gated by a `GainNode` on/off, not
 * by starting/stopping the oscillator (an `OscillatorNode` can only be started
 * once, ever). Best-effort throughout: missing Web Audio / `navigator.vibrate`
 * or a blocked `AudioContext` rings silently rather than breaking the dialog,
 * and `stop()` is unconditionally safe so every teardown path can call it.
 */

const RING_ON_MS = 1000
const RING_OFF_MS = 1000
const RING_FREQ_HZ = 440 // classic single-tone approximation of a ring cadence
const RING_GAIN = 0.15 // quiet — a notification cue, not a loud alarm

/** Build a [vibrate, pause] pattern of `repeats` pairs. `navigator.vibrate`
 * has no loop option — a pattern plays once and stops — so a long ring is
 * approximated by re-arming a fresh pattern periodically. */
export function vibratePattern(repeats: number): number[] {
  const pattern: number[] = []
  for (let i = 0; i < repeats; i++) pattern.push(RING_ON_MS, RING_OFF_MS)
  return pattern
}

/** [on, off] pairs per arm (~30s) before the interval re-arms another. */
const VIBRATE_REPEATS_PER_ARM = 15
const VIBRATE_REARM_MS = VIBRATE_REPEATS_PER_ARM * (RING_ON_MS + RING_OFF_MS)

export interface RingtonePlayerOptions {
  /** Injectable for tests. Defaults to `() => new AudioContext()`. */
  createAudioContext?: () => AudioContext
  /** Injectable for tests. Defaults to `navigator.vibrate`, or a no-op when
   * unavailable. */
  vibrate?: (pattern: number[]) => boolean
}

/**
 * A looping ring tone + vibration for the incoming-call dialog. `start()` is
 * idempotent; `stop()` tears down the audio graph, cancels any in-flight
 * vibration, and is safe to call any number of times, including before
 * `start()`.
 */
export class RingtonePlayer {
  private readonly createAudioContext: () => AudioContext
  private readonly vibrateFn: (pattern: number[]) => boolean

  private ctx: AudioContext | null = null
  private oscillator: OscillatorNode | null = null
  private gain: GainNode | null = null
  private pulseTimer: ReturnType<typeof setInterval> | null = null
  private vibrateTimer: ReturnType<typeof setInterval> | null = null
  private ringing = false

  constructor(options: RingtonePlayerOptions = {}) {
    this.createAudioContext = options.createAudioContext ?? (() => new AudioContext())
    this.vibrateFn =
      options.vibrate ??
      (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
        ? (pattern) => navigator.vibrate(pattern)
        : () => false)
  }

  /** Whether a ring is currently sounding. */
  get isRinging(): boolean {
    return this.ringing
  }

  start(): void {
    if (this.ringing) return
    this.ringing = true
    this.startTone()
    this.startVibration()
  }

  private startTone(): void {
    try {
      const ctx = this.createAudioContext()
      if (ctx.state === 'suspended') {
        // Best-effort: the ring is triggered by an IncomingCall event, not a
        // user gesture, so autoplay policy may block resume() — the tone just
        // doesn't sound and vibration still tries.
        void ctx.resume().catch(() => {})
      }
      const gain = ctx.createGain()
      gain.gain.value = 0 // start silent; the pulse loop below gates it on/off
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = RING_FREQ_HZ
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      this.ctx = ctx
      this.oscillator = osc
      this.gain = gain
      this.gateOn()
      this.pulseTimer = setInterval(() => this.togglePulse(), RING_ON_MS + RING_OFF_MS)
    } catch {
      // Web Audio unavailable/blocked — ring silently via vibration only.
    }
  }

  private on = true
  private togglePulse(): void {
    this.on = !this.on
    if (this.on) this.gateOn()
    else this.gateOff()
  }

  private gateOn(): void {
    if (this.gain == null) return
    this.gain.gain.value = RING_GAIN
  }

  private gateOff(): void {
    if (this.gain == null) return
    this.gain.gain.value = 0
  }

  private startVibration(): void {
    const arm = () => this.vibrateFn(vibratePattern(VIBRATE_REPEATS_PER_ARM))
    arm()
    this.vibrateTimer = setInterval(arm, VIBRATE_REARM_MS)
  }

  /** Stop ringing. Idempotent and safe before `start()`. */
  stop(): void {
    this.ringing = false
    if (this.pulseTimer != null) {
      clearInterval(this.pulseTimer)
      this.pulseTimer = null
    }
    if (this.vibrateTimer != null) {
      clearInterval(this.vibrateTimer)
      this.vibrateTimer = null
    }
    this.vibrateFn([]) // cancel any in-flight vibration (empty pattern = stop, per spec)
    try {
      this.oscillator?.stop()
    } catch {
      /* already stopped/never started — harmless */
    }
    try {
      this.oscillator?.disconnect()
    } catch {
      /* best-effort */
    }
    try {
      this.gain?.disconnect()
    } catch {
      /* best-effort */
    }
    this.oscillator = null
    this.gain = null
    if (this.ctx != null) {
      const ctx = this.ctx
      this.ctx = null
      void ctx.close().catch(() => {
        /* best-effort — nothing further to clean up either way */
      })
    }
    this.on = true
  }
}
