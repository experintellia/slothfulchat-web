/**
 * The in-page call overlay: status, remote audio/video, mute, camera,
 * screen share, device picker, hang up. Rendered for every non-ring state of
 * an active call — only an *incoming* ring gets `IncomingCallRing`.
 *
 * The media controls are gated on `connecting`/`connected`: an incoming call
 * has no mic while ringing, so earlier they would do nothing.
 *
 * Stable layout: ONE persistent fixed-size stage holds the remote participant
 * (their `<video>` when `remoteHasVideo`, else their speaking ring) with the
 * local self-view always in a corner PiP slot — the card's geometry never
 * changes when video starts/stops on either side. The hidden `<audio>` sink
 * stays mounted throughout; it is blanked while the remote `<video>` plays
 * (which carries the same stream's audio).
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
  /** Remote avatar URL, or `null` for the initial-letter fallback. */
  remoteAvatarUrl: string | null
  /** Local ("You") avatar URL, or `null` for the initial-letter fallback. */
  localAvatarUrl: string | null
  muted: boolean
  /** Whether this call STARTED with the camera on. Does NOT gate tiles or
   * controls — `localHasVideo`/`remoteHasVideo` decide the tiles. */
  hasVideo: boolean
  /** Whether the local camera is currently on — camera button pressed state. */
  cameraOn: boolean
  /** A local video track is flowing (camera OR screen share) — gates the
   * local video tile. */
  localHasVideo: boolean
  /** A remote video track is flowing — gates remote video tile vs. ring. */
  remoteHasVideo: boolean
  /** Peer reports its mic muted — shows the remote muted-mic badge. */
  remoteAudioMuted?: boolean
  remoteStream: MediaStream | null
  /** Local mic/camera stream. `null` while an incoming call is still ringing. */
  localStream: MediaStream | null
  /** Whether the outgoing video is currently a screen capture. */
  screenSharing: boolean
  /** Non-fatal screen-share failure, shown inline (contrast `error`). */
  screenShareError: string | null
  error: string | null
  /** Smoothed 0..1 local-mic level (speaking ring). */
  localLevel: number
  /** Smoothed 0..1 remote-peer level (speaking ring). */
  remoteLevel: number
  /** Direct-vs-relay indicator; `'unknown'` until connected + first poll. */
  connectionRoute: ConnectionRoute
  /** Device picker inputs — see `DevicePicker.tsx`. */
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

/** Label + tooltip for the direct-vs-relay indicator; `null` for `'unknown'`
 * (still gathering stats) — show nothing rather than a placeholder. */
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
        // Autoplay may be deferred, but the call flow started from a user
        // gesture so this succeeds in practice; not worth surfacing.
      })
    }
  }, [remoteStream, remoteHasVideo])

  useEffect(() => {
    const videoEl = remoteVideoRef.current
    if (videoEl == null || !remoteHasVideo) return
    videoEl.srcObject = remoteStream
    if (remoteStream != null) {
      videoEl.play().catch(() => {
        // See the audio effect above.
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
    // Re-runs when the store re-pushes `localStream` on a track (re)establish —
    // see `CallsUiStore.setLocalStream` for why identity alone isn't enough.
  }, [localStream, localHasVideo])

  const canMute = state === 'connecting' || state === 'connected'
  // The three media toggles stay mounted from the first render so the button
  // row never changes size — just disabled + dimmed until they can work.
  const controlsDisabled = !canMute || error != null
  // "Enumerated, no camera found" — `microphones.length > 0` distinguishes
  // that from "not yet enumerated" (both lists are [] until the async
  // enumeration on the connecting transition lands; a live call implies a
  // mic, so a populated mic list means the camera list is authoritative).
  // Hotplug re-enumeration (`devicechange`) clears this automatically.
  const noCamera = microphones.length > 0 && cameras.length === 0
  const cameraDisabled = controlsDisabled || noCamera

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
  // Bigger avatar rings on the roomier centered desktop card.
  const ringSize = isMobile ? 72 : 104

  return (
    <div role="dialog" aria-label="Call" style={cardStyle}>
      <div style={styles.title}>{title}</div>
      <div style={videoStageStyle}>
        {remoteHasVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- remote peer video+audio, not user-facing captioned media
          <video ref={remoteVideoRef} autoPlay playsInline style={styles.remoteVideo} />
        ) : (
          // No remote video — a centered speaking ring instead of a black
          // frame. Audio rides the <audio> sink.
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
        ) : error == null && noCamera ? (
          <span style={styles.connectionRoute}>No camera detected</span>
        ) : error == null && state === 'connected' && routeInfo != null ? (
          // Non-blocking troubleshooting hint — plain text, never a dialog
          // (no forced-relay setting exists to act on — see #93).
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
          disabled={cameraDisabled}
          aria-pressed={cameraOn}
          aria-label={noCamera ? 'No camera detected' : cameraOn ? 'Turn camera off' : 'Turn camera on'}
          title={noCamera ? 'No camera detected' : undefined}
          style={{
            ...controlButtonStyle,
            background: cameraOn ? styles.COLOR_NEUTRAL_ACTIVE : styles.COLOR_NEUTRAL,
            ...(cameraDisabled ? { opacity: 0.45, cursor: 'default' as const } : {}),
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

/** Muted-mic badge (inline SVG) — absolutely positioned by the caller on the
 * corner of a participant tile/ring. */
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
