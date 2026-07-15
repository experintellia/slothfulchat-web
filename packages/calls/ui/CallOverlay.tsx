/**
 * The in-page call overlay: status ("Calling…"/"Connecting…"/"In call"),
 * remote-audio sink, hang up, and mute. Rendered for every non-ring state of
 * an active call (outgoing ringing/"calling…" included — only an *incoming*
 * ring gets the separate accept/decline dialog, see `IncomingCallRing`).
 *
 * Mute is a local-only `track.enabled` toggle (`AudioCallEngine.setMuted` —
 * see its doc comment), so it is available as soon as a local stream exists,
 * i.e. once `state` is `connecting` or `connected` (outgoing calls acquire
 * the mic while still `ringing`, but we gate on connecting/connected
 * uniformly so an incoming call — mic-less while ringing — never shows a
 * mute button that would do nothing).
 *
 * M2 adds a `SpeakingRing` per participant (local "You" + the remote title),
 * driven by `localLevel`/`remoteLevel` — the bridge's Web-Audio meters
 * (docs/calls.md: "a glowing ring around each participant avatar that reacts
 * to their voice level"). While neither side is sending video these rings ARE
 * the whole "tile" for each participant. FIX 2: each ring takes the real
 * `avatarUrl` (remote from the chat's profile image, local from the self
 * account) with an initial-letter fallback.
 *
 * M2 also adds the mic/camera `DevicePicker`, shown alongside mute (same
 * `connecting`/`connected` gate — a device picker before the mic exists would
 * have nothing to switch) and only rendered at all once
 * `shouldShowDevicePicker` says there is an actual choice.
 *
 * M3 + FIX 1: camera and screen share are available on ANY connected/
 * connecting call (audio-started included — the outgoing video sender is always
 * negotiated), so the camera + screen-share toggles sit next to mute regardless
 * of the initial `hasVideo`.
 *
 * Stable layout (F): ONE persistent fixed-size stage holds the remote
 * participant (their `<video>` when `remoteHasVideo`, else their speaking
 * ring) with the local self-view always in a corner PiP slot (local `<video>`
 * when `localHasVideo`, else a small local ring) — nothing about the card's
 * geometry changes when video starts/stops on either side. The hidden
 * `<audio>` sink stays mounted throughout; its attach effect blanks it while
 * the remote `<video>` is playing (which carries the same stream's audio).
 *
 * M5 adds a small, non-blocking direct-vs-relay indicator (docs/calls.md:
 * "active candidate pair is 'relay'") once `connected` — purely
 * informational text, never a dialog/prompt, and there is no forced-relay
 * setting for it to control (deferred to #93).
 *
 * M5 also adds mobile-viewport layout (docs/calls.md): below the phone
 * breakpoint this goes full-bleed, the video stage fills the available
 * height instead of a fixed 4/3 ratio, and controls get bigger touch targets
 * (see `useIsMobileViewport`/`styles.ts`'s `*Mobile` tokens).
 */
import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { CallDeviceInfo, CallDirection, CallState, ConnectionRoute } from '../engine/index.ts'
import { DevicePicker } from './DevicePicker.tsx'
import { SpeakingRing } from './SpeakingRing.tsx'
import * as styles from './styles.ts'
import { useIsMobileViewport } from './useIsMobileViewport.ts'

export interface CallOverlayProps {
  direction: CallDirection
  state: CallState
  title: string
  /** Remote participant's avatar URL (FIX 2), or `null` for the initial. */
  remoteAvatarUrl: string | null
  /** Local ("You") avatar URL (self-account image), or `null` for the initial. */
  localAvatarUrl: string | null
  muted: boolean
  /** Whether this call STARTED with the camera on. No longer gates the video
   * tiles or controls (both camera + screen share are available on any call) —
   * `localHasVideo`/`remoteHasVideo` decide the tiles, and the controls show on
   * any connecting/connected call. */
  hasVideo: boolean
  /** Whether the local camera is currently on (M3 camera toggle) — pressed
   * state of the camera button. */
  cameraOn: boolean
  /** Whether a local video track is actually flowing (camera on OR screen
   * sharing) — gates the local video tile. */
  localHasVideo: boolean
  /** Whether a remote video track is actually flowing — gates the remote
   * video tile vs. the remote speaking ring. */
  remoteHasVideo: boolean
  /** Whether the peer reports its mic muted (`mutedState` channel) — shows
   * the muted-mic badge on the remote tile/ring. Optional until the owner
   * wires `CallsUiStore.remoteAudioMuted` through. */
  remoteAudioMuted?: boolean
  remoteStream: MediaStream | null
  /** The local mic/camera stream (M3 local video preview). `null` while an
   * incoming call is still ringing. */
  localStream: MediaStream | null
  /** Whether the outgoing video is currently a screen capture (M3). */
  screenSharing: boolean
  /** Set if the last screen-share start/stop failed; surfaced inline next to
   * the screen-share control, not call-ending (contrast `error`). */
  screenShareError: string | null
  error: string | null
  /** Smoothed 0..1 local-mic level (M2 speaking ring). */
  localLevel: number
  /** Smoothed 0..1 remote-peer level (M2 speaking ring). */
  remoteLevel: number
  /** M5 direct-vs-relay indicator — `'unknown'` until `connected` and the
   * first poll resolves; see the class doc above. */
  connectionRoute: ConnectionRoute
  /** M2 device picker (see `DevicePicker.tsx`). */
  microphones: CallDeviceInfo[]
  cameras: CallDeviceInfo[]
  selectedMicrophoneId: string | null
  selectedCameraId: string | null
  deviceSwitchError: string | null
  onHangup(): void
  onToggleMute(): void
  onSelectMicrophone(deviceId: string): void
  onSelectCamera(deviceId: string): void
  onToggleScreenShare(): void
  onToggleCamera(): void
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

/** M5: label + tooltip for the direct-vs-relay indicator. `null` for
 * `'unknown'` — nothing to show rather than a confusing placeholder (still
 * gathering stats, or the browser doesn't expose candidate-pair stats the
 * way we expect). */
function connectionRouteInfo(
  route: ConnectionRoute
): { label: string; title: string } | null {
  switch (route) {
    case 'direct':
      return {
        label: 'Direct connection',
        title: 'Media is flowing directly between you and the other participant.',
      }
    case 'relay':
      return {
        label: 'Relayed connection',
        title:
          'Media is routed through a TURN relay server (common on restrictive networks/NAT). Call quality and privacy are unaffected — the relay only sees encrypted media, never its content.',
      }
    case 'unknown':
      return null
  }
}

export function CallOverlay({
  direction,
  state,
  title,
  remoteAvatarUrl,
  localAvatarUrl,
  muted,
  hasVideo: _hasVideo,
  cameraOn,
  localHasVideo,
  remoteHasVideo,
  remoteAudioMuted = false,
  remoteStream,
  localStream,
  screenSharing,
  screenShareError,
  error,
  localLevel,
  remoteLevel,
  connectionRoute,
  microphones,
  cameras,
  selectedMicrophoneId,
  selectedCameraId,
  deviceSwitchError,
  onHangup,
  onToggleMute,
  onSelectMicrophone,
  onSelectCamera,
  onToggleScreenShare,
  onToggleCamera,
}: CallOverlayProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)

  // Always-mounted audio sink: plays the remote audio whenever the remote
  // <video> isn't (the video plays that same stream's audio track, so the
  // sink is blanked then to avoid doubling it).
  useEffect(() => {
    const audioEl = audioRef.current
    if (audioEl == null) return
    const sink = remoteHasVideo ? null : remoteStream
    audioEl.srcObject = sink
    if (sink != null) {
      audioEl.play().catch(() => {
        // Autoplay may be deferred by the browser; the call flow started
        // from a user gesture (the call button / Accept click) so this is
        // expected to succeed in practice and is not worth surfacing.
      })
    }
  }, [remoteStream, remoteHasVideo])

  useEffect(() => {
    const videoEl = remoteVideoRef.current
    if (videoEl == null || !remoteHasVideo) return
    videoEl.srcObject = remoteStream
    if (remoteStream != null) {
      videoEl.play().catch(() => {
        // See the audio effect above for why a rejection here is expected
        // and not worth surfacing.
      })
    }
  }, [remoteStream, remoteHasVideo])

  useEffect(() => {
    const videoEl = localVideoRef.current
    if (videoEl == null || !localHasVideo) return
    videoEl.srcObject = localStream
    if (localStream != null) {
      videoEl.play().catch(() => {})
    }
    // Re-run when the store re-pushes `localStream` on a track (re)establish
    // (camera on/off, switchCamera, screen-share start/stop) — see
    // `CallsUiStore.setLocalStream`'s doc for why identity alone isn't enough.
  }, [localStream, localHasVideo])

  const canMute = state === 'connecting' || state === 'connected'
  // The three media toggles stay mounted from the first render so the button
  // row never changes size — just disabled + dimmed until they can work.
  const controlsDisabled = !canMute || error != null
  // Metering only starts once the respective stream exists (see
  // CallBridge.ensureLocalLevelMeter/startRemoteLevelMeter); before that the
  // store's level fields are simply 0, which SpeakingRing renders as a dark,
  // non-glowing ring rather than a misleading "definitely not talking" state.

  const routeInfo = connectionRouteInfo(connectionRoute)
  const routeDotColor =
    connectionRoute === 'relay' ? styles.COLOR_ROUTE_RELAY : styles.COLOR_ROUTE_DIRECT

  const isMobile = useIsMobileViewport()
  const cardStyle = isMobile
    ? { ...styles.card, ...styles.cardMobile }
    : { ...styles.card, ...styles.cardDesktop }
  const videoStageStyle = {
    ...styles.videoStage,
    ...(isMobile ? styles.videoStageMobile : styles.videoStageDesktop),
    background: remoteHasVideo ? '#000' : '#141414',
  }
  const controlButtonStyle = isMobile ? { ...styles.button, ...styles.buttonMobile } : styles.button
  const disabledButtonStyle = controlsDisabled ? { opacity: 0.45, cursor: 'default' } : {}
  // Bigger avatar rings on desktop — the compact 72px tile suits a phone/toast,
  // but on the roomier centered desktop card it should feel more present.
  const ringSize = isMobile ? 72 : 104

  return (
    <div role="dialog" aria-label="Call" style={cardStyle}>
      <div style={styles.title}>{title}</div>
      <div style={videoStageStyle}>
        {remoteHasVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- remote peer video+audio, not user-facing captioned media
          <video ref={remoteVideoRef} autoPlay playsInline style={styles.remoteVideo} />
        ) : (
          // The remote isn't sending video — a centered speaking ring (with
          // avatar) instead of a black frame. Audio rides the <audio> sink.
          <div style={styles.remoteRingInStage}>
            <div style={{ position: 'relative' }}>
              <SpeakingRing label={title} level={remoteLevel} avatarUrl={remoteAvatarUrl} size={ringSize} />
              {remoteAudioMuted && <MutedMicBadge style={{ right: 0, bottom: 0 }} />}
            </div>
            <div style={styles.participantLabel}>{title}</div>
          </div>
        )}
        {remoteHasVideo && remoteAudioMuted && <MutedMicBadge style={{ left: 8, bottom: 8 }} />}
        <div style={styles.localPip}>
          {localHasVideo ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- local self-preview, muted (no audio needed)
            <video ref={localVideoRef} autoPlay playsInline muted style={styles.localVideo} />
          ) : (
            <SpeakingRing label="You" level={localLevel} muted={muted} avatarUrl={localAvatarUrl} size={56} />
          )}
          {muted && <MutedMicBadge style={{ right: 2, bottom: 2 }} />}
        </div>
      </div>
      <div style={error != null ? styles.errorText : styles.subtitle}>
        {error ?? statusText(direction, state)}
      </div>
      <div style={styles.infoSlot}>
        {error == null && screenShareError != null ? (
          <span style={styles.deviceSwitchError}>{screenShareError}</span>
        ) : error == null && state === 'connected' && routeInfo != null ? (
          // Non-blocking troubleshooting hint (docs/calls.md M5) — plain text,
          // not a dialog/prompt; there is no control here to act on (no
          // forced-relay setting exists — see #93).
          <span style={styles.connectionRoute} title={routeInfo.title}>
            <span style={{ ...styles.connectionRouteDot, background: routeDotColor }} />
            {routeInfo.label}
          </span>
        ) : null}
      </div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- remote audio sink, not user-facing media */}
      <audio ref={audioRef} autoPlay style={{ display: 'none' }} />
      {canMute && error == null && (
        <DevicePicker
          microphones={microphones}
          cameras={cameras}
          selectedMicrophoneId={selectedMicrophoneId}
          selectedCameraId={selectedCameraId}
          deviceSwitchError={deviceSwitchError}
          onSelectMicrophone={onSelectMicrophone}
          onSelectCamera={onSelectCamera}
        />
      )}
      <div style={styles.buttonRow}>
        <button
          type="button"
          onClick={onToggleMute}
          disabled={controlsDisabled}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          style={{
            ...controlButtonStyle,
            background: muted ? styles.COLOR_NEUTRAL_ACTIVE : styles.COLOR_NEUTRAL,
            ...disabledButtonStyle,
          }}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          onClick={onToggleCamera}
          disabled={controlsDisabled}
          aria-pressed={cameraOn}
          aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
          style={{
            ...controlButtonStyle,
            background: cameraOn ? styles.COLOR_NEUTRAL_ACTIVE : styles.COLOR_NEUTRAL,
            ...disabledButtonStyle,
          }}
        >
          {cameraOn ? 'Camera off' : 'Camera on'}
        </button>
        <button
          type="button"
          onClick={onToggleScreenShare}
          disabled={controlsDisabled}
          aria-pressed={screenSharing}
          aria-label={screenSharing ? 'Stop sharing screen' : 'Share screen'}
          style={{
            ...controlButtonStyle,
            background: screenSharing ? styles.COLOR_NEUTRAL_ACTIVE : styles.COLOR_NEUTRAL,
            ...disabledButtonStyle,
          }}
        >
          {screenSharing ? 'Stop sharing' : 'Share screen'}
        </button>
        <button
          type="button"
          onClick={onHangup}
          style={{ ...controlButtonStyle, background: styles.COLOR_DECLINE }}
        >
          {error != null ? 'Close' : 'Hang up'}
        </button>
      </div>
    </div>
  )
}

/** Muted-mic indicator (inline SVG, dependency-free) — absolutely positioned
 * by the caller on the corner of a participant tile/ring; see
 * `styles.muteBadge`. */
function MutedMicBadge({ style }: { style?: CSSProperties }) {
  return (
    <span role="img" aria-label="Muted" title="Muted" style={{ ...styles.muteBadge, ...style }}>
      <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
        <g fill="currentColor">
          <path d="M12 14.5a3 3 0 0 0 3-3v-5a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z" />
          <path d="M17.5 11.5a5.5 5.5 0 0 1-11 0H5a7 7 0 0 0 6 6.92V21h2v-2.58a7 7 0 0 0 6-6.92h-1.5z" />
        </g>
        <path d="M4.5 3.5 20 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  )
}
