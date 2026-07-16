/**
 * `packages/calls` engine layer — public export surface: signaling, ICE
 * gathering, call engine/state machine, devices, level metering, route
 * detection, constants. Framework-agnostic pure TS, ZERO DOM/React imports
 * (WebRTC lib types are ambient only). Wire format: `INTEROP.md`; overview:
 * the package `README.md`.
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
  type DataChannelLike,
  type RtpSenderLike,
  type RtpTransceiverLike,
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
  serializeOffer,
  serializeAnswer,
  deserializeOffer,
  deserializeAnswer,
} from './signaling.ts';

export {
  type ConnectionRoute,
  type RtcStatsEntry,
  type StatsReportLike,
  type StatsPeerConnectionLike,
  type ConnectionRouteMonitorOptions,
  getActiveConnectionRoute,
  ConnectionRouteMonitor,
  DEFAULT_CONNECTION_ROUTE_INTERVAL_MS,
} from './connection-route.ts';

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
