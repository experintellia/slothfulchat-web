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
 */
import { useEffect, useRef } from 'react'
import type { CallDeviceInfo, CallDirection, CallState } from '../engine/index.ts'
import { DevicePicker } from './DevicePicker.tsx'
import { SpeakingRing } from './SpeakingRing.tsx'
import * as styles from './styles.ts'

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

  return (
    <div role="dialog" aria-label="Call" style={styles.card}>
      <div style={styles.title}>{title}</div>
      {hasVideo ? (
        <div style={styles.videoStage}>
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
              ...styles.button,
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
              ...styles.button,
              background: screenSharing ? styles.COLOR_NEUTRAL_ACTIVE : styles.COLOR_NEUTRAL,
            }}
          >
            {screenSharing ? 'Stop sharing' : 'Share screen'}
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
