/**
 * The in-page call overlay: status ("Calling…"/"Connecting…"/"In call"),
 * remote-audio sink, hang up, and mute. Rendered for every non-ring state of
 * an active call (outgoing ringing/"calling…" included — only an *incoming*
 * ring gets the separate accept/decline dialog, see `IncomingCallRing`).
 *
 * No video, no device pickers (M1 scope, docs/calls.md); mute is a local-only
 * `track.enabled` toggle (`AudioCallEngine.setMuted` — see its doc comment),
 * so it is available as soon as a local stream exists, i.e. once `state` is
 * `connecting` or `connected` (outgoing calls acquire the mic while still
 * `ringing`, but we gate on connecting/connected uniformly so an incoming
 * call — mic-less while ringing — never shows a mute button that would do
 * nothing).
 */
import { useEffect, useRef } from 'react'
import type { CallDirection, CallState } from '../engine/index.ts'
import * as styles from './styles.ts'

export interface CallOverlayProps {
  direction: CallDirection
  state: CallState
  title: string
  muted: boolean
  remoteStream: MediaStream | null
  error: string | null
  onHangup(): void
  onToggleMute(): void
}

function statusText(direction: CallDirection, state: CallState): string {
  switch (state) {
    case 'ringing':
      return direction === 'outgoing' ? 'Calling…' : 'Ringing…'
    case 'connecting':
      return 'Connecting…'
    case 'connected':
      return 'In call'
    case 'idle':
    case 'ended':
      return ''
  }
}

export function CallOverlay({
  direction,
  state,
  title,
  muted,
  remoteStream,
  error,
  onHangup,
  onToggleMute,
}: CallOverlayProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const audioEl = audioRef.current
    if (audioEl == null) return
    audioEl.srcObject = remoteStream
    if (remoteStream != null) {
      audioEl.play().catch(() => {
        // Autoplay may be deferred by the browser; the call flow started
        // from a user gesture (the call button / Accept click) so this is
        // expected to succeed in practice and is not worth surfacing.
      })
    }
  }, [remoteStream])

  const canMute = state === 'connecting' || state === 'connected'

  return (
    <div role="dialog" aria-label="Call" style={styles.card}>
      <div style={styles.title}>{title}</div>
      <div style={error != null ? styles.errorText : styles.subtitle}>
        {error ?? statusText(direction, state)}
      </div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- remote audio sink, not user-facing media */}
      <audio ref={audioRef} autoPlay style={{ display: 'none' }} />
      <div style={styles.buttonRow}>
        {canMute && error == null && (
          <button
            type="button"
            onClick={onToggleMute}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            style={{
              ...styles.button,
              background: muted ? styles.COLOR_NEUTRAL_ACTIVE : styles.COLOR_NEUTRAL,
            }}
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
        )}
        <button
          type="button"
          onClick={onHangup}
          style={{ ...styles.button, background: styles.COLOR_DECLINE }}
        >
          {error != null ? 'Close' : 'Hang up'}
        </button>
      </div>
    </div>
  )
}
