// Self-check for the delayed-opt-out gate in src/analytics.ts. Run:
//   node packages/web-app/analytics-gate.test.mjs
// Mirrors the ~15-line gate (afterNoticeShown / releaseHeldForNotice) — kept in
// sync by hand — and the interaction with the isEnabled() send guard, proving:
//   - cold start holds the first-visit events until the notice is shown
//   - warm start sends immediately
//   - release is idempotent and preserves order
//   - opting out before release drops the held events (isEnabled re-check)
import assert from 'node:assert/strict';

// --- harness: a fresh gate + fake sender per scenario ---
function makeGate({ startupMode, enabled }) {
  const sent = [];
  // mirror of analytics.event()'s send guard: isEnabled() re-checked at flush
  const send = name => { if (enabled()) sent.push(name); };

  let noticeReleased = false;
  const heldForNotice = [];
  const afterNoticeShown = run => {
    if (noticeReleased || startupMode() === 'warm') return run();
    heldForNotice.push(run);
  };
  const releaseHeldForNotice = () => {
    if (noticeReleased) return;
    noticeReleased = true;
    for (const run of heldForNotice.splice(0)) run();
  };
  // the two gated first-visit events
  let pageviewQueued = false;
  const pageview = () => {
    if (pageviewQueued) return;
    pageviewQueued = true;
    afterNoticeShown(() => send('pageview'));
  };
  let startupQueued = false;
  const trackStartup = () => {
    if (startupQueued) return;
    startupQueued = true;
    afterNoticeShown(() => send('startup'));
  };
  return { sent, pageview, trackStartup, releaseHeldForNotice };
}

// 1) COLD + opted-in: held until notice, then sent in order.
{
  const g = makeGate({ startupMode: () => 'cold', enabled: () => true });
  g.pageview();
  g.trackStartup();
  assert.deepEqual(g.sent, [], 'cold start must not send before the notice');
  g.releaseHeldForNotice(); // WelcomeScreen mounted
  assert.deepEqual(g.sent, ['pageview', 'startup'], 'released in order after notice');
}

// 2) WARM: sends immediately, no notice needed.
{
  const g = makeGate({ startupMode: () => 'warm', enabled: () => true });
  g.pageview();
  g.trackStartup();
  assert.deepEqual(g.sent, ['pageview', 'startup'], 'warm start sends immediately');
}

// 3) COLD + opted-out: held, and release drops them (send guard).
{
  const g = makeGate({ startupMode: () => 'cold', enabled: () => false });
  g.pageview();
  g.trackStartup();
  g.releaseHeldForNotice();
  assert.deepEqual(g.sent, [], 'opted-out: nothing sent even after release');
}

// 4) release is idempotent and each event fires at most once.
{
  const g = makeGate({ startupMode: () => 'cold', enabled: () => true });
  g.pageview();
  g.pageview(); // duplicate call
  g.releaseHeldForNotice();
  g.releaseHeldForNotice(); // duplicate release
  assert.deepEqual(g.sent, ['pageview'], 'no duplicate sends');
}

// 5) events queued AFTER release (late trackStartup) still send.
{
  const g = makeGate({ startupMode: () => 'cold', enabled: () => true });
  g.releaseHeldForNotice();
  g.pageview();
  assert.deepEqual(g.sent, ['pageview'], 'post-release events send immediately');
}

console.log('analytics delayed-opt-out gate: all assertions passed');
