/**
 * Mic/camera enumeration (M2, docs/calls.md: "Input-device selection: when
 * more than one mic/camera exists, let the user choose (and switch
 * mid-call)"). Pure module — no DOM/React *imports* (same rule as the rest of
 * engine/); `MediaDeviceInfo`/`MediaDeviceKind` are ambient WebRTC/DOM
 * *types*, not imports. The actual `navigator.mediaDevices.enumerateDevices`
 * call is injected via {@link DeviceEnumerator} (mirrors how
 * {@link AudioCallMediaFactories} injects `getUserMedia` in audio-call.ts) so
 * this stays unit-testable with a fake list and reusable from a future popup
 * window, per docs/calls.md.
 *
 * Only `audioinput`/`videoinput` are surfaced (mic/camera pickers, per the
 * task) — `audiooutput` (speaker selection) is a `setSinkId` concern on an
 * `<audio>`/`<video>` element, not something an `RTCRtpSender.replaceTrack`
 * hot-switch applies to, and is out of scope here.
 */

/** The subset of `MediaDeviceInfo` the call UI/engine needs — deliberately
 * NOT the whole DOM interface (which also has non-enumerable prototype
 * methods a plain test fixture object wouldn't have). */
export interface CallDeviceInfo {
  readonly deviceId: string;
  readonly label: string;
  readonly kind: 'audioinput' | 'videoinput';
}

/** Injected seam for `navigator.mediaDevices.enumerateDevices()` — see the
 * module doc for why this isn't called directly from engine/. */
export interface DeviceEnumerator {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

export interface InputDevices {
  readonly microphones: CallDeviceInfo[];
  readonly cameras: CallDeviceInfo[];
}

const EMPTY_INPUT_DEVICES: InputDevices = { microphones: [], cameras: [] };

/**
 * Split a raw `enumerateDevices()` result into mic/camera lists, applying
 * {@link withFallbackLabel}. Devices with an empty `deviceId` (seen on some
 * browsers for the "default"/"communications" duplicate entries pre-permission)
 * are dropped — an empty id can't be passed back as `{ deviceId: { exact } }`.
 * Pure function: takes the already-enumerated array, so it is trivially
 * unit-testable without a `navigator` at all.
 */
export function partitionInputDevices(devices: readonly MediaDeviceInfo[]): InputDevices {
  const microphones: CallDeviceInfo[] = [];
  const cameras: CallDeviceInfo[] = [];
  let micIndex = 0;
  let cameraIndex = 0;
  for (const device of devices) {
    if (device.deviceId === '') continue;
    if (device.kind === 'audioinput') {
      micIndex += 1;
      microphones.push({
        deviceId: device.deviceId,
        label: withFallbackLabel(device.label, 'Microphone', micIndex),
        kind: 'audioinput',
      });
    } else if (device.kind === 'videoinput') {
      cameraIndex += 1;
      cameras.push({
        deviceId: device.deviceId,
        label: withFallbackLabel(device.label, 'Camera', cameraIndex),
        kind: 'videoinput',
      });
    }
  }
  return { microphones, cameras };
}

/**
 * `MediaDeviceInfo.label` is the empty string until the page holds an active
 * `getUserMedia` grant for that kind (browser privacy: no fingerprinting via
 * device names before consent) — expected for a *picker shown before the call
 * starts*, less so mid-call. Either way, an unlabeled device must still be
 * selectable, so fall back to a stable, numbered placeholder rather than
 * showing a blank picker entry.
 */
function withFallbackLabel(label: string, kind: 'Microphone' | 'Camera', index: number): string {
  return label !== '' ? label : `${kind} ${index}`;
}

/** Enumerate + partition in one call — the convenience path the bridge/UI use. */
export async function enumerateInputDevices(enumerator: DeviceEnumerator): Promise<InputDevices> {
  try {
    const devices = await enumerator.enumerateDevices();
    return partitionInputDevices(devices);
  } catch {
    // Best-effort: no `enumerateDevices` support, or it threw (seen on some
    // locked-down browser configs) — just means no picker is shown, not a
    // reason to fail the call.
    return EMPTY_INPUT_DEVICES;
  }
}

/**
 * The picker-visibility rule (task/docs/calls.md): "Only show a picker when
 * >1 device of a kind exists" — a single mic/camera (or none — nothing to
 * switch to) means the picker would be pure noise.
 */
export function shouldShowDevicePicker(devices: readonly CallDeviceInfo[]): boolean {
  return devices.length > 1;
}
