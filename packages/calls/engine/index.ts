/**
 * `packages/calls` — engine layer (framework-agnostic, pure TS, ZERO DOM/React
 * imports; WebRTC lib types are ambient only). See `INTEROP.md` for the wire
 * format spec this implements.
 *
 * M0 surface: the calls-webapp-compatible signaling (de)serializer + the
 * non-trickle ICE gathering policy + the shared RTC constants.
 *
 * M1 surface: the audio-only WebRTC engine (getUserMedia, RTCPeerConnection
 * lifecycle, non-trickle offer/answer orchestration, clean teardown) and the
 * observable call-state machine that backs it. `replaceTrack`, device
 * enumeration and audio metering land in later milestones and import from here.
 *
 * M2 surface: mic/camera enumeration (`devices.ts`) and mid-call microphone
 * hot-switching (`AudioCallEngine.switchMicrophone`, via
 * `RTCRtpSender.replaceTrack` — no renegotiation needed since the audio
 * m-line/codec set is unchanged); per-track audio-level metering
 * (`level-meter.ts`, `TrackLevelMeter`) driving the UI's speaking rings
 * (local + remote).
 */

export {
  type CallState,
  type CallDirection,
  type CallStateChange,
  type CallStateListener,
  CallStateMachine,
} from './call-state.ts';

export {
  type PeerConnectionLike,
  type RtpSenderLike,
  type AudioCallMediaFactories,
  type AudioCallCallbacks,
  type AudioCallOptions,
  AudioCallEngine,
} from './audio-call.ts';

export {
  type CallDeviceInfo,
  type DeviceEnumerator,
  type InputDevices,
  partitionInputDevices,
  enumerateInputDevices,
  shouldShowDevicePicker,
} from './devices.ts';

export {
  type AnalyserLike,
  type TrackLevelMeterOptions,
  TrackLevelMeter,
  computeRmsLevel,
  DEFAULT_LEVEL_GAIN,
  DEFAULT_LEVEL_INTERVAL_MS,
  DEFAULT_LEVEL_SMOOTHING,
} from './level-meter.ts';

export {
  type CallSdpType,
  type CallSessionDescription,
  serializeCallInfo,
  serializeOffer,
  serializeAnswer,
  deserializeOffer,
  deserializeAnswer,
  webappHashEncode,
  webappHashDecode,
} from './signaling.ts';

export {
  type GatheringPeerConnection,
  type GatherOptions,
  gatherUntilEnoughIce,
  hasTurnServer,
} from './ice-gathering.ts';

export {
  CALLS_WEBAPP_RTC_CONFIGURATION,
  ICE_TRICKLING_DATA_CHANNEL,
  MUTED_STATE_DATA_CHANNEL,
  RELAY_CANDIDATE_SETTLE_MS,
  SRFLX_CANDIDATE_SETTLE_MS,
} from './constants.ts';
