// Unit tests for the fatal-start dialog's copyable report — dependency-free
// (node:test), so they run in CI's lint job without pnpm install / submodules.
//   node --test packages/web-app/src/fatal-report.test.mjs
import { doesNotMatch, match, strictEqual } from 'node:assert'
import { test } from 'node:test'

import { fatalReportText } from './fatal-report.mjs'

test('carries the error text the analytics catalogue cannot (#176)', () => {
  const report = fatalReportText({
    kind: 'init-error',
    details: 'Error: sahpool install failed: NotFoundError',
    version: '0.8.1',
    commitHash: 'deadbeefcafe1234',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)',
    displayMode: 'standalone',
  })
  match(report, /^failure: init-error$/m)
  match(report, /^details: Error: sahpool install failed: NotFoundError$/m)
  match(report, /^build: 0\.8\.1 deadbeef$/m, 'commit is abbreviated')
  match(report, /^display: standalone$/m)
  match(report, /iPhone OS 18_2/)
})

test('a multi-line error stays on one line', () => {
  const report = fatalReportText({
    kind: 'init-error',
    details: 'panicked at lib.rs:42:\n  stack backtrace:\n   0: rust_begin_unwind',
  })
  strictEqual(report.split('\n').length, 2, 'failure + details, nothing more')
  match(report, /^details: panicked at lib\.rs:42: stack backtrace: 0: rust_begin_unwind$/m)
})

test('missing fields are omitted, never rendered as empty or undefined', () => {
  const report = fatalReportText({ kind: 'opfs-locked' })
  strictEqual(report, 'failure: opfs-locked')
  doesNotMatch(report, /undefined/)
})

test('no arguments does not throw', () => {
  strictEqual(fatalReportText(), '')
})

test('a version with no commit hash still renders a build line', () => {
  match(fatalReportText({ kind: 'x', version: '0.9.0' }), /^build: 0\.9\.0$/m)
})

test('a dirty-build hash is abbreviated without its suffix', () => {
  const report = fatalReportText({ kind: 'x', version: '0.9.0', commitHash: 'c381266-dirty' })
  match(report, /^build: 0\.9\.0 c381266$/m, 'no trailing dash from the suffix')
})
