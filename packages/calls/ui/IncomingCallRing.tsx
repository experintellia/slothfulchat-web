/**
 * The incoming-ring dialog. Rendered only for an incoming, still-ringing
 * call (see `CallsRoot`); it renders in the always-mounted main window so
 * it can never be popup-blocked (docs/calls.md §Windowing). The mic is
 * deliberately not touched until the user presses Accept.
 */
import { useIsMobileViewport } from './useIsMobileViewport.ts'
import * as styles from './styles.ts'

export interface IncomingCallRingProps {
  /** Chat/contact name, or a generic fallback until resolved. */
  title: string
  /** Set if the call failed/ended before the user acted (e.g. caller hung up
   * while this was rendering — engine already `ended`; Close = dismiss). */
  error: string | null
  onAccept(): void
  onDecline(): void
}

export function IncomingCallRing({ title, error, onAccept, onDecline }: IncomingCallRingProps) {
  const isMobile = useIsMobileViewport()
  const cardStyle = isMobile ? { ...styles.card, ...styles.cardMobile } : styles.card
  const buttonStyle = isMobile ? { ...styles.button, ...styles.buttonMobile } : styles.button

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
          <button
            type="button"
            onClick={onAccept}
            style={{ ...buttonStyle, background: styles.COLOR_ACCEPT }}
            autoFocus
          >
            Accept
          </button>
        )}
      </div>
    </div>
  )
}
