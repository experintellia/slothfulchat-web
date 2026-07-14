# Signaling test fixtures

`offer.sdp` and `answer.sdp` are authentic Chromium-style unified-plan SDP as
`deltachat/calls-webapp` produces them: audio + video m-lines plus an
`m=application` datachannel section (`bundlePolicy: "max-bundle"`), with gathered
`srflx` (STUN) and `relay` (TURN) candidate lines — i.e. a *non-trickle* offer
with candidates already embedded. They use CRLF line endings and a trailing CRLF,
exactly as `RTCPeerConnection.localDescription.sdp` yields.

The round-trip tests (`../signaling.test.ts`) assert our serializer preserves
these bytes verbatim (no base64 / JSON / url-encoding / newline mangling), which
is the whole interop requirement — see `../INTEROP.md`.

IP addresses use documentation ranges (RFC 5737: `192.0.2.0/24`,
`198.51.100.0/24`, `203.0.113.0/24`); ufrag/pwd/fingerprints are placeholders.

Regenerate with: `node scripts/gen-calls-fixtures.mjs` (from repo root).
