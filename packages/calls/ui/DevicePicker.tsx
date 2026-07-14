/**
 * Mic/camera picker (M2, docs/calls.md: "when more than one mic/camera
 * exists, let the user choose (and switch mid-call)"). Purely presentational
 * and driven by `engine/devices.ts`'s {@link shouldShowDevicePicker}: each
 * `<select>` row is only rendered when its kind actually has more than one
 * device, so a typical single-mic/no-camera laptop shows nothing extra at
 * all — no picker for a choice of one.
 *
 * Both selects hot-switch mid-call via `AudioCallEngine.switchMicrophone`/
 * `switchCamera` + `RTCRtpSender.replaceTrack` (wired by the runtime's
 * `CallManager`, not here — this component only reports the user's choice
 * via `onSelectMicrophone`/`onSelectCamera`). The camera select only has a
 * live track to switch on a call that carries video (`hasVideo`, M3), so it is
 * shown ONLY on a video call — on an audio-only call there is nothing to
 * switch (a call's video-ness is fixed at placement/accept), so no camera row
 * appears at all.
 */
import type { CallDeviceInfo } from '../engine/index.ts'
import * as styles from './styles.ts'

export interface DevicePickerProps {
  microphones: CallDeviceInfo[]
  cameras: CallDeviceInfo[]
  /** Whether this call carries video (M3). The camera picker is hidden on an
   * audio-only call — there is no live video track to hot-switch, so offering
   * the choice would only lead to a dead selection. */
  hasVideo: boolean
  selectedMicrophoneId: string | null
  selectedCameraId: string | null
  /** Set if the last `onSelectMicrophone` hot-switch failed
   * (`AudioCallEngine`'s `onDeviceSwitchError`) — the call keeps running on
   * the previous mic; this is just an inline note next to the picker. */
  deviceSwitchError: string | null
  onSelectMicrophone(deviceId: string): void
  onSelectCamera(deviceId: string): void
}

export function DevicePicker({
  microphones,
  cameras,
  hasVideo,
  selectedMicrophoneId,
  selectedCameraId,
  deviceSwitchError,
  onSelectMicrophone,
  onSelectCamera,
}: DevicePickerProps) {
  const showMicPicker = microphones.length > 1
  const showCameraPicker = hasVideo && cameras.length > 1
  if (!showMicPicker && !showCameraPicker) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      {showMicPicker && (
        <div style={styles.deviceRow}>
          <label htmlFor="slothfulchat-call-mic-select" style={styles.deviceLabel}>
            Mic
          </label>
          <select
            id="slothfulchat-call-mic-select"
            style={styles.deviceSelect}
            value={selectedMicrophoneId ?? microphones[0]?.deviceId ?? ''}
            onChange={(e) => onSelectMicrophone(e.target.value)}
          >
            {microphones.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {showCameraPicker && (
        <div style={styles.deviceRow}>
          <label htmlFor="slothfulchat-call-camera-select" style={styles.deviceLabel}>
            Camera
          </label>
          <select
            id="slothfulchat-call-camera-select"
            style={styles.deviceSelect}
            value={selectedCameraId ?? cameras[0]?.deviceId ?? ''}
            onChange={(e) => onSelectCamera(e.target.value)}
          >
            {cameras.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {deviceSwitchError != null && <div style={styles.deviceSwitchError}>{deviceSwitchError}</div>}
    </div>
  )
}
