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
 * of the initial `hasVideo`. Video `<video>` tiles are rendered whenever a
 * video track is ACTUALLY flowing — local (`localHasVideo`: camera on or screen
 * sharing) and/or remote (`remoteHasVideo`) — otherwise the audio-only speaking
 * rings. A hidden `<audio>` sink plays the remote audio whenever the remote
 * `<video>` isn't (i.e. the remote isn't sending video).
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
   * state of the camera button; also whether the camera device picker shows. */
  cameraOn: boolean
  /** Whether a local video track is actually flowing (camera on OR screen
   * sharing) — gates the local video tile. */
  localHasVideo: boolean
  /** Whether a remote video track is actually flowing — gates the remote
   * video tile vs. the remote speaking ring. */
  remoteHasVideo: boolean
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
  // A video stage is shown whenever EITHER side has live video (FIX 1). The
  // remote audio still needs a sink whenever the remote video isn't playing it.
  const showVideoStage = localHasVideo || remoteHasVideo
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)

  // Audio-only sink: used whenever the remote video isn't playing the remote
  // audio (no remote video track flowing). A remote <video> below plays that
  // same stream's audio track, so a separate <audio> would double it.
  useEffect(() => {
    const audioEl = audioRef.current
    if (audioEl == null || remoteHasVideo) return
    audioEl.srcObject = remoteStream
    if (remoteStream != null) {
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
      {showVideoStage ? (
        <div style={videoStageStyle}>
          {remoteHasVideo ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- remote peer video+audio, not user-facing captioned media
            <video ref={remoteVideoRef} autoPlay playsInline style={styles.remoteVideo} />
          ) : (
            // Local video is up but the remote isn't sending any — show the
            // remote as a centered speaking ring (with avatar) over the stage
            // rather than a black frame. Its audio rides the hidden <audio> sink.
            <div style={styles.remoteRingInStage}>
              <SpeakingRing label={title} level={remoteLevel} avatarUrl={remoteAvatarUrl} size={96} />
              <div style={styles.participantLabel}>{title}</div>
            </div>
          )}
          {localHasVideo && (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- local self-preview, muted (no audio needed)
            <video ref={localVideoRef} autoPlay playsInline muted style={styles.localVideo} />
          )}
        </div>
      ) : (
        <div style={styles.participantsRow}>
          <div style={styles.participantColumn}>
            <SpeakingRing label="You" level={localLevel} muted={muted} avatarUrl={localAvatarUrl} />
            <div style={styles.participantLabel}>You</div>
          </div>
          <div style={styles.participantColumn}>
            <SpeakingRing label={title} level={remoteLevel} avatarUrl={remoteAvatarUrl} />
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
      {!remoteHasVideo && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- remote audio sink, not user-facing media
        <audio ref={audioRef} autoPlay style={{ display: 'none' }} />
      )}
      {canMute && error == null && (
        <DevicePicker
          microphones={microphones}
          cameras={cameras}
          cameraActive={cameraOn}
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
        {canMute && error == null && (
          <button
            type="button"
            onClick={onToggleCamera}
            aria-pressed={cameraOn}
            aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
            style={{
              ...controlButtonStyle,
              background: cameraOn ? styles.COLOR_NEUTRAL_ACTIVE : styles.COLOR_NEUTRAL,
            }}
          >
            {cameraOn ? 'Camera off' : 'Camera on'}
          </button>
        )}
        {canMute && error == null && (
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
