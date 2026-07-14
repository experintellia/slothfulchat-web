/**
 * Direct-vs-relay connection route detection (M5, docs/calls.md: "a
 * non-blocking direct-vs-relay connection indicator (active candidate pair is
 * 'relay')"). Purely a troubleshooting/transparency aid — it never blocks or
 * changes call behavior, and it is NOT a forced-relay setting (that toggle is
 * explicitly deferred to issue #93; see docs/calls.md "Relay UX").
 *
 * Pure TS, no DOM/React imports: `RTCStatsReport`/`RTCIceCandidatePairStats`
 * are ambient WebRTC lib *types* only (same discipline as the rest of
 * engine/, e.g. `ice-gathering.ts`) — {@link getActiveConnectionRoute} takes
 * anything structurally shaped like a `getStats()`-returning peer connection,
 * so it is unit-testable against a hand-built fake stats report with no real
 * `RTCPeerConnection` involved. {@link ConnectionRouteMonitor} mirrors
 * `level-meter.ts`'s `TrackLevelMeter`: an injectable-timer poller that calls
 * back only when the route actually changes.
 */

export type ConnectionRoute = 'direct' | 'relay' | 'unknown';

/**
 * One entry of an `RTCStatsReport` this module cares about — a structural
 * subset of `RTCIceCandidatePairStats`/`RTCIceCandidateStats` (real stats
 * objects carry many more fields than these; only the ones read below are
 * declared).
 */
export interface RtcStatsEntry {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A real `RTCStatsReport` is (structurally) a `Map<string, RTCStats>` — it
 * has `.values()`. A hand-built `Map` in tests satisfies this exactly. */
export interface StatsReportLike {
  values(): IterableIterator<RtcStatsEntry>;
}

/** The subset of `RTCPeerConnection` {@link getActiveConnectionRoute} needs. */
export interface StatsPeerConnectionLike {
  getStats(): Promise<StatsReportLike>;
}

/**
 * Inspect the CURRENTLY ACTIVE candidate pair — the one WebRTC's own stats
 * mark as in use — and report whether either side of it is a `relay` (TURN)
 * candidate.
 *
 * Resolution order for "the active pair", most to least specific:
 *   1. `nominated === true && state === 'succeeded'` — the ICE-spec-correct
 *      definition of "this is the pair actually carrying media".
 *   2. Any `state === 'succeeded'` pair, if none is marked `nominated` (some
 *      browsers omit `nominated` on the stats object even though only one
 *      pair is realistically in use for a 1:1 call).
 *   3. None found (still connecting/gathering, or a browser that doesn't
 *      populate candidate-pair stats the way we expect) → `'unknown'`.
 *
 * A pair is reported as `'relay'` if EITHER its local or its remote candidate
 * has `candidateType === 'relay'` — either side routing through a TURN relay
 * means the media path is relayed, not a direct peer-to-peer route.
 *
 * Never throws: a `getStats()` rejection (or a malformed report) resolves to
 * `'unknown'` rather than propagating, since this is a best-effort UI hint,
 * never on the call-setup critical path.
 */
export async function getActiveConnectionRoute(
  pc: StatsPeerConnectionLike
): Promise<ConnectionRoute> {
  let report: StatsReportLike;
  try {
    report = await pc.getStats();
  } catch {
    return 'unknown';
  }

  let entries: RtcStatsEntry[];
  try {
    entries = [...report.values()];
  } catch {
    return 'unknown';
  }

  const pairs = entries.filter((e) => e.type === 'candidate-pair');
  const activePair =
    pairs.find((p) => p.nominated === true && p.state === 'succeeded') ??
    pairs.find((p) => p.state === 'succeeded');
  if (activePair == null) return 'unknown';

  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const localId = activePair.localCandidateId;
  const remoteId = activePair.remoteCandidateId;
  const local = typeof localId === 'string' ? byId.get(localId) : undefined;
  const remote = typeof remoteId === 'string' ? byId.get(remoteId) : undefined;

  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') {
    return 'relay';
  }
  if (local != null || remote != null) return 'direct';
  return 'unknown';
}

/** Default poll interval (docs/calls.md: "non-blocking" — slow enough that
 * polling `getStats()` is cheap for the whole call, fast enough to notice a
 * route change without perceptible lag on the indicator). */
export const DEFAULT_CONNECTION_ROUTE_INTERVAL_MS = 3000;

export interface ConnectionRouteMonitorOptions {
  /** Take one reading. Typically `() => engine.getConnectionRoute()` (bridge
   * layer) or `() => getActiveConnectionRoute(pc)` (direct engine use) — kept
   * as an injected function rather than a `pc` reference so this class stays
   * decoupled from *how* a route is computed, mirroring how `TrackLevelMeter`
   * takes an already-wired `AnalyserLike` rather than constructing one. */
  poll(): Promise<ConnectionRoute>;
  /** Called only when the route actually changes (no redundant UI churn
   * every tick) — including the very first successful poll, which always
   * "changes" from the implicit initial `'unknown'`. */
  onRoute(route: ConnectionRoute): void;
  /** Poll interval in ms. Default {@link DEFAULT_CONNECTION_ROUTE_INTERVAL_MS}. */
  intervalMs?: number;
  /** Injectable timer, default global `setInterval`. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  /** Injectable timer, default global `clearInterval`. */
  clearIntervalFn?: (handle: unknown) => void;
}

/**
 * Polls {@link ConnectionRouteMonitorOptions.poll} on an interval and calls
 * `onRoute` only on an actual change. Not started automatically: call
 * {@link start} once the call is `connected` (there is nothing to poll
 * before then) and {@link stop} on teardown — mirrors `TrackLevelMeter`'s
 * start/stop discipline so a torn-down call can't leave a poll loop running.
 */
export class ConnectionRouteMonitor {
  private readonly pollFn: () => Promise<ConnectionRoute>;
  private readonly onRouteCb: (route: ConnectionRoute) => void;
  private readonly intervalMs: number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private handle: unknown = null;
  /** True whenever `stop()` has run since the last `start()` — guards a
   * `poll()` that resolves AFTER `stop()` from still reporting a route into
   * a torn-down call (same race the rest of engine/ guards against via the
   * epoch pattern; this is the analogous guard for this standalone poller). */
  private stopped = true;
  private polling = false;
  private lastRoute: ConnectionRoute = 'unknown';

  constructor(options: ConnectionRouteMonitorOptions) {
    this.pollFn = options.poll;
    this.onRouteCb = options.onRoute;
    this.intervalMs = options.intervalMs ?? DEFAULT_CONNECTION_ROUTE_INTERVAL_MS;
    this.setIntervalFn = options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h as never));
  }

  /** The most recently reported route. `'unknown'` before the first poll
   * resolves. */
  get route(): ConnectionRoute {
    return this.lastRoute;
  }

  /** Whether {@link start} has been called without a matching {@link stop}. */
  get isRunning(): boolean {
    return this.handle != null;
  }

  /** Begin polling. Idempotent (a second call while already running is a
   * no-op). Takes one sample immediately (async — `poll()` returns a
   * Promise) rather than waiting for the first interval tick. */
  start(): void {
    if (this.handle != null) return;
    this.stopped = false;
    void this.tick();
    this.handle = this.setIntervalFn(() => void this.tick(), this.intervalMs);
  }

  /** Stop polling. Idempotent; safe to call even if never started. A `poll()`
   * already in flight is left to resolve but its result is discarded (see
   * `stopped` guard in {@link tick}). */
  stop(): void {
    this.stopped = true;
    if (this.handle != null) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }

  private async tick(): Promise<void> {
    // Overlap guard: poll() is async (a real getStats() round-trip) and the
    // interval may fire again before a slow call resolves — never run two
    // concurrent samples.
    if (this.polling) return;
    this.polling = true;
    try {
      const route = await this.pollFn();
      if (this.stopped) return; // late resolution after stop(); drop it
      if (route !== this.lastRoute) {
        this.lastRoute = route;
        this.onRouteCb(route);
      }
    } finally {
      this.polling = false;
    }
  }
}
