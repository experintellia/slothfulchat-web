import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getActiveConnectionRoute,
  ConnectionRouteMonitor,
  type ConnectionRoute,
  type RtcStatsEntry,
  type StatsPeerConnectionLike,
} from './connection-route.ts';

// ── getActiveConnectionRoute ──────────────────────────────────────────────────

/** Build a fake `getStats()`-returning pc from a flat entry list — a real
 * `RTCStatsReport` is a `Map<string, RTCStats>`, so a plain `Map` matches its
 * structural shape (`.values()`) exactly. */
function fakePc(entries: RtcStatsEntry[]): StatsPeerConnectionLike {
  const map = new Map(entries.map((e) => [e.id, e] as const));
  return {
    getStats: async () => map,
  };
}

function candidate(id: string, candidateType: string): RtcStatsEntry {
  return { id, type: 'local-candidate', candidateType };
}

function pair(
  id: string,
  opts: {
    state?: string;
    nominated?: boolean;
    localCandidateId?: string;
    remoteCandidateId?: string;
  } = {}
): RtcStatsEntry {
  return {
    id,
    type: 'candidate-pair',
    state: opts.state ?? 'succeeded',
    nominated: opts.nominated ?? true,
    localCandidateId: opts.localCandidateId,
    remoteCandidateId: opts.remoteCandidateId,
  };
}

test('getActiveConnectionRoute: no candidate-pair stats at all -> unknown', async () => {
  const pc = fakePc([{ id: 'x', type: 'transport' }]);
  assert.equal(await getActiveConnectionRoute(pc), 'unknown');
});

test('getActiveConnectionRoute: nominated+succeeded pair with host candidates -> direct', async () => {
  const pc = fakePc([
    candidate('local1', 'host'),
    candidate('remote1', 'host'),
    pair('pair1', { localCandidateId: 'local1', remoteCandidateId: 'remote1' }),
  ]);
  assert.equal(await getActiveConnectionRoute(pc), 'direct');
});

test('getActiveConnectionRoute: local candidate is relay -> relay', async () => {
  const pc = fakePc([
    candidate('local1', 'relay'),
    candidate('remote1', 'srflx'),
    pair('pair1', { localCandidateId: 'local1', remoteCandidateId: 'remote1' }),
  ]);
  assert.equal(await getActiveConnectionRoute(pc), 'relay');
});

test('getActiveConnectionRoute: remote candidate is relay -> relay (either side counts)', async () => {
  const pc = fakePc([
    candidate('local1', 'srflx'),
    candidate('remote1', 'relay'),
    pair('pair1', { localCandidateId: 'local1', remoteCandidateId: 'remote1' }),
  ]);
  assert.equal(await getActiveConnectionRoute(pc), 'relay');
});

test('getActiveConnectionRoute: prefers nominated+succeeded over a merely-succeeded pair', async () => {
  const pc = fakePc([
    candidate('localA', 'relay'),
    candidate('remoteA', 'relay'),
    candidate('localB', 'host'),
    candidate('remoteB', 'host'),
    // Not nominated, but succeeded — must NOT be picked over the nominated one.
    pair('pairB', { nominated: false, localCandidateId: 'localB', remoteCandidateId: 'remoteB' }),
    pair('pairA', { nominated: true, localCandidateId: 'localA', remoteCandidateId: 'remoteA' }),
  ]);
  assert.equal(await getActiveConnectionRoute(pc), 'relay');
});

test('getActiveConnectionRoute: no nominated pair -> falls back to any succeeded pair', async () => {
  const pc = fakePc([
    candidate('local1', 'relay'),
    candidate('remote1', 'relay'),
    pair('pair1', { nominated: false, localCandidateId: 'local1', remoteCandidateId: 'remote1' }),
  ]);
  assert.equal(await getActiveConnectionRoute(pc), 'relay');
});

test('getActiveConnectionRoute: only a failed/in-progress pair (not succeeded) -> unknown', async () => {
  const pc = fakePc([
    candidate('local1', 'host'),
    candidate('remote1', 'host'),
    pair('pair1', { state: 'in-progress', localCandidateId: 'local1', remoteCandidateId: 'remote1' }),
  ]);
  assert.equal(await getActiveConnectionRoute(pc), 'unknown');
});

test('getActiveConnectionRoute: candidate ids missing from the report -> unknown (not a throw)', async () => {
  const pc = fakePc([pair('pair1', { localCandidateId: 'ghost-local', remoteCandidateId: 'ghost-remote' })]);
  assert.equal(await getActiveConnectionRoute(pc), 'unknown');
});

test('getActiveConnectionRoute: getStats() rejection resolves to unknown, does not throw', async () => {
  const pc: StatsPeerConnectionLike = {
    getStats: async () => {
      throw new Error('getStats boom');
    },
  };
  await assert.doesNotReject(async () => {
    assert.equal(await getActiveConnectionRoute(pc), 'unknown');
  });
});

// ── ConnectionRouteMonitor ─────────────────────────────────────────────────────

/** Deterministic fake interval: `tick()` invokes every scheduled callback once,
 * mirroring `level-meter.test.ts`'s harness. */
function fakeIntervalHarness() {
  const callbacks = new Set<() => void>();
  return {
    setIntervalFn: (cb: () => void) => {
      callbacks.add(cb);
      return cb;
    },
    clearIntervalFn: (handle: unknown) => {
      callbacks.delete(handle as () => void);
    },
    tick(times = 1): void {
      for (let i = 0; i < times; i++) {
        for (const cb of [...callbacks]) cb();
      }
    },
    activeCount(): number {
      return callbacks.size;
    },
  };
}

/** A controllable poll function: resolves with whatever `next` was last set
 * to, and lets a test hold a poll pending (to simulate a slow getStats()). */
function fakePoller() {
  let next: ConnectionRoute = 'unknown';
  let pendingResolvers: Array<(route: ConnectionRoute) => void> = [];
  let holdNext = false;
  let calls = 0;
  return {
    poll: async (): Promise<ConnectionRoute> => {
      calls++;
      if (holdNext) {
        return new Promise<ConnectionRoute>((resolve) => {
          pendingResolvers.push(resolve);
        });
      }
      return next;
    },
    set(route: ConnectionRoute): void {
      next = route;
    },
    hold(): void {
      holdNext = true;
    },
    release(route: ConnectionRoute): void {
      holdNext = false;
      const resolvers = pendingResolvers;
      pendingResolvers = [];
      for (const resolve of resolvers) resolve(route);
    },
    callCount(): number {
      return calls;
    },
  };
}

test('ConnectionRouteMonitor.start takes an immediate sample and reports the first route', async () => {
  const harness = fakeIntervalHarness();
  const poller = fakePoller();
  poller.set('direct');
  const routes: ConnectionRoute[] = [];
  const monitor = new ConnectionRouteMonitor({
    poll: poller.poll,
    onRoute: (r) => routes.push(r),
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  assert.equal(monitor.route, 'unknown');
  monitor.start();
  // start()'s sample is async (poll() returns a Promise); flush microtasks.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(monitor.route, 'direct');
  assert.deepEqual(routes, ['direct']);
});

test('ConnectionRouteMonitor: only calls onRoute when the route actually changes', async () => {
  const harness = fakeIntervalHarness();
  const poller = fakePoller();
  poller.set('direct');
  const routes: ConnectionRoute[] = [];
  const monitor = new ConnectionRouteMonitor({
    poll: poller.poll,
    onRoute: (r) => routes.push(r),
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  monitor.start();
  await Promise.resolve();
  await Promise.resolve();

  // Same route again on the next tick: no additional callback.
  harness.tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(routes, ['direct']);

  // Route flips to relay: exactly one more callback.
  poller.set('relay');
  harness.tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(routes, ['direct', 'relay']);
});

test('ConnectionRouteMonitor.start is idempotent (a second start does not double-schedule)', () => {
  const harness = fakeIntervalHarness();
  const poller = fakePoller();
  const monitor = new ConnectionRouteMonitor({
    poll: poller.poll,
    onRoute: () => {},
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  monitor.start();
  monitor.start();
  assert.equal(harness.activeCount(), 1);
  assert.equal(monitor.isRunning, true);
});

test('ConnectionRouteMonitor.stop clears the interval and is idempotent', () => {
  const harness = fakeIntervalHarness();
  const poller = fakePoller();
  const monitor = new ConnectionRouteMonitor({
    poll: poller.poll,
    onRoute: () => {},
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  monitor.start();
  monitor.stop();
  assert.equal(harness.activeCount(), 0);
  assert.equal(monitor.isRunning, false);
  monitor.stop(); // no-op, must not throw
  assert.equal(harness.activeCount(), 0);
});

test('ConnectionRouteMonitor: stop() without start() is a harmless no-op', () => {
  const poller = fakePoller();
  const monitor = new ConnectionRouteMonitor({ poll: poller.poll, onRoute: () => {} });
  assert.doesNotThrow(() => monitor.stop());
  assert.equal(monitor.isRunning, false);
});

test('ConnectionRouteMonitor: a poll() resolving after stop() does not report or resurrect the route', async () => {
  const harness = fakeIntervalHarness();
  const poller = fakePoller();
  const routes: ConnectionRoute[] = [];
  const monitor = new ConnectionRouteMonitor({
    poll: poller.poll,
    onRoute: (r) => routes.push(r),
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  poller.hold(); // the very first (start()) sample now hangs
  monitor.start();
  await Promise.resolve();
  monitor.stop();
  poller.release('relay'); // resolves AFTER stop()
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(routes, [], 'a late resolution after stop() must not fire onRoute');
  assert.equal(monitor.route, 'unknown', 'and must not update the readable route either');
});

test('ConnectionRouteMonitor: overlap guard skips a tick while a previous poll is still in flight', async () => {
  const harness = fakeIntervalHarness();
  const poller = fakePoller();
  const monitor = new ConnectionRouteMonitor({
    poll: poller.poll,
    onRoute: () => {},
    setIntervalFn: harness.setIntervalFn,
    clearIntervalFn: harness.clearIntervalFn,
  });
  poller.hold();
  monitor.start(); // in-flight call #1
  await Promise.resolve();
  harness.tick(); // would be call #2, but must be skipped (still in flight)
  harness.tick();
  await Promise.resolve();
  assert.equal(poller.callCount(), 1, 'overlapping ticks must not launch concurrent polls');
  poller.release('direct');
  await Promise.resolve();
  await Promise.resolve();
  // Now that the in-flight call resolved, a fresh tick should poll again.
  harness.tick();
  await Promise.resolve();
  assert.equal(poller.callCount(), 2);
});
