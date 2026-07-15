/**
 * Mic/camera picker. Purely presentational — only reports the user's choice
 * via `onSelectMicrophone`/`onSelectCamera` (the runtime wires the actual
 * hot-switch). Each row is only rendered when its kind has more than one
 * device — no picker for a choice of one. The camera row shows even while
 * the camera is off: picking then records the preference used on the next
 * enable (see `AudioCallEngine.switchCamera`).
 */
import type { CallDeviceInfo } from '../engine/index.ts'
import * as styles from './styles.ts'

export interface DevicePickerProps {
  microphones: CallDeviceInfo[]
  cameras: CallDeviceInfo[]
  selectedMicrophoneId: string | null
  selectedCameraId: string | null
  /** Non-fatal mic hot-switch failure, shown inline next to the picker. */
  deviceSwitchError: string | null
  onSelectMicrophone(deviceId: string): void
  onSelectCamera(deviceId: string): void
}

export function DevicePicker({
  microphones,
  cameras,
  selectedMicrophoneId,
  selectedCameraId,
  deviceSwitchError,
  onSelectMicrophone,
  onSelectCamera,
}: DevicePickerProps) {
  const showMicPicker = microphones.length > 1
  const showCameraPicker = cameras.length > 1
  if (!showMicPicker && !showCameraPicker) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
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
