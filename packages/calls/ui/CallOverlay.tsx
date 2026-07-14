/**
 * The in-page call overlay: status ("Calling…"/"Connecting…"/"In call"),
 * remote-audio sink, hang up, and mute. Rendered for every non-ring state of
 * an active call (outgoing ringing/"calling…" included — only an *incoming*
 * ring gets the separate accept/decline dialog, see `IncomingCallRing`).
 *
 * No device pickers yet; mute is a local-only `track.enabled` toggle
 * (`AudioCallEngine.setMuted` — see its doc comment), so it is available as
 * soon as a local stream exists, i.e. once `state` is `connecting` or
 * `connected` (outgoing calls acquire the mic while still `ringing`, but we
 * gate on connecting/connected uniformly so an incoming call — mic-less while
 * ringing — never shows a mute button that would do nothing).
 *
 * M2 adds a `SpeakingRing` per participant (local "You" + the remote title),
 * driven by `localLevel`/`remoteLevel` — the bridge's Web-Audio meters
 * (docs/calls.md: "a glowing ring around each participant avatar that reacts
 * to their voice level"). Still audio-only (no camera video, M3), so these
 * are the whole "tile" for each participant, not an overlay on a video frame.
 *
 * M2 also adds the mic/camera `DevicePicker`, shown alongside mute (same
 * `connecting`/`connected` gate — a device picker before the mic exists would
 * have nothing to switch) and only rendered at all once
 * `shouldShowDevicePicker` says there is an actual choice.
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
  remoteStream: MediaStream | null
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
  // Metering only starts once the respective stream exists (see
  // CallBridge.ensureLocalLevelMeter/startRemoteLevelMeter); before that the
  // store's level fields are simply 0, which SpeakingRing renders as a dark,
  // non-glowing ring rather than a misleading "definitely not talking" state.

  return (
    <div role="dialog" aria-label="Call" style={styles.card}>
      <div style={styles.title}>{title}</div>
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
      <div style={error != null ? styles.errorText : styles.subtitle}>
        {error ?? statusText(direction, state)}
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
