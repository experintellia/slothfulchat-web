/**
 * The "wait until the OPFS sync handles are free" retry policy, kept as plain
 * .mjs beside the worker so it can be unit-tested with `node --test` and no
 * browser (same idea as web-app's blob-route.mjs).
 *
 * The worker must not start core while the previous worker still holds OPFS
 * sync access handles (see waitForOpfsSyncHandles in worker.ts). Probing for
 * that has two failure shapes, and they need opposite treatment:
 *
 *   - the probe REJECTS (a handle is locked). Fast, and worth retrying: the
 *     previous worker may still be tearing down.
 *   - the probe never settles at all — `createSyncAccessHandle` can HANG
 *     rather than reject while the previous worker is mid-teardown. Here
 *     retrying is the worst possible move: a second probe walks the same pool
 *     and hangs on the same handle, nothing can cancel the first, and the
 *     hung probes pile up. That is the probe storm in audit finding M-06.
 *
 * So the rule is: never start a probe while one is still outstanding. A hung
 * probe is waited on rather than replaced — if the teardown completes it
 * un-hangs and finishes the pass — and reported only when the deadline is up.
 */

/**
 * Total wall clock for the whole wait, hang included.
 *
 * The old policy (30 attempts, per-attempt budget growing 2s→12s, 500ms apart)
 * summed to ~320s of frozen loading screen. 30s is chosen so that no device
 * the old policy could serve loses anything:
 *
 *   - slow storage: the sahpool has max(32, 2N+8) files and never shrinks, so
 *     one full pass on low-end eMMC can take seconds. The old policy capped a
 *     pass at 12s (`Math.min(2000 + …, 12000)`) — a pass slower than that
 *     never succeeded under it either, it just kept re-timing out. Here a
 *     single pass may use the whole budget, and 30s ≈ two full 12s passes plus
 *     the retry gap, so a slow device gets its slowest tolerated pass and then
 *     a complete second try. It also gets the full budget on the FIRST attempt
 *     instead of only reaching 12s at attempt eleven. A slow-but-working
 *     device therefore cannot be misreported as "running in another tab".
 *   - lock genuinely held by a live tab: those rejections are fast, so the old
 *     policy in practice gave up after ~30 × 500ms ≈ 15s (see
 *     scripts/test-two-tabs.mjs). 30s is double that.
 *
 * The ~320s only ever materialised in the hang case — the one case where more
 * waiting cannot help, because every extra attempt hung too.
 */
export const OPFS_PROBE_DEADLINE_MS = 30_000

/** Pause between retries after a fast rejection. */
export const OPFS_PROBE_RETRY_MS = 500

/** Distinct from anything `probeOnce` can resolve with. */
const HUNG = Symbol('probe still outstanding')

/**
 * Run `probeOnce` until it succeeds or the deadline passes, with at most one
 * probe outstanding at any moment.
 *
 * `probeOnce()` resolves truthy when the handles are free (or there is nothing
 * to lock), falsy when they are locked and it is worth retrying, and throws
 * for a condition retrying cannot fix (the caller classifies; e.g. storage
 * blocked by browser settings) — that error propagates without a retry.
 *
 * Returns 'ready' | 'locked' (kept rejecting) | 'hung' (never settled). The
 * caller treats the latter two the same way; they differ only in what is worth
 * logging, and 'hung' is what the M-06 verification asserts.
 */
export async function probeUntilDeadline(
  probeOnce,
  { deadlineMs = OPFS_PROBE_DEADLINE_MS, retryMs = OPFS_PROBE_RETRY_MS } = {}
) {
  const until = Date.now() + deadlineMs
  for (;;) {
    const left = until - Date.now()
    if (left <= 0) return 'locked'
    let timer
    let outcome
    try {
      outcome = await Promise.race([
        probeOnce(),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(HUNG), left)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (outcome === HUNG) return 'hung'
    if (outcome) return 'ready'
    // no point starting a pass that cannot finish before the deadline
    if (until - Date.now() <= retryMs) return 'locked'
    await new Promise(resolve => setTimeout(resolve, retryMs))
  }
}
