/**
 * A participant's avatar with a glowing ring that reacts to voice level
 * (Discord/Jitsi style). Purely presentational: `level` is already smoothed
 * by the bridge's Web-Audio meter (`engine/level-meter.ts`), so this does no
 * metering and needs no effects/timers of its own — it re-renders exactly as
 * often as `CallsUiStore` pushes a new level (~10x/sec while connected).
 */
import type { CSSProperties } from 'react'

export interface SpeakingRingProps {
  /** Fallback initial + accessible name (the caller renders any caption). */
  label: string
  /** Smoothed 0..1 voice level. `null` (not metered yet, e.g. still ringing)
   * renders the same as `0` — a dark, non-glowing ring. */
  level: number | null
  /** Optional avatar image URL. Falls back to an initial-letter tile. */
  avatarUrl?: string | null
  /** Local participant only: dim the ring and force the glow off — a muted
   * mic cannot be "speaking", regardless of what a stale pre-mute analyser
   * reading says. */
  muted?: boolean
  /** Diameter in px. */
  size?: number
}

const DEFAULT_SIZE = 72
/** Same green as `styles.COLOR_ACCEPT`, kept as a literal so this
 * component's only dependency stays `react`. */
const RING_COLOR_RGB = '46, 160, 67'
/** Neutral resting ring color — grey at level 0, so an idle participant
 * reads as "present but not speaking"; green at rest would look like sound
 * is being picked up when there is none. */
const NEUTRAL_RING_RGB = '128, 128, 136'

/** Linear interpolate one 0..255 channel from `a` to `b` by `t` (0..1). */
function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

function initialLetter(label: string): string {
  const trimmed = label.trim()
  return trimmed.length > 0 ? trimmed[0].toUpperCase() : '?'
}

export function SpeakingRing({
  label,
  level,
  avatarUrl = null,
  muted = false,
  size = DEFAULT_SIZE,
}: SpeakingRingProps) {
  const clampedLevel = Math.min(1, Math.max(0, level ?? 0))
  const effectiveLevel = muted ? 0 : clampedLevel
  // Perceptual curve: raw voice level is small even at normal speaking
  // volume, so a sqrt response lifts the low-mid range — the ring lights up
  // as soon as you start talking. Still exactly 0 at level 0, so no green at
  // rest (the meter's noise gate already floors silence upstream).
  const shaped = Math.pow(effectiveLevel, 0.5)
  const [gr, gg, gb] = NEUTRAL_RING_RGB.split(',').map(v => Number(v.trim()))
  const [sr, sg, sb] = RING_COLOR_RGB.split(',').map(v => Number(v.trim()))
  const borderR = lerpChannel(gr, sr, shaped)
  const borderG = lerpChannel(gg, sg, shaped)
  const borderB = lerpChannel(gb, sb, shaped)
  // Grey base is always faintly visible; brightens as it greens.
  const borderAlpha = muted ? 0.28 : 0.38 + shaped * 0.55
  const glowAlpha = shaped * 0.72
  const glowSpread = 2 + shaped * 15
  const scale = 1 + shaped * 0.12

  const ringStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    border: `2px solid rgba(${borderR}, ${borderG}, ${borderB}, ${borderAlpha})`,
    boxShadow:
      glowAlpha > 0
        ? `0 0 ${glowSpread}px ${glowSpread / 2}px rgba(${RING_COLOR_RGB}, ${glowAlpha})`
        : 'none',
    transform: `scale(${scale})`,
    // Short, linear transition: just smooths rendering between the meter's
    // ~100ms ticks — the meter already does its own EMA smoothing.
    transition: 'box-shadow 90ms linear, transform 90ms linear, border-color 90ms linear',
    background: '#2a2a2a',
    color: '#eee',
    fontSize: size * 0.4,
    fontWeight: 600,
    lineHeight: 1,
    overflow: 'hidden',
    flexShrink: 0,
    opacity: muted ? 0.6 : 1,
  }

  return (
    <div role="img" aria-label={muted ? `${label}, muted` : label} style={ringStyle}>
      {avatarUrl != null ? (
        // eslint-disable-next-line jsx-a11y/alt-text -- decorative; aria-label above on the wrapping role="img" is the accessible name
        <img
          src={avatarUrl}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
        />
      ) : (
        initialLetter(label)
      )}
    </div>
  )
}
