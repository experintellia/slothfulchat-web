/**
 * SlothfulChat local profiling — purely client-side, never leaves the device.
 *
 * Wraps the browser User Timing API (performance.mark / performance.measure)
 * so we can see how long the expensive parts of a cold start take (worker
 * spawn, wasm instantiation, first RPC answer, UI ready) and how long common
 * runtime actions take afterwards (RPC round-trips like sending a message or
 * switching accounts).
 *
 * Nothing here talks to the network. The optional analytics module may read a
 * *bucketed* startup number from getStartup() and send that, but that is its
 * decision — this file has no dependency on it and works with analytics fully
 * disabled (the self-host default). The diagnostics panel reads snapshot().
 */

import * as session from './session'

// performance.now() is milliseconds since navigation start (timeOrigin), so a
// bare now() already is "time since the page began loading" — no subtraction
// needed for cold-start numbers.
const now = () => (typeof performance !== 'undefined' ? performance.now() : 0)

/** Boot milestones we time, in the order they happen during a cold start. */
export type BootMark =
  | 'runtime-eval' // our runtime.js finished evaluating (earliest we control)
  | 'worker-spawn' // Web Worker + wasm module fetch kicked off
  | 'core-ready' // wasm core answered its first RPC (get_system_info)
  | 'ui-ready' // frontend called emitUIReady()
  | 'ui-fully-ready' // frontend called emitUIFullyReady()
  | 'first-account' // first account finished configuring (onboarding timing)

// absolute timestamps (ms since navigation) for each milestone we've seen
const bootMarks: Partial<Record<BootMark, number>> = {}

const LOG_PREFIX = 'sc:' // namespaces our entries in the devtools Performance tab

/** Record a boot milestone once. Repeated calls for the same mark are ignored
 * (a reload-in-place could otherwise clobber the first, truer number). */
export function boot(mark: BootMark): void {
  if (bootMarks[mark] !== undefined) return
  const t = now()
  bootMarks[mark] = t
  try {
    performance.mark(LOG_PREFIX + mark)
  } catch {
    // performance.mark can throw in exotic environments; timing is best-effort
  }
}

/** A finished cold-start summary, all values ms since navigation start. */
export type StartupRecord = {
  at: number // wall-clock ms (Date-based) of when this start completed
  mode: string // 'cold' (onboarding) | 'warm' (had an account) | 'unknown'
  workerSpawn?: number
  coreReady?: number
  uiReady?: number
  uiFullyReady?: number
}

const STARTUP_KEY = 'slothfulchat.perf.startups'
const STARTUP_KEEP = 20 // rolling window; enough to eyeball variance, tiny in storage

let startupRecorded = false

/** Persist a startup summary into a small rolling buffer in localStorage, so
 * "was startup slow the last few launches?" survives reloads. Called once by
 * runtime.ts after the core has answered get_all_account_ids — recording any
 * earlier (e.g. at ui-ready) races the core-ready mark and the cold/warm mode,
 * leaving every record mode:'unknown' with no coreReady. */
export function recordStartup(): void {
  if (startupRecorded) return
  startupRecorded = true
  const rec: StartupRecord = {
    // Date.now() is fine at runtime in the browser; only the workflow *scripts*
    // forbid it. This is a timestamp for display, not correctness-critical.
    at: Date.now(),
    mode: session.startupMode(),
    workerSpawn: bootMarks['worker-spawn'],
    coreReady: bootMarks['core-ready'],
    uiReady: bootMarks['ui-ready'],
    uiFullyReady: bootMarks['ui-fully-ready'],
  }
  try {
    const prev = readStartups()
    prev.push(rec)
    while (prev.length > STARTUP_KEEP) prev.shift()
    localStorage.setItem(STARTUP_KEY, JSON.stringify(prev))
  } catch {
    // storage may be blocked (private mode / iOS cookie block); ignore
  }
}

export function readStartups(): StartupRecord[] {
  try {
    const raw = localStorage.getItem(STARTUP_KEY)
    return raw ? (JSON.parse(raw) as StartupRecord[]) : []
  } catch {
    return []
  }
}

/** The current cold start's key number: ms from navigation to UI ready (falls
 * back to core-ready if the UI mark hasn't fired yet). null if nothing timed. */
export function getStartup(): number | null {
  return bootMarks['ui-ready'] ?? bootMarks['core-ready'] ?? null
}

// --- action timing (RPC round-trips etc.) -------------------------------

type Samples = { count: number; last: number; min: number; max: number; total: number }
const actions: Record<string, Samples> = {}

/** Fold one duration (ms) for a named action into a running min/max/avg. Used
 * by the transport wrapper to time selected RPC methods. */
export function recordAction(name: string, ms: number): void {
  const s = (actions[name] ??= { count: 0, last: 0, min: Infinity, max: 0, total: 0 })
  s.count++
  s.last = ms
  s.min = Math.min(s.min, ms)
  s.max = Math.max(s.max, ms)
  s.total += ms
}

/** Everything the diagnostics panel needs, computed on demand. */
export function snapshot() {
  const marks = { ...bootMarks }
  const measures = {
    // spans between milestones; undefined when an endpoint is missing
    'worker→core': span(marks['worker-spawn'], marks['core-ready']),
    'core→ui': span(marks['core-ready'], marks['ui-ready']),
  }
  const actionRows = Object.entries(actions).map(([name, s]) => ({
    name,
    count: s.count,
    last: round(s.last),
    min: round(s.min),
    max: round(s.max),
    avg: round(s.total / s.count),
  }))
  return { marks, measures, actions: actionRows, startups: readStartups() }
}

// clamp to >=0: milestones can arrive slightly out of order (e.g. the UI's
// first-mount effect firing before the core's first RPC resolves), which would
// otherwise show a negative span
const span = (a?: number, b?: number) =>
  a !== undefined && b !== undefined ? round(Math.max(0, b - a)) : undefined
const round = (n: number) => Math.round(n * 10) / 10
