/**
 * The incoming-ring dialog. Rendered only for an incoming, still-ringing
 * call (see `CallsRoot`); it renders in the always-mounted main window so
 * it can never be popup-blocked (docs/calls.md §Windowing). The mic is
 * deliberately not touched until the user presses Accept — and the CAMERA
 * only ever by pressing "Accept with video": the caller's `has_video` never
 * reaches the capture constraints, so no button answers for a device the user
 * didn't pick. Both accept buttons show unconditionally (the video m-line is
 * negotiated on every call, so answering with video works even against an
 * audio-started caller), and the audio-only one is the focused default.
 */
import { useIsMobileViewport } from './useIsMobileViewport.ts'
import * as styles from './styles.ts'

export interface IncomingCallRingProps {
  /** Chat/contact name, or a generic fallback until resolved. */
  title: string
  /** Set if the call failed/ended before the user acted (e.g. caller hung up
   * while this was rendering — engine already `ended`; Close = dismiss). */
  error: string | null
  /** `withVideo` = the user pressed "Accept with video"; a plain Accept
   * answers audio-only. */
  onAccept(options?: { withVideo?: boolean }): void
  onDecline(): void
}

export function IncomingCallRing({ title, error, onAccept, onDecline }: IncomingCallRingProps) {
  const isMobile = useIsMobileViewport()
  const cardStyle = isMobile ? { ...styles.card, ...styles.cardMobile } : styles.card
  const buttonStyle = isMobile ? { ...styles.button, ...styles.buttonMobile } : styles.button
  const acceptStyle = { ...buttonStyle, background: styles.COLOR_ACCEPT }

  return (
    <div role="dialog" aria-modal="true" aria-label="Incoming call" style={cardStyle}>
      <div style={styles.title}>Incoming call</div>
      <div style={styles.subtitle}>{title}</div>
      {error != null && <div style={styles.errorText}>{error}</div>}
      <div style={styles.buttonRow}>
        <button
          type="button"
          onClick={onDecline}
          style={{ ...buttonStyle, background: styles.COLOR_DECLINE }}
        >
          {error != null ? 'Close' : 'Decline'}
        </button>
        {error == null && (
          <>
            <button
              type="button"
              onClick={() => onAccept()}
              style={acceptStyle}
              // "Accept" alone doesn't say what it does to the camera; spell it
              // out for screen readers so the two buttons can't be confused.
              aria-label="Accept, audio only"
              autoFocus
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => onAccept({ withVideo: true })}
              style={acceptStyle}
            >
              Accept with video
            </button>
          </>
        )}
      </div>
    </div>
  )
}
