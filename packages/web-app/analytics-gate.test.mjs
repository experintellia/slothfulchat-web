// Self-check for the delayed-opt-out gate in src/analytics.ts. Run:
//   node packages/web-app/analytics-gate.test.mjs
// Drives the REAL module (imported through Node's type-stripping loader, like
// the packages/calls suites) — an earlier version of this file re-implemented
// the gate by hand, which passed happily while analytics.ts drifted. Proves:
//   - a first visit holds EVERY event until the notice is shown, not just the
//     first-visit burst (bridge/boot_error fire before the welcome screen)
//   - the 'onboarding'/'welcome' event releases without holding itself
//   - the release persists a flag, so later visits send immediately — including
//     a visit whose core never starts, where startupMode() would be stuck at
//     'unknown' and would have held boot_error for returning users too
//   - release is idempotent and preserves order
//   - opting out before release drops the held events (isEnabled re-check)
//   - the closed event catalogue is enforced on the way out
import assert from 'node:assert/strict';

const analyticsUrl = new URL('./src/analytics.ts', import.meta.url).href;
const session = await import(new URL('./src/session.ts', import.meta.url).href);
session.setHadAccount(true); // so trackStartup()'s mode is known ('warm')

const NOTICE_KEY = 'slothfulchat.analyticsNoticeShown';

// --- harness: one fresh module instance per *visit* ---
// analytics.ts keeps the gate in module state, so a re-import with a fresh
// query string is a new page load. `store` stands in for localStorage and is
// shared across visits to model the same browser coming back.
let visits = 0;
async function newVisit({ store = new Map(), configured = true } = {}) {
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  globalThis.window = {
    __slothfulConfig: configured
      ? {
          analytics: true,
          plausibleDomain: 'demo.test',
          plausibleApi: 'https://plausible.test/api/event',
        }
      : {}, // a self-hosted build: no analytics config, no consent UI
  };
  globalThis.location = {
    origin: 'https://demo.test',
    pathname: '/main.html',
    href: 'https://demo.test/main.html',
  };
  const sent = [];
  globalThis.fetch = (_url, init) => {
    sent.push(JSON.parse(init.body).name);
    return Promise.resolve();
  };
  const a = await import(`${analyticsUrl}?visit=${++visits}`);
  return { ...a, sent, store };
}

// 1) FIRST VISIT + opted-in: held until notice, then sent in order.
{
  const g = await newVisit();
  g.pageview();
  g.trackStartup(1200);
  assert.deepEqual(g.sent, [], 'first visit must not send before the notice');
  g.releaseHeldEvents(); // WelcomeScreen mounted
  assert.deepEqual(g.sent, ['pageview', 'startup'], 'released in order after notice');
}

// 2) A LATER VISIT by the same browser sends immediately — the flag persisted.
{
  const store = new Map();
  (await newVisit({ store })).releaseHeldEvents(); // visit 1
  const g = await newVisit({ store }); // visit 2
  g.pageview();
  g.trackStartup(1200);
  assert.deepEqual(g.sent, ['pageview', 'startup'], 'returning visit sends immediately');
}

// 3) FIRST VISIT + opted-out: held, and release drops them (send guard).
{
  const g = await newVisit();
  g.setConsent('denied');
  g.pageview();
  g.trackStartup(1200);
  g.releaseHeldEvents();
  assert.deepEqual(g.sent, [], 'opted-out: nothing sent even after release');
}

// 4) release is idempotent and each event fires at most once.
{
  const g = await newVisit();
  g.pageview();
  g.pageview(); // duplicate call
  g.releaseHeldEvents();
  g.releaseHeldEvents(); // duplicate release
  assert.deepEqual(g.sent, ['pageview'], 'no duplicate sends');
}

// 5) events queued AFTER release still send.
{
  const g = await newVisit();
  g.releaseHeldEvents();
  g.pageview();
  assert.deepEqual(g.sent, ['pageview'], 'post-release events send immediately');
}

// 6) boot events fire before anything about the session is known — they must be
// held on a first visit too, not just the first-visit burst.
{
  const g = await newVisit();
  g.event('bridge', { kind: 'local' }); // from getCore()
  g.event('boot_error', { kind: 'opfs-locked' });
  assert.deepEqual(g.sent, [], 'pre-notice boot events must not leave');
  g.releaseHeldEvents();
  assert.deepEqual(g.sent, ['bridge', 'boot_error'], 'released once the notice is up');
}

// 7) the welcome event releases the queue without holding itself, and the held
// events go out ahead of it.
{
  const g = await newVisit();
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
  (await newVisit({ store })).releaseHeldEvents(); // an earlier, working visit
  const g = await newVisit({ store });
  g.event('boot_error', { kind: 'init-error' });
  assert.deepEqual(g.sent, ['boot_error'], 'returning user: boot failure still reported');
}

// 9) …but a first-ever visit that dies at boot still sends nothing. Known hole,
// deliberate: not transmitting pre-notice wins. The crash dialog has to ask.
{
  const g = await newVisit();
  g.event('boot_error', { kind: 'init-error' });
  assert.deepEqual(g.sent, [], 'first visit, no notice yet, no send');
}

// 10) an UNCONFIGURED build shows no consent UI, but still reaches the release
// via the 'welcome' hook and the emitUIFullyReady fallback. It must not record
// "notice shown", or enabling analytics later on the same origin would send to
// a user who never saw one.
{
  const store = new Map();
  const off = await newVisit({ store, configured: false });
  off.event('bridge', { kind: 'local' });
  off.releaseHeldEvents();
  assert.equal(store.get(NOTICE_KEY), undefined, 'no notice shown, nothing recorded');

  // operator flips analytics on for the same origin
  const on = await newVisit({ store });
  on.event('bridge', { kind: 'local' });
  assert.deepEqual(on.sent, [], 'still held: this browser has never seen a notice');
}

// 11) the closed catalogue (src/events.mjs) is enforced on the way out, so a
// released queue still cannot carry an unlisted event or an unlisted prop value.
{
  const g = await newVisit();
  g.releaseHeldEvents();
  g.event('bridge', { kind: 'not-in-the-catalogue' });
  g.event('definitely-not-an-event');
  g.event('bridge', { kind: 'custom' });
  assert.deepEqual(g.sent, ['bridge'], 'only catalogue-conforming events are sent');
}

console.log('analytics delayed-opt-out gate: all assertions passed');
