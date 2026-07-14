/**
 * `packages/calls` — engine layer (framework-agnostic, pure TS, ZERO DOM/React
 * imports; WebRTC lib types are ambient only). See `INTEROP.md` for the wire
 * format spec this implements.
 *
 * M0 surface: the calls-webapp-compatible signaling (de)serializer + the
 * non-trickle ICE gathering policy + the shared RTC constants. The full WebRTC
 * state machine (getUserMedia, RTCPeerConnection lifecycle, replaceTrack, audio
 * metering) lands in later milestones and will import from here.
 */

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
