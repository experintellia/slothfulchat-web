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
 * to their voice level"). For an audio-only call (`!hasVideo`) these rings
 * ARE the whole "tile" for each participant, not an overlay on a video frame.
 *
 * M2 also adds the mic/camera `DevicePicker`, shown alongside mute (same
 * `connecting`/`connected` gate — a device picker before the mic exists would
 * have nothing to switch) and only rendered at all once
 * `shouldShowDevicePicker` says there is an actual choice.
 *
 * M3 (`hasVideo`): renders `<video>` tiles (remote big, local small
 * self-preview, muted so we don't hear our own mic) INSTEAD of the
 * audio-only `SpeakingRing` row — the video frame itself is the
 * "is-this-person-live" signal a video call wants; a separate `<audio>` sink
 * is not needed since the remote `<video>` element plays that same stream's
 * audio track too. A screen-share toggle button sits next to mute, only
 * meaningful (and only shown) once there is a live outgoing video track to
 * hijack — same `connecting`/`connected` gate as mute/DevicePicker.
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
import type { CallDeviceInfo, CallDirection, CallState, ConnectionRoute } from '../engine/index.ts'
import { DevicePicker } from './DevicePicker.tsx'
import { SpeakingRing } from './SpeakingRing.tsx'
import * as styles from './styles.ts'
import { useIsMobileViewport } from './useIsMobileViewport.ts'

export interface CallOverlayProps {
  direction: CallDirection
  state: CallState
  title: string
  muted: boolean
  /** Whether this call carries video (M3) — gates the video tiles vs. the
   * audio-only `SpeakingRing` row, and the screen-share control. */
  hasVideo: boolean
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
  muted,
  hasVideo,
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
}: CallOverlayProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)

  // Audio-only sink: only used when !hasVideo (a video call's own <video>
  // element plays the same stream's audio track, so a separate <audio> would
  // just double the audio output).
  useEffect(() => {
    const audioEl = audioRef.current
    if (audioEl == null || hasVideo) return
    audioEl.srcObject = remoteStream
    if (remoteStream != null) {
      audioEl.play().catch(() => {
        // Autoplay may be deferred by the browser; the call flow started
        // from a user gesture (the call button / Accept click) so this is
        // expected to succeed in practice and is not worth surfacing.
      })
    }
  }, [remoteStream, hasVideo])

  useEffect(() => {
    const videoEl = remoteVideoRef.current
    if (videoEl == null || !hasVideo) return
    videoEl.srcObject = remoteStream
    if (remoteStream != null) {
      videoEl.play().catch(() => {
        // See the audio effect above for why a rejection here is expected
        // and not worth surfacing.
      })
    }
  }, [remoteStream, hasVideo])

  useEffect(() => {
    const videoEl = localVideoRef.current
    if (videoEl == null || !hasVideo) return
    videoEl.srcObject = localStream
    if (localStream != null) {
      videoEl.play().catch(() => {})
    }
    // Re-run when the store re-pushes `localStream` on a track (re)establish
    // (initial camera, switchCamera, screen-share start/stop) — see
    // `CallsUiStore.setLocalStream`'s doc for why identity alone isn't enough.
  }, [localStream, hasVideo])

  const canMute = state === 'connecting' || state === 'connected'
  // Metering only starts once the respective stream exists (see
  // CallBridge.ensureLocalLevelMeter/startRemoteLevelMeter); before that the
  // store's level fields are simply 0, which SpeakingRing renders as a dark,
  // non-glowing ring rather than a misleading "definitely not talking" state.

  const routeInfo = connectionRouteInfo(connectionRoute)
  const routeDotColor =
    connectionRoute === 'relay' ? styles.COLOR_ROUTE_RELAY : styles.COLOR_ROUTE_DIRECT

  const isMobile = useIsMobileViewport()
  const cardStyle = isMobile ? { ...styles.card, ...styles.cardMobile } : styles.card
  const videoStageStyle = isMobile
    ? { ...styles.videoStage, ...styles.videoStageMobile }
    : styles.videoStage
  const controlButtonStyle = isMobile ? { ...styles.button, ...styles.buttonMobile } : styles.button

  return (
    <div role="dialog" aria-label="Call" style={cardStyle}>
      <div style={styles.title}>{title}</div>
      {hasVideo ? (
        <div style={videoStageStyle}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- remote peer video+audio, not user-facing captioned media */}
          <video ref={remoteVideoRef} autoPlay playsInline style={styles.remoteVideo} />
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- local self-preview, muted (no audio needed) */}
          <video ref={localVideoRef} autoPlay playsInline muted style={styles.localVideo} />
        </div>
      ) : (
        <div style={styles.participantsRow}>
          <div style={styles.participantColumn}>
            <SpeakingRing label="You" level={localLevel} muted={muted} />
            <div style={styles.participantLabel}>You</div>
          </div>
          <div style={styles.participantColumn}>
            <SpeakingRing label={title} level={remoteLevel} />
            <div style={styles.participantLabel}>{title}</div>
          </div>
        </div>
      )}
      <div style={error != null ? styles.errorText : styles.subtitle}>
        {error ?? statusText(direction, state)}
      </div>
      {error == null && state === 'connected' && routeInfo != null && (
        // Non-blocking troubleshooting hint (docs/calls.md M5) — plain text,
        // not a dialog/prompt; there is no control here to act on (no
        // forced-relay setting exists — see #93).
        <div style={styles.connectionRoute} title={routeInfo.title}>
          <span style={{ ...styles.connectionRouteDot, background: routeDotColor }} />
          {routeInfo.label}
        </div>
      )}
      {screenShareError != null && error == null && (
        <div style={styles.deviceSwitchError}>{screenShareError}</div>
      )}
      {!hasVideo && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- remote audio sink, not user-facing media
        <audio ref={audioRef} autoPlay style={{ display: 'none' }} />
      )}
      {canMute && error == null && (
        <DevicePicker
          microphones={microphones}
          cameras={cameras}
          hasVideo={hasVideo}
          selectedMicrophoneId={selectedMicrophoneId}
          selectedCameraId={selectedCameraId}
          deviceSwitchError={deviceSwitchError}
          onSelectMicrophone={onSelectMicrophone}
          onSelectCamera={onSelectCamera}
        />
      )}
      <div style={styles.buttonRow}>
        {canMute && error == null && (
          <button
            type="button"
            onClick={onToggleMute}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            style={{
              ...controlButtonStyle,
              background: muted ? styles.COLOR_NEUTRAL_ACTIVE : styles.COLOR_NEUTRAL,
            }}
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
        )}
        {hasVideo && canMute && error == null && (
          <button
            type="button"
            onClick={onToggleScreenShare}
            aria-pressed={screenSharing}
            aria-label={screenSharing ? 'Stop sharing screen' : 'Share screen'}
            style={{
              ...controlButtonStyle,
              background: screenSharing ? styles.COLOR_NEUTRAL_ACTIVE : styles.COLOR_NEUTRAL,
            }}
          >
            {screenSharing ? 'Stop sharing' : 'Share screen'}
          </button>
        )}
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
