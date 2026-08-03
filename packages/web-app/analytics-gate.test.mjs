// Self-check for the delayed-opt-out gate in src/analytics.ts. Run:
//   node packages/web-app/analytics-gate.test.mjs
// Mirrors the gate that now lives inside event() itself — kept in sync by hand —
// and its interaction with the isEnabled() send guard, proving:
//   - cold start holds EVERY event until the notice is shown, not just the
//     first-visit burst (bridge/boot_error fire before the welcome screen)
//   - the 'onboarding'/'welcome' event releases without holding itself
//   - warm start sends immediately
//   - release is idempotent and preserves order
//   - opting out before release drops the held events (isEnabled re-check)
import assert from 'node:assert/strict';

// --- harness: a fresh gate + fake sender per scenario ---
function makeGate({ startupMode, enabled }) {
  const sent = [];

  let noticeReleased = false;
  const heldForNotice = [];
  const releaseHeldForNotice = () => {
    if (noticeReleased) return;
    noticeReleased = true;
    for (const run of heldForNotice.splice(0)) run();
  };

  // mirror of analytics.event(): release hook, then the hold, then the
  // isEnabled() guard (re-checked when a queued call re-enters).
  const event = (name, props) => {
    if (name === 'onboarding' && props?.step === 'welcome') releaseHeldForNotice();
    if (!noticeReleased && startupMode() !== 'warm') {
      heldForNotice.push(() => event(name, props));
      return;
    }
    if (!enabled()) return;
    sent.push(name);
  };

  // the once-per-visit callers, which no longer gate themselves
  let pageviewQueued = false;
  const pageview = () => {
    if (pageviewQueued) return;
    pageviewQueued = true;
    event('pageview');
  };
  let startupQueued = false;
  const trackStartup = () => {
    if (startupQueued) return;
    startupQueued = true;
    event('startup');
  };
  return { sent, event, pageview, trackStartup, releaseHeldForNotice };
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

// 6) L-02: boot events fire before the mode is even known ('unknown', not
// 'cold') — they must be held too, not just the first-visit burst.
{
  const g = makeGate({ startupMode: () => 'unknown', enabled: () => true });
  g.event('bridge', { kind: 'local' }); // from getCore()
  g.event('boot_error', { kind: 'opfs-locked' });
  assert.deepEqual(g.sent, [], 'pre-notice boot events must not leave');
  g.releaseHeldForNotice();
  assert.deepEqual(g.sent, ['bridge', 'boot_error'], 'released once the notice is up');
}

// 7) the welcome event releases the queue without holding itself, and the held
// events go out ahead of it.
{
  const g = makeGate({ startupMode: () => 'cold', enabled: () => true });
  g.event('bridge', { kind: 'local' });
  g.event('onboarding', { step: 'welcome' }); // WelcomeScreen mounted
  assert.deepEqual(g.sent, ['bridge', 'onboarding'], 'welcome releases, then sends');
}

// 8) a cold start that never reaches the welcome screen sends nothing — the
// deliberate trade-off: no boot_error sample rather than a pre-consent send.
{
  const g = makeGate({ startupMode: () => 'unknown', enabled: () => true });
  g.event('boot_error', { kind: 'init-error' });
  assert.deepEqual(g.sent, [], 'no release, no send');
}

console.log('analytics delayed-opt-out gate: all assertions passed');
