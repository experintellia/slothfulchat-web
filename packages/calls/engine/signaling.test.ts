import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  serializeCallInfo,
  serializeOffer,
  serializeAnswer,
  deserializeOffer,
  deserializeAnswer,
  webappHashEncode,
  webappHashDecode,
} from './signaling.ts';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
// Read as latin1 to preserve exact bytes (CRLF, trailing CRLF) — these are real
// Chromium offer/answer SDPs, see fixtures/README + scripts/gen-calls-fixtures.mjs.
const REAL_OFFER_SDP = readFileSync(here('./fixtures/offer.sdp'), 'latin1');
const REAL_ANSWER_SDP = readFileSync(here('./fixtures/answer.sdp'), 'latin1');

test('fixtures look like real gathered SDP (sanity)', () => {
  // Preconditions the round-trip only means something with.
  assert.ok(REAL_OFFER_SDP.startsWith('v=0\r\n'), 'offer starts with v=0 + CRLF');
  assert.ok(REAL_OFFER_SDP.endsWith('\r\n'), 'offer keeps trailing CRLF');
  assert.ok(REAL_OFFER_SDP.includes('\r\n'), 'offer uses CRLF line endings');
  assert.ok(REAL_OFFER_SDP.includes('typ relay'), 'offer has a gathered relay candidate');
  assert.ok(REAL_OFFER_SDP.includes('typ srflx'), 'offer has a gathered srflx candidate');
  assert.ok(REAL_OFFER_SDP.includes('a=mid:0'), 'offer has audio m-line');
  assert.ok(REAL_OFFER_SDP.includes('m=video'), 'offer has video m-line');
  assert.ok(REAL_OFFER_SDP.includes('webrtc-datachannel'), 'offer has datachannel m-line');
  assert.ok(REAL_ANSWER_SDP.startsWith('v=0\r\n') && REAL_ANSWER_SDP.endsWith('\r\n'));
});

test('serializeCallInfo returns the raw SDP verbatim (no base64/JSON/url-encoding)', () => {
  const offerWire = serializeCallInfo({ type: 'offer', sdp: REAL_OFFER_SDP });
  // The single most important interop assertion: byte-for-byte identity.
  assert.equal(offerWire, REAL_OFFER_SDP);
  // Not accidentally JSON-wrapped or base64'd.
  assert.doesNotMatch(offerWire, /^[A-Za-z0-9+/=]+$/, 'must not be a bare base64 blob');
  assert.ok(!offerWire.trimStart().startsWith('{'), 'must not be JSON-wrapped');
});

test('offer round-trips: place_call_info -> setRemoteDescription arg', () => {
  // Caller side: local offer -> place_call_info.
  const placeCallInfo = serializeOffer({ type: 'offer', sdp: REAL_OFFER_SDP });
  assert.equal(placeCallInfo, REAL_OFFER_SDP);

  // Callee side: place_call_info (from IncomingCall event) -> setRemoteDescription.
  const remote = deserializeOffer(placeCallInfo);
  assert.deepEqual(remote, { type: 'offer', sdp: REAL_OFFER_SDP });
  // Exactly the object calls-webapp builds: { type: "offer", sdp: payload }.
  assert.equal(remote.type, 'offer');
  assert.equal(remote.sdp, REAL_OFFER_SDP);
});

test('answer round-trips: accept_call_info -> setRemoteDescription arg', () => {
  const acceptCallInfo = serializeAnswer({ type: 'answer', sdp: REAL_ANSWER_SDP });
  assert.equal(acceptCallInfo, REAL_ANSWER_SDP);

  const remote = deserializeAnswer(acceptCallInfo);
  assert.deepEqual(remote, { type: 'answer', sdp: REAL_ANSWER_SDP });
});

test('full offer/answer exchange preserves both SDPs exactly', () => {
  // Caller -> place_call_info -> callee reads it.
  const place = serializeOffer({ type: 'offer', sdp: REAL_OFFER_SDP });
  const callerOfferAsSeenByCallee = deserializeOffer(place);
  assert.equal(callerOfferAsSeenByCallee.sdp, REAL_OFFER_SDP);

  // Callee -> accept_call_info -> caller reads it.
  const accept = serializeAnswer({ type: 'answer', sdp: REAL_ANSWER_SDP });
  const calleeAnswerAsSeenByCaller = deserializeAnswer(accept);
  assert.equal(calleeAnswerAsSeenByCaller.sdp, REAL_ANSWER_SDP);
});

test('serializeCallInfo accepts a real-ish RTCSessionDescription shape', () => {
  // pc.localDescription is { type, sdp, toJSON } — extra props must be fine.
  const localDescriptionLike = {
    type: 'offer' as const,
    sdp: REAL_OFFER_SDP,
    toJSON() {
      return { type: this.type, sdp: this.sdp };
    },
  };
  assert.equal(serializeCallInfo(localDescriptionLike), REAL_OFFER_SDP);
});

test('type guards reject mismatches and empty payloads', () => {
  assert.throws(() => serializeOffer({ type: 'answer', sdp: 'x' }), /expected an offer/);
  assert.throws(() => serializeAnswer({ type: 'offer', sdp: 'x' }), /expected an answer/);
  assert.throws(() => serializeCallInfo({ type: 'offer', sdp: '' }), /non-empty SDP/);
  // @ts-expect-error deliberately wrong type
  assert.throws(() => serializeCallInfo({ type: 'pranswer', sdp: 'x' }), /offer.*answer/);
  assert.throws(() => deserializeOffer(''), /non-empty SDP/);
  // @ts-expect-error deliberately wrong type
  assert.throws(() => deserializeAnswer(null), /non-empty SDP/);
});

test('webapp URL-hash codec round-trips base64 + url-encoding (NOT the wire format)', () => {
  const encoded = webappHashEncode(REAL_OFFER_SDP);
  // base64 padding + '+' and '/' must be url-escaped for a valid URL fragment.
  assert.ok(!encoded.includes('='), '"=" padding must be url-encoded (%3D)');
  assert.ok(!encoded.includes('+') && !encoded.includes('/'), 'base64 +// must be escaped');
  assert.equal(webappHashDecode(encoded), REAL_OFFER_SDP);

  // Also decodes the plain-btoa form deltachat-desktop's preload actually emits
  // (no url-encoding). Build it the same way: btoa(sdp).
  const plainBtoa = (globalThis.btoa ?? ((s: string) => Buffer.from(s, 'binary').toString('base64')))(
    REAL_OFFER_SDP
  );
  assert.equal(webappHashDecode(plainBtoa), REAL_OFFER_SDP);
});
