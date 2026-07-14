import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  partitionInputDevices,
  enumerateInputDevices,
  shouldShowDevicePicker,
  type DeviceEnumerator,
} from './devices.ts';

// `MediaDeviceInfo` is a DOM interface with more members than the browser
// exposes to script (and none of them are enumerable own-properties on a
// plain object) — a minimal structural fixture is enough for these pure
// functions, cast at the boundary like the rest of engine/'s fakes.
function fakeDevice(kind: string, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label } as unknown as MediaDeviceInfo;
}

test('partitionInputDevices splits audioinput/videoinput and ignores other kinds', () => {
  const devices = [
    fakeDevice('audioinput', 'mic-1', 'Built-in Mic'),
    fakeDevice('videoinput', 'cam-1', 'FaceTime HD'),
    fakeDevice('audiooutput', 'spk-1', 'Speakers'), // ignored — not an input picker concern
    fakeDevice('audioinput', 'mic-2', 'USB Headset'),
  ];
  const { microphones, cameras } = partitionInputDevices(devices);
  assert.deepEqual(
    microphones.map((d) => d.deviceId),
    ['mic-1', 'mic-2']
  );
  assert.deepEqual(
    cameras.map((d) => d.deviceId),
    ['cam-1']
  );
  assert.equal(microphones[0].kind, 'audioinput');
  assert.equal(cameras[0].kind, 'videoinput');
});

test('partitionInputDevices drops entries with an empty deviceId', () => {
  const devices = [fakeDevice('audioinput', '', 'Default'), fakeDevice('audioinput', 'mic-1', 'Real Mic')];
  const { microphones } = partitionInputDevices(devices);
  assert.deepEqual(
    microphones.map((d) => d.deviceId),
    ['mic-1']
  );
});

test('partitionInputDevices falls back to a numbered label when the browser withholds it (no permission yet)', () => {
  const devices = [
    fakeDevice('audioinput', 'mic-1', ''),
    fakeDevice('audioinput', 'mic-2', ''),
    fakeDevice('videoinput', 'cam-1', ''),
  ];
  const { microphones, cameras } = partitionInputDevices(devices);
  assert.deepEqual(
    microphones.map((d) => d.label),
    ['Microphone 1', 'Microphone 2']
  );
  assert.deepEqual(
    cameras.map((d) => d.label),
    ['Camera 1']
  );
});

test('partitionInputDevices keeps a real label untouched', () => {
  const devices = [fakeDevice('audioinput', 'mic-1', 'USB Headset Mic')];
  const { microphones } = partitionInputDevices(devices);
  assert.equal(microphones[0].label, 'USB Headset Mic');
});

test('shouldShowDevicePicker: >1 device shows, 0 or 1 does not', () => {
  const one: ReturnType<typeof partitionInputDevices>['microphones'] = [
    { deviceId: 'a', label: 'A', kind: 'audioinput' },
  ];
  const two = [...one, { deviceId: 'b', label: 'B', kind: 'audioinput' as const }];
  assert.equal(shouldShowDevicePicker([]), false);
  assert.equal(shouldShowDevicePicker(one), false);
  assert.equal(shouldShowDevicePicker(two), true);
});

test('enumerateInputDevices wraps an injected DeviceEnumerator', async () => {
  const enumerator: DeviceEnumerator = {
    enumerateDevices: async () => [
      fakeDevice('audioinput', 'mic-1', 'Mic'),
      fakeDevice('videoinput', 'cam-1', 'Cam'),
    ],
  };
  const result = await enumerateInputDevices(enumerator);
  assert.equal(result.microphones.length, 1);
  assert.equal(result.cameras.length, 1);
});

test('enumerateInputDevices is best-effort: a throwing enumerator yields empty lists, not a rejection', async () => {
  const enumerator: DeviceEnumerator = {
    enumerateDevices: async () => {
      throw new Error('NotAllowedError');
    },
  };
  const result = await enumerateInputDevices(enumerator);
  assert.deepEqual(result, { microphones: [], cameras: [] });
});
