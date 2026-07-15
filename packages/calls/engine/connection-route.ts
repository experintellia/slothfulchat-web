/**
 * Direct-vs-relay connection route detection (is the active candidate pair
 * going through TURN?). Purely informational — never blocks or changes call
 * behavior, and NOT a forced-relay setting (deferred to issue #93; see
 * docs/calls.md "Relay UX").
 *
 * Pure TS, no DOM imports: operates on anything structurally shaped like a
 * `getStats()`-returning peer connection, so it's testable with a fake report.
 */

export type ConnectionRoute = 'direct' | 'relay' | 'unknown';

/** One `RTCStatsReport` entry — structural subset of the candidate-pair/
 * candidate stats; only the fields read below are declared. */
export interface RtcStatsEntry {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Structural `RTCStatsReport`; a plain `Map` in tests satisfies it. */
export interface StatsReportLike {
  values(): IterableIterator<RtcStatsEntry>;
}

/** The subset of `RTCPeerConnection` {@link getActiveConnectionRoute} needs. */
export interface StatsPeerConnectionLike {
  getStats(): Promise<StatsReportLike>;
}

/**
 * Report whether the currently active candidate pair is relayed (TURN).
 * Active pair = `nominated && state === 'succeeded'`, falling back to any
 * `succeeded` pair (some browsers omit `nominated` in stats), else
 * `'unknown'`. Either side being a `relay` candidate means the path is
 * relayed. Never throws: a `getStats()` failure or malformed report resolves
 * to `'unknown'` — this is a best-effort UI hint, not on the call-setup path.
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

/** Default poll interval — slow enough that polling `getStats()` is cheap,
 * fast enough to notice a route change without perceptible lag. */
export const DEFAULT_CONNECTION_ROUTE_INTERVAL_MS = 3000;

export interface ConnectionRouteMonitorOptions {
  /** Take one reading, e.g. `() => getActiveConnectionRoute(pc)`. Injected
   * function (not a `pc`) so the monitor stays decoupled from how a route is
   * computed. */
  poll(): Promise<ConnectionRoute>;
  /** Called only on an actual route change — including the first successful
   * poll, which "changes" from the implicit initial `'unknown'`. */
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
 * {@link start} once the call is `connected` and {@link stop} on teardown.
 */
export class ConnectionRouteMonitor {
  private readonly pollFn: () => Promise<ConnectionRoute>;
  private readonly onRouteCb: (route: ConnectionRoute) => void;
  private readonly intervalMs: number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private handle: unknown = null;
  /** True since the last `stop()` — guards a `poll()` that resolves AFTER
   * `stop()` from reporting a route into a torn-down call (analogous to the
   * engine's epoch pattern). */
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

  /** Begin polling. Idempotent. Takes one sample immediately rather than
   * waiting for the first interval tick. */
  start(): void {
    if (this.handle != null) return;
    this.stopped = false;
    void this.tick();
    this.handle = this.setIntervalFn(() => void this.tick(), this.intervalMs);
  }

  /** Stop polling. Idempotent. An in-flight `poll()` result is discarded
   * (see `stopped` guard in {@link tick}). */
  stop(): void {
    this.stopped = true;
    if (this.handle != null) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }

  private async tick(): Promise<void> {
    // Overlap guard: the interval can fire again before a slow poll() resolves.
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
