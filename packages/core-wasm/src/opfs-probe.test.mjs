// Unit tests for the OPFS lock-wait policy — dependency-free (node:test), so
// they run in CI's lint job without pnpm install / submodules / a browser.
//   node --test packages/core-wasm/src/opfs-probe.test.mjs
import { ok, rejects, strictEqual } from 'node:assert'
import { test } from 'node:test'

import {
  OPFS_PROBE_DEADLINE_MS,
  OPFS_PROBE_RETRY_MS,
  probeUntilDeadline,
} from './opfs-probe.mjs'

// Scaled-down deadlines keep the suite in milliseconds; the shipped numbers
// are asserted separately below.
const fast = { deadlineMs: 150, retryMs: 10 }

// The M-06 verification: stub a handle acquisition that never settles, assert
// startup fails within the deadline with only one probe outstanding.
test('a probe that never settles fails within the deadline, alone', async () => {
  let started = 0
  const began = Date.now()
  const outcome = await probeUntilDeadline(() => {
    started++
    return new Promise(() => {}) // a createSyncAccessHandle that hangs forever
  }, fast)
  strictEqual(outcome, 'hung')
  strictEqual(started, 1, 'a hung probe must never be joined by a second one')
  ok(Date.now() - began < fast.deadlineMs * 4, 'gave up around the deadline, not later')
})

// The regression the growing per-attempt budget existed to prevent: a slow but
// working device must not be told it is "already running in another tab".
test('a slow pass that does finish wins the whole budget', async () => {
  const outcome = await probeUntilDeadline(
    () => new Promise(resolve => setTimeout(() => resolve(true), fast.deadlineMs * 0.8)),
    fast
  )
  strictEqual(outcome, 'ready')
})

test('a lock still held is retried, then reported as locked', async () => {
  let started = 0
  const outcome = await probeUntilDeadline(async () => {
    started++
    return false // a fast rejection, classified by the caller as "retry"
  }, fast)
  strictEqual(outcome, 'locked')
  ok(started > 1, `fast rejections must be retried, got ${started} attempt(s)`)
})

test('a lock released while waiting is picked up', async () => {
  let started = 0
  strictEqual(await probeUntilDeadline(async () => ++started >= 3, fast), 'ready')
  strictEqual(started, 3)
})

test('an error the caller calls fatal ends the wait instead of retrying', async () => {
  let started = 0
  await rejects(
    () =>
      probeUntilDeadline(async () => {
        started++
        throw new Error('storage blocked')
      }, fast),
    /storage blocked/
  )
  strictEqual(started, 1)
})

// Both halves of the chosen deadline, so neither can drift back: long enough
// for two full passes at the old policy's 12s per-pass ceiling (slow eMMC),
// short enough that a stuck boot is never the ~320s freeze of audit M-06.
test('the shipped deadline stays inside its justification', () => {
  ok(OPFS_PROBE_DEADLINE_MS >= 2 * 12_000, 'must fit two slow-storage passes')
  ok(OPFS_PROBE_DEADLINE_MS <= 45_000, 'must not become a frozen-screen wait again')
  ok(OPFS_PROBE_RETRY_MS < OPFS_PROBE_DEADLINE_MS / 10, 'retry gap must not dominate')
})
