// Unit tests for the fatal-start dialog's copyable report — dependency-free
// (node:test), so they run in CI's lint job without pnpm install / submodules.
//   node --test packages/web-app/src/fatal-report.test.mjs
import { doesNotMatch, match, ok, strictEqual } from 'node:assert'
import { test } from 'node:test'

import {
  fatalDetails,
  fatalReportText,
  fatalReportUrl,
  isOurBug,
  reportChoiceNote,
} from './fatal-report.ts'

// The two shapes `stack` really comes in. V8 repeats the message on the first
// line; SpiderMonkey/JavaScriptCore give frames only.
const V8_STACK = 'Error: sahpool install failed: NotFoundError\n    at install (worker.ts:311:9)'
const SPIDERMONKEY_STACK = 'install@https://web.slothful.chat/worker.js:311:9'

test('the stack rides along, and the message is never doubled or dropped', () => {
  const message = 'Error: sahpool install failed: NotFoundError'
  strictEqual(fatalDetails(message, V8_STACK), V8_STACK, 'V8 already leads with the message')
  strictEqual(
    fatalDetails(message, SPIDERMONKEY_STACK),
    `${message}\n${SPIDERMONKEY_STACK}`,
    'frames-only stacks keep the message that names the failure'
  )
  match(fatalDetails(message, SPIDERMONKEY_STACK), /install@/, 'and keep the frames')
})

test('no stack (a thrown string, an old engine) still yields the message', () => {
  strictEqual(fatalDetails('Error: boom', ''), 'Error: boom')
  strictEqual(fatalDetails('Error: boom', undefined), 'Error: boom')
  strictEqual(fatalDetails('', ''), 'unknown error', 'never renders as empty')
  strictEqual(fatalDetails(), 'unknown error')
})

test('carries the error text the analytics catalogue cannot (#176)', () => {
  const report = fatalReportText({
    kind: 'init-error',
    details: 'Error: sahpool install failed: NotFoundError',
    version: '0.8.1',
    commitHash: 'deadbeefcafe1234',
    origin: 'https://web.slothful.chat',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)',
    displayMode: 'standalone',
  })
  match(report, /^failure: init-error$/m)
  match(report, /^details: Error: sahpool install failed: NotFoundError$/m)
  match(report, /^build: 0\.8\.1 deadbeef$/m, 'commit is abbreviated')
  match(report, /^origin: https:\/\/web\.slothful\.chat$/m)
  match(report, /^display: standalone$/m)
  match(report, /iPhone OS 18_2/)
})

test('names the deployment it came from, so a PR preview is not read as prod', () => {
  const preview = fatalReportText({
    kind: 'init-error',
    version: '0.8.1',
    origin: 'https://pr-42.preview.slothful.chat',
  })
  match(preview, /^origin: https:\/\/pr-42\.preview\.slothful\.chat$/m)
  // same version, different slot — the origin is the only line telling them apart
  const prod = fatalReportText({ kind: 'init-error', version: '0.8.1', origin: 'https://web.slothful.chat' })
  match(prod, /^origin: https:\/\/web\.slothful\.chat$/m)
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

test('only a failure of ours starts expanded — first aid outranks the report', () => {
  // nothing the user can do about these two, so the report is the useful thing
  for (const kind of ['init-error', 'worker-died']) ok(isOurBug(kind), kind)
  // each of these comes with a step that fixes it, which must stay in front
  for (const kind of ['opfs-locked', 'storage-blocked', 'no-wasm', '']) {
    ok(!isOurBug(kind), kind)
  }
  ok(!isOurBug(), 'no kind at all is not a claim that it is ours')
})

test('the note names what the tracker costs, and only when there is a tracker', () => {
  const both = reportChoiceNote('https://tracker.test/new', 'https://report.test/')
  match(both, /account/, 'the reason most reports never get filed')
  match(both, /public/, 'and that it is filed in the open')
  match(both, /needs neither/, 'and that the other button avoids both')
  match(reportChoiceNote('https://tracker.test/new'), /account/)
  doesNotMatch(reportChoiceNote('https://tracker.test/new'), /needs neither/, 'no second button')
  // nothing to warn about: a no-account button costs the user nothing to press,
  // and with no button at all there is nothing to explain
  strictEqual(reportChoiceNote('', 'https://report.test/'), '')
  strictEqual(reportChoiceNote('', ''), '')
  strictEqual(reportChoiceNote(), '')
})

test('the note claims "no account", never "anonymous" — the request carries an IP', () => {
  for (const note of [reportChoiceNote('https://t.test/', 'https://r.test/'), reportChoiceNote('https://t.test/')]) {
    doesNotMatch(note, /anonym/i, 'a claim about identity we cannot keep')
  }
})

test('the report link prefills kind and error text at the configured destination', () => {
  const report = fatalReportText({
    kind: 'init-error',
    details: 'Error: sahpool install failed: NotFoundError',
  })
  const url = new URL(
    fatalReportUrl('https://github.com/experintellia/slothfulchat-web/issues/new', report, 'init-error')
  )
  strictEqual(url.origin + url.pathname, 'https://github.com/experintellia/slothfulchat-web/issues/new')
  match(url.searchParams.get('title'), /init-error/)
  match(url.searchParams.get('body'), /^failure: init-error$/m)
  match(url.searchParams.get('body'), /sahpool install failed/)
})

test('no destination configured → no link at all, so the dialog shows no button', () => {
  strictEqual(fatalReportUrl('', 'failure: init-error'), '')
  strictEqual(fatalReportUrl(undefined, 'failure: init-error'), '')
  strictEqual(fatalReportUrl('not a url', 'failure: init-error'), '', 'a hand-edited config.js cannot throw')
  strictEqual(fatalReportUrl('https://example.test/report', ''), '', 'nothing to report')
})

test("a destination's own query survives (e.g. GitHub issue labels)", () => {
  const url = new URL(fatalReportUrl('https://example.test/new?labels=bug', 'failure: x'))
  strictEqual(url.searchParams.get('labels'), 'bug')
  strictEqual(url.searchParams.get('body'), 'failure: x')
})

test('a panic backtrace is clipped, not sent as a URL the server refuses', () => {
  const url = fatalReportUrl('https://example.test/r', 'failure: x\ndetails: ' + 'a'.repeat(9000))
  ok(url.length <= 6000, `URL stayed under the limit (${url.length})`)
  match(url, /failure/, 'the useful head of the report is still there')
})

test('a clipped report keeps the metadata and loses only the stack tail', () => {
  // the biggest reports are the ones that most need saying WHICH build and
  // WHICH deployment: clipping must never cost those lines
  const report = fatalReportText({
    kind: 'init-error',
    details: 'panicked\n' + '    at frame '.repeat(2000),
    version: '0.8.1',
    commitHash: 'c381266f',
    origin: 'https://pr-42.preview.slothful.chat',
    displayMode: 'standalone',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/150',
  })
  const body = new URL(fatalReportUrl('https://report.example.test/', report, 'init-error'))
    .searchParams.get('body')
  for (const line of ['failure:', 'build:', 'origin:', 'display:', 'browser:']) {
    match(body, new RegExp('^' + line, 'm'), `${line} survived the clip`)
  }
  match(body, /at frame/, 'and the head of the stack is still there')
})

test('a post-boot crash is not titled "could not start"', () => {
  const url = new URL(fatalReportUrl('https://example.test/r', 'failure: worker-died', 'worker-died'))
  doesNotMatch(url.searchParams.get('title'), /could not start/i)
  match(url.searchParams.get('title'), /worker-died/)
})

test('a non-ASCII error is clipped by ENCODED length, not by character count', () => {
  // one CJK character percent-encodes to nine, so a character-count clip
  // bounds nothing: this is the case that still 414'd
  const url = fatalReportUrl('https://example.test/r', 'failure: x\ndetails: ' + '错'.repeat(9000))
  ok(url.length <= 6000, `URL stayed under the limit (${url.length})`)
  match(url, /failure/, 'the useful head of the report is still there')
})

test('a report that already fits is sent whole, not clipped', () => {
  const report = fatalReportText({ kind: 'init-error', details: 'Error: NotFoundError' })
  strictEqual(
    new URL(fatalReportUrl('https://example.test/r', report)).searchParams.get('body'),
    report
  )
})
