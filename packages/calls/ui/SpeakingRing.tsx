/**
 * A participant's avatar with a glowing ring that reacts to voice level (M2,
 * docs/calls.md: "a glowing ring around each participant avatar that reacts
 * to their voice level (Discord/Jitsi style)"). Purely presentational: `level`
 * is whatever the bridge's Web-Audio meter (`engine/level-meter.ts`'s
 * `TrackLevelMeter`, already smoothed there via an exponential moving
 * average) last reported for this participant's track — this component does
 * no metering itself, it only renders the number, so it needs no
 * `useEffect`/timers of its own and re-renders exactly as often as
 * `CallsUiStore` pushes a new level (~10x/sec while a call is connected).
 *
 * No avatar-image plumbing lives here on purpose: `avatarUrl` is an optional
 * prop so a caller that *does* have one (the runtime's existing blob/avatar
 * path, docs/calls.md: "Existing blob/avatar path… for avatars in call UI")
 * can pass it straight through; without one this falls back to an initial
 * letter, which is enough to demonstrate/troubleshoot "is this participant's
 * mic actually picking anything up" even before that wiring lands.
 */
import type { CSSProperties } from 'react'

export interface SpeakingRingProps {
  /** Shown as the fallback initial and as the accessible name; also the
   * caption rendered under the ring by the caller (this component does not
   * render its own caption, so the same label isn't duplicated visually). */
  label: string
  /** Smoothed 0..1 voice level. `null` (not metered yet — e.g. an incoming
   * call still ringing, mic not yet acquired) renders the same as `0`, a
   * dark/non-glowing ring, so there is no "flash of wrong state". */
  level: number | null
  /** Optional avatar image URL. Falls back to an initial-letter tile. */
  avatarUrl?: string | null
  /** Local participant only: dim the ring and mute the glow — a muted mic
   * cannot be "speaking" no matter what the (stale, pre-mute) analyser reads,
   * since track.enabled=false silences the signal at the source too, but
   * dimming explicitly avoids depending on that timing. */
  muted?: boolean
  /** Diameter in px. Default 72 (fits comfortably in the existing
   * `styles.card` width, `min(340px, 92vw)`, two-up). */
  size?: number
}

const DEFAULT_SIZE = 72
/** Discord/Jitsi-style speaking-ring color — reuses the same green as the
 * incoming-ring Accept button (`styles.COLOR_ACCEPT`) so "glowing" reads as
 * one consistent "good/active" color across this package's UI rather than
 * introducing a second green. Not imported from styles.ts to keep this
 * component's only dependency to `react` — see its literal value there. */
const RING_COLOR_RGB = '46, 160, 67'

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
  // A faint ring is always visible (even at level 0) so the tile doesn't look
  // "broken" between words; it grows into a real glow + slight pulse-scale as
  // level rises toward 1 — the "reacts to voice level" look.
  const borderAlpha = 0.18 + effectiveLevel * 0.65
  const glowAlpha = effectiveLevel * 0.55
  const glowSpread = 2 + effectiveLevel * 10
  const scale = 1 + effectiveLevel * 0.08

  const ringStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    border: `2px solid rgba(${RING_COLOR_RGB}, ${muted ? 0.12 : borderAlpha})`,
    boxShadow:
      glowAlpha > 0
        ? `0 0 ${glowSpread}px ${glowSpread / 2}px rgba(${RING_COLOR_RGB}, ${glowAlpha})`
        : 'none',
    transform: `scale(${scale})`,
    // Short, linear transition: the meter already ticks ~10x/sec (100ms) with
    // its own EMA smoothing, so this only smooths the *rendering* between
    // those ticks rather than re-introducing a second, competing smoothing
    // curve on top of the engine's.
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
