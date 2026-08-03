// Self-check for the delayed-opt-out gate in src/analytics.ts. Run:
//   node packages/web-app/analytics-gate.test.mjs
// Mirrors the gate that lives inside event() itself — kept in sync by hand —
// and its interaction with the isEnabled() send guard, proving:
//   - a first visit holds EVERY event until the notice is shown, not just the
//     first-visit burst (bridge/boot_error fire before the welcome screen)
//   - the 'onboarding'/'welcome' event releases without holding itself
//   - the release persists a flag, so later visits send immediately — including
//     a visit whose core never starts, where startupMode() would be stuck at
//     'unknown' and would have held boot_error for returning users too
//   - release is idempotent and preserves order
//   - opting out before release drops the held events (isEnabled re-check)
import assert from 'node:assert/strict';

// --- harness: a fresh gate + fake sender per scenario ---
// `store` stands in for localStorage and is shared across gates in a scenario
// to model separate visits by the same browser.
function makeGate({ enabled, store = new Map() }) {
  const sent = [];

  let noticeReleased = false;
  const heldForNotice = [];
  const noticeShownBefore = () => store.get('noticeShown') === '1';
  const releaseHeldForNotice = () => {
    if (noticeReleased) return;
    noticeReleased = true;
    store.set('noticeShown', '1');
    for (const run of heldForNotice.splice(0)) run();
  };

  // mirror of analytics.event(): release hook, then the hold, then the
  // isEnabled() guard (re-checked when a queued call re-enters).
  const event = (name, props) => {
    if (name === 'onboarding' && props?.step === 'welcome') releaseHeldForNotice();
    if (!noticeReleased && !noticeShownBefore()) {
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
  return { sent, store, event, pageview, trackStartup, releaseHeldForNotice };
}

// 1) FIRST VISIT + opted-in: held until notice, then sent in order.
{
  const g = makeGate({ enabled: () => true });
  g.pageview();
  g.trackStartup();
  assert.deepEqual(g.sent, [], 'first visit must not send before the notice');
  g.releaseHeldForNotice(); // WelcomeScreen mounted
  assert.deepEqual(g.sent, ['pageview', 'startup'], 'released in order after notice');
}

// 2) A LATER VISIT by the same browser sends immediately — the flag persisted.
{
  const store = new Map();
  makeGate({ enabled: () => true, store }).releaseHeldForNotice(); // visit 1
  const g = makeGate({ enabled: () => true, store }); // visit 2
  g.pageview();
  g.trackStartup();
  assert.deepEqual(g.sent, ['pageview', 'startup'], 'returning visit sends immediately');
}

// 3) FIRST VISIT + opted-out: held, and release drops them (send guard).
{
  const g = makeGate({ enabled: () => false });
  g.pageview();
  g.trackStartup();
  g.releaseHeldForNotice();
  assert.deepEqual(g.sent, [], 'opted-out: nothing sent even after release');
}

// 4) release is idempotent and each event fires at most once.
{
  const g = makeGate({ enabled: () => true });
  g.pageview();
  g.pageview(); // duplicate call
  g.releaseHeldForNotice();
  g.releaseHeldForNotice(); // duplicate release
  assert.deepEqual(g.sent, ['pageview'], 'no duplicate sends');
}

// 5) events queued AFTER release still send.
{
  const g = makeGate({ enabled: () => true });
  g.releaseHeldForNotice();
  g.pageview();
  assert.deepEqual(g.sent, ['pageview'], 'post-release events send immediately');
}

// 6) L-02: boot events fire before anything about the session is known — they
// must be held on a first visit too, not just the first-visit burst.
{
  const g = makeGate({ enabled: () => true });
  g.event('bridge', { kind: 'local' }); // from getCore()
  g.event('boot_error', { kind: 'opfs-locked' });
  assert.deepEqual(g.sent, [], 'pre-notice boot events must not leave');
  g.releaseHeldForNotice();
  assert.deepEqual(g.sent, ['bridge', 'boot_error'], 'released once the notice is up');
}

// 7) the welcome event releases the queue without holding itself, and the held
// events go out ahead of it.
{
  const g = makeGate({ enabled: () => true });
  g.event('bridge', { kind: 'local' });
  g.event('onboarding', { step: 'welcome' }); // WelcomeScreen mounted
  assert.deepEqual(g.sent, ['bridge', 'onboarding'], 'welcome releases, then sends');
}

// 8) THE REGRESSION THIS FLAG EXISTS FOR: a returning user whose core dies at
// boot. No welcome screen ever mounts, so nothing releases this session — and
// session.startupMode() is stuck at 'unknown' because it is only known once the
// core answers. Gating on the persisted flag instead sends the boot_error.
{
  const store = new Map();
  makeGate({ enabled: () => true, store }).releaseHeldForNotice(); // an earlier, working visit
  const g = makeGate({ enabled: () => true, store });
  g.event('boot_error', { kind: 'init-error' });
  assert.deepEqual(g.sent, ['boot_error'], 'returning user: boot failure still reported');
}

// 9) …but a first-ever visit that dies at boot still sends nothing. Known hole,
// deliberate: not transmitting pre-notice wins. The crash dialog has to ask.
{
  const g = makeGate({ enabled: () => true });
  g.event('boot_error', { kind: 'init-error' });
  assert.deepEqual(g.sent, [], 'first visit, no notice yet, no send');
}

console.log('analytics delayed-opt-out gate: all assertions passed');
