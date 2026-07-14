// Deterministic, milestone-gated orchestration for implementing native WebRTC
// calls (see docs/calls.md). Runs ONE milestone per invocation so the human keeps
// the stop/go gate: review the diff + go/no-go report, then re-invoke for the next.
//
//   Workflow({ name: 'calls-impl', args: 'M0' })     // or { milestone: 'M0' }
//
// Within a milestone it fans build tasks out in parallel, runs an adversarial
// review on the risky ones (engine state machine + interop serializer), then runs
// the milestone's verify. It does NOT commit or push — that stays a human step,
// which is the whole point of the gate. Source of truth is docs/calls.md; if the
// repo contradicts the plan, agents are told to STOP and report rather than drift.

export const meta = {
  name: 'calls-impl',
  description: 'Milestone-gated multi-agent build of native WebRTC calls (docs/calls.md)',
  whenToUse: 'Run one milestone (M0..M5) of the calls plan; review, then re-invoke for the next.',
  phases: [
    { title: 'Plan' },
    { title: 'Build' },
    { title: 'Review' },
    { title: 'Verify' },
  ],
}

// ---- structured subagent outputs (validated at the tool layer) --------------

const TASK_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['task', 'status', 'summary', 'files_touched'],
  properties: {
    task: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string', description: 'What changed and how it was checked' },
    files_touched: { type: 'array', items: { type: 'string' } },
    follow_ups: { type: 'array', items: { type: 'string' } },
    escalations: {
      type: 'array', items: { type: 'string' },
      description: 'Anything needing a human decision (core patch, CSP/privacy, ambiguity)',
    },
  },
}

const REVIEW_VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'verdict', 'issues'],
  properties: {
    target: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'concerns', 'fail'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
  },
}

const VERIFY_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'evidence', 'go_recommendation'],
  properties: {
    passed: { type: 'boolean' },
    evidence: { type: 'string', description: 'What flow was driven and what was observed' },
    go_recommendation: { type: 'string', enum: ['go', 'no-go'] },
    notes: { type: 'string' },
  },
}

// ---- shared constraints every subagent must honor ---------------------------

const CONSTRAINTS = `
Non-negotiable constraints (from docs/calls.md):
- Source of truth is docs/calls.md. If the repo contradicts it, STOP and report; do not drift.
- Branch: claude/plan-adding-calls-p1gxfp only. Do NOT push or open PRs.
- INTEROP: our peer must be wire-compatible with upstream deltachat/calls-webapp —
  non-trickle ICE (gather until a relay candidate or timeout, then send), matching
  payload format. The far end may be a real Delta Chat client or chatmail/calls-echobot.
- STRUCTURE: one package packages/calls with an enforced split — engine/ (pure TS,
  ZERO React/DOM imports, unit-testable), ui/ (React), bridge/ (glue). Call UI is
  mounted by packages/web-app/src/runtime.ts. Exactly ONE thin patches/desktop patch
  un-gates the ChatView call button (+ optional Message.tsx) for target === 'browser'.
  Desktop patch flow: pnpm apply-patches -> edit build/desktop -> pnpm update-patches.
  Keep patch count MINIMAL (it is the repo's headline metric); new code lives in packages/.
- No core (Rust/WASM) patch is expected. If one seems required (e.g. ice_servers()
  doing host-side DNS), STOP and escalate — do not add core patches unprompted.
- Calls default to standard ICE (direct-preferred, relay fallback). No forced-relay
  setting (that is deferred to issue #93). Audio-first.
Return raw structured data, not human prose. List anything needing a human decision
under "escalations".
`

// Model routing: Opus for the high-stakes reasoning, Sonnet for mechanical bulk.
const OPUS = { model: 'opus', effort: 'high' }
const SONNET = { model: 'sonnet' }

// ---- the plan, encoded as milestone gates -----------------------------------
// Each build task: { label, model, review?, prompt }. review:true routes the
// output through an adversarial verifier before the milestone verify runs.

const MILESTONES = {
  M0: {
    goal: 'Interop spec + package scaffold + un-gate patch',
    build: [
      { label: 'interop-spec', ...OPUS, review: true, prompt:
        `Pin down the EXACT on-the-wire signaling format upstream deltachat/calls-webapp
         puts in place_call_info (offer) and accept_call_info (answer): raw SDP vs
         JSON-wrapped, base64/url-encoding, and its non-trickle ICE gathering/timeout
         behavior. Read the calls-webapp SOURCE (do not ship it). Write a compatible
         (de)serializer spec + a pure-TS module under packages/calls/engine/ with unit
         tests that round-trip a real offer/answer. This spec gates everything after it.` },
      { label: 'scaffold-package', ...SONNET, prompt:
        `Scaffold packages/calls with the engine/ + ui/ + bridge/ split, wired into the
         pnpm workspace and the web-app build. engine/ imports NO React/DOM. Add a lint
         rule or import boundary so that stays true. No feature logic yet — just the
         package skeleton, build config, and a placeholder test that runs.` },
      { label: 'ungate-patch', ...SONNET, prompt:
        `Create ONE thin patches/desktop patch un-gating the ChatView.tsx call button
         (and optionally Message.tsx accept/redial) for target === 'browser', using the
         pnpm apply-patches/update-patches flow. Keep it minimal. Update DESCOPED.md /
         PLAN.md wording if needed.` },
    ],
    verify:
      `Confirm: packages/calls builds and its tests pass (including the interop
       round-trip); engine/ has zero React/DOM imports; the desktop patch applies
       cleanly via pnpm apply-patches and the call button renders for the browser
       target. Report go/no-go for M1.`,
  },

  M1: {
    goal: 'Audio call happy path — outgoing + incoming',
    build: [
      { label: 'engine-audio', ...OPUS, review: true, prompt:
        `Implement the audio-only WebRTC engine in packages/calls/engine/: getUserMedia
         (mic), RTCPeerConnection, non-trickle ICE (gather-until-relay-or-timeout),
         offer/answer via the M0 serializer, ICE servers fed in from outside, clean
         teardown. Expose an observable call-state machine (idle/ringing/connecting/
         connected/ended) with no race between offer/answer/teardown. Unit-test the
         state machine.` },
      { label: 'runtime-bridge', ...OPUS, prompt:
        `In packages/web-app/src/runtime.ts implement startOutgoingVideoCall and
         openIncomingVideoCallWindow (replace the stubs ~L648-653) and subscribe to the
         IncomingCall/OutgoingCallAccepted/IncomingCallAccepted/CallEnded events on the
         existing in-page emitter. Bridge the engine to the typed jsonrpc client
         (rpc.placeOutgoingCall/acceptIncomingCall/endCall/iceServers). Audio only.` },
      { label: 'call-ui', ...SONNET, prompt:
        `Build the minimal React call UI in packages/calls/ui/: an incoming-ring dialog
         (always mounted in the main window) and an in-page call overlay with hangup and
         mute, driven by the engine's observable state. Wire it to be mounted by the
         runtime. No video, no device pickers yet.` },
    ],
    verify:
      `Drive a REAL audio call: place from the browser to a second Delta Chat client (or
       chatmail/calls-echobot) and vice versa. Two-way audio connects; hangup tears down
       both ends; no console errors. Give concrete evidence. go/no-go for M2.`,
  },

  M2: {
    goal: 'Device selection + speaking-ring indicators',
    build: [
      { label: 'device-selection', ...SONNET, prompt:
        `Add mic/camera enumeration (navigator.mediaDevices.enumerateDevices) and a
         picker in the call UI, with mid-call hot-switching via RTCRtpSender.replaceTrack
         in the engine. Only show a picker when >1 device of a kind exists.` },
      { label: 'speaking-rings', ...SONNET, prompt:
        `Add per-track audio-level metering in the engine (Web Audio AnalyserNode, local
         + remote) and a glowing ring around each participant avatar in the UI that
         reacts to voice level (Discord/Jitsi style). Keep the meter in engine/ (no DOM).` },
    ],
    verify:
      `In a real call: switching input devices mid-call works; the avatar rings track who
       is actually talking on both sides. go/no-go for M3.`,
  },

  M3: {
    goal: 'Video + screen share',
    build: [
      { label: 'video', ...SONNET, prompt:
        `Add camera video (has_video), video tiles in the UI, and camera on/off toggle,
         reusing the engine's replaceTrack path.` },
      { label: 'screenshare', ...SONNET, review: true, prompt:
        `Add getDisplayMedia() screen sharing that REPLACES the outgoing camera track via
         replaceTrack, so the remote sees it as the normal video track (compatible with
         calls-webapp peers). Toggling back restores the camera. Verify interop is
         preserved.` },
    ],
    verify:
      `Against a real client: two-way video; screen share appears as normal video to the
       peer; toggling screen<->camera works. go/no-go for M4.`,
  },

  M4: {
    goal: 'Detached popup window with overlay fallback',
    build: [
      { label: 'popup-window', ...OPUS, review: true, prompt:
        `Add an optional detached call window (window.open, same origin) hosting the
         engine + UI, with the popup<->opener signaling IPC (postMessage/BroadcastChannel;
         the popup owns media + RTCPeerConnection and relays SIGNALING ONLY to the opener,
         which forwards to the core Worker). If window.open is blocked or fails, fall back
         seamlessly to the in-page overlay. Ringing always stays in the main window.` },
    ],
    verify:
      `Call runs in the popup; blocking popups falls back to the overlay with no loss of
       function; no core-access breakage. go/no-go for M5.`,
  },

  M5: {
    goal: 'CSP, permissions, privacy, settings, polish, tests',
    build: [
      { label: 'csp-perms', ...OPUS, prompt:
        `Widen the web-app CSP for WebRTC: connect-src for the STUN/TURN hosts returned by
         ice_servers(), and Permissions-Policy / element allow for camera; microphone;
         display-capture. Confirm ice_servers() returns hostnames the BROWSER resolves
         (WASM DNS is stubbed) — if it resolves host-side, STOP and escalate. Document the
         CSP widening; it touches the repo's single-origin privacy stance.` },
      { label: 'settings-privacy', ...SONNET, prompt:
        `Expose WhoCanCallMe in settings. Add a non-blocking direct-vs-relay connection
         indicator (active candidate pair is 'relay'). Do NOT add a forced-relay setting
         (deferred to #93). Update README "Privacy & data protection" + the generated
         privacy.html to disclose STUN/TURN origins and relay routing.` },
      { label: 'analytics-polish', ...SONNET, prompt:
        `Add content-free call events to packages/web-app/src/analytics.ts matching the
         closed EVENTS policy. Add ringtone/vibration, missed/busy/timeout states via
         call_info, and mobile-viewport layout.` },
      { label: 'e2e-test', ...SONNET, prompt:
        `Add a Playwright smoke test (base it on upstream packages/e2e-tests): load the
         app, drive an outgoing call against a local echo/second core, assert an
         RTCPeerConnection reaches 'connected'.` },
    ],
    verify:
      `Full end-to-end: audio+video connect, device switching + rings + screenshare work,
       hangup tears down, popup-block falls back, NO CSP violations, PWA still installable,
       privacy page regenerates. Playwright smoke passes. Final go/no-go.`,
  },
}

// ---- driver -----------------------------------------------------------------

const milestone = (typeof args === 'string' ? args : args && args.milestone) || 'M0'
const m = MILESTONES[milestone]
if (!m) throw new Error(`Unknown milestone "${milestone}". Valid: ${Object.keys(MILESTONES).join(', ')}`)

phase('Plan')
log(`Milestone ${milestone} — ${m.goal}. Read docs/calls.md; ${m.build.length} build task(s).`)

// Build: fan out, each task reads the plan itself and honors the shared constraints.
phase('Build')
const results = await parallel(m.build.map((t) => () =>
  agent(
    `You are implementing part of milestone ${milestone} (${m.goal}) of the calls plan.\n` +
    `First read docs/calls.md in full for context.\n\nTASK: ${t.prompt}\n${CONSTRAINTS}`,
    { label: t.label, phase: 'Build', model: t.model, effort: t.effort, schema: TASK_RESULT }
  ).then((r) => ({ ...t, result: r }))
))

const built = results.filter(Boolean)
const escalations = built.flatMap((b) => (b.result && b.result.escalations) || [])

// Review: adversarial pass on the risky outputs (engine, interop, screenshare, popup IPC).
phase('Review')
const reviewed = await parallel(
  built.filter((b) => b.review).map((b) => () =>
    agent(
      `Adversarially review the "${b.label}" work for milestone ${milestone}. Read the diff and the\n` +
      `relevant files. Your job is to FIND the bug, not bless it — focus on: interop/wire-format\n` +
      `mismatches with calls-webapp, ICE timing/teardown races, engine/ importing React/DOM,\n` +
      `patch bloat, or any hidden core patch. Report concrete issues.\n\nWhat was done:\n` +
      `${b.result && b.result.summary}\n${CONSTRAINTS}`,
      { label: `review:${b.label}`, phase: 'Review', ...OPUS, schema: REVIEW_VERDICT }
    )
  )
).then((v) => v.filter(Boolean))

const blockers = reviewed.filter((r) => r.verdict === 'fail' ||
  (r.issues || []).some((i) => i.severity === 'blocker'))

// Verify: only if review is clean; otherwise report back for fixes before the gate.
phase('Verify')
let verify = null
if (blockers.length === 0) {
  verify = await agent(
    `Verify milestone ${milestone} end-to-end. ${m.verify}\nRead docs/calls.md's verification\n` +
    `section. Actually drive the flow (real client or chatmail/calls-echobot where the plan\n` +
    `says so) — do not settle for typecheck/tests alone. ${CONSTRAINTS}`,
    { label: `verify:${milestone}`, phase: 'Verify', ...OPUS, schema: VERIFY_RESULT }
  )
} else {
  log(`Review found ${blockers.length} blocker(s) — skipping verify; fix before the gate.`)
}

// Structured go/no-go for the human. The workflow stops here by design.
const go = blockers.length === 0 && verify && verify.passed && verify.go_recommendation === 'go'
return {
  milestone,
  goal: m.goal,
  build: built.map((b) => ({ task: b.label, status: b.result && b.result.status, summary: b.result && b.result.summary })),
  review: reviewed,
  blockers,
  verify,
  escalations,
  gate: go ? 'GO' : 'NO-GO',
  next: go ? `Review the diff, commit, then run this workflow with the next milestone.`
           : `Resolve blockers/escalations, re-run this milestone.`,
}
