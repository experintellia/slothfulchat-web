// The npm staging loop in .github/workflows/publish-npm.yml, run for real
// against a stub `npm`.
//
// It is the last thing that touches a release before the registry does, it
// only ever executes on a tag (so a bug in it is found in production, once,
// loudly), and its one subtle branch — tolerate the "already staged" conflict
// a re-run hits, fail on everything else — is exactly the kind that looks
// right and swallows a 500. So: extract the step's shell out of the YAML and
// run it, rather than test a copy that can drift from what ships.

import { test } from 'node:test'
import { strictEqual, ok, match } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORKFLOW = new URL('../.github/workflows/publish-npm.yml', import.meta.url)
const STEP = 'Stage the tarballs whose version is new'

/** The step's `run:` block, dedented — i.e. the script the runner executes. */
function stageScript() {
  const lines = readFileSync(WORKFLOW, 'utf-8').split('\n')
  const start = lines.findIndex(l => l.trim() === `- name: ${STEP}`)
  ok(start >= 0, `step "${STEP}" not found — was it renamed?`)
  const runAt = lines.indexOf('        run: |', start)
  ok(runAt > start && runAt < start + 20, 'no `run: |` block under the step')
  const body = []
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break
    body.push(line.slice(10))
  }
  ok(body.join('\n').includes('npm stage publish'), 'extracted the wrong block')
  return body.join('\n')
}

/**
 * Run the step in a scratch dir holding one tarball per spec.
 * `registry` = specs npm view finds; `conflict`/`fail` = tarballs whose
 * `npm stage publish` dies, with a version conflict / with anything else.
 */
function runStage(specs, { registry = [], conflict = [], fail = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-loop-'))
  mkdirSync(join(dir, 'npm-tarballs'))
  mkdirSync(join(dir, 'bin'))

  for (const [file, spec] of Object.entries(specs)) {
    const at = spec.lastIndexOf('@')
    const pkg = join(dir, 'pack', 'package')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: spec.slice(0, at), version: spec.slice(at + 1) })
    )
    execFileSync('tar', ['-czf', join(dir, 'npm-tarballs', file), '-C', join(dir, 'pack'), 'package'])
  }

  // `npm view <spec> version` and `npm stage publish <tgz> ...`, and nothing
  // else — a call the loop is not supposed to make shows up as an exit 66.
  const npm = join(dir, 'bin', 'npm')
  writeFileSync(
    npm,
    `#!/bin/sh
echo "$@" >> "${join(dir, 'calls.log')}"
case "$1 $2" in
  "view "*)
    case " ${registry.join(' ')} " in *" $2 "*) exit 0;; esac
    echo "npm error code E404" >&2; exit 1;;
  "stage publish")
    base=\`basename "$3"\`
    case " ${conflict.join(' ')} " in *" $base "*)
      echo "npm error code EPUBLISHCONFLICT" >&2
      echo "npm error You cannot publish over the previously published versions" >&2
      exit 1;; esac
    case " ${fail.join(' ')} " in *" $base "*)
      echo "npm error code E500" >&2; echo "npm error 500 Internal Server Error" >&2; exit 1;; esac
    exit 0;;
esac
exit 66
`
  )
  chmodSync(npm, 0o755)

  let stdout, status = 0
  try {
    stdout = execFileSync('bash', ['-c', stageScript()], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    })
  } catch (e) {
    stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`
    status = e.status
  }
  const calls = (() => {
    try {
      return readFileSync(join(dir, 'calls.log'), 'utf-8').trim().split('\n')
    } catch {
      return []
    }
  })()
  return { stdout, status, calls }
}

test('a version already on the registry is skipped, not re-staged', () => {
  const r = runStage({ 'a.tgz': '@slothfulchat/core-wasm@1.0.0' }, {
    registry: ['@slothfulchat/core-wasm@1.0.0'],
  })
  strictEqual(r.status, 0, r.stdout)
  match(r.stdout, /already on the registry/)
  ok(
    !r.calls.some(c => c.startsWith('stage publish')),
    `re-staged a published version: ${r.calls.join(' | ')}`
  )
})

test('a new version is staged', () => {
  const r = runStage({ 'a.tgz': '@slothfulchat/ws-tcp-proxy@2.0.0' })
  strictEqual(r.status, 0, r.stdout)
  match(r.stdout, /staging @slothfulchat\/ws-tcp-proxy@2\.0\.0/)
  ok(r.calls.some(c => c.startsWith('stage publish')), 'never called npm stage publish')
  // The whole point of staging: the run must say so, or someone watches it go
  // green and never approves.
  match(r.stdout, /::notice::.*approve/)
})

test('a re-run over an already-staged version continues instead of failing', () => {
  // The realistic partial train: a staged, b staged, c died. On the re-run
  // npm view still cannot see a and b (staged versions are invisible), so the
  // loop meets their conflicts and must push on to c.
  const r = runStage(
    { 'a.tgz': '@slothfulchat/a@1.0.0', 'b.tgz': '@slothfulchat/b@1.0.0', 'c.tgz': '@slothfulchat/c@1.0.0' },
    { conflict: ['a.tgz', 'b.tgz'] }
  )
  strictEqual(r.status, 0, r.stdout)
  strictEqual((r.stdout.match(/is already staged/g) ?? []).length, 2, r.stdout)
  ok(r.calls.includes('stage publish npm-tarballs/c.tgz --access public --ignore-scripts'), r.calls.join(' | '))
})

test('any other staging failure stops the run', () => {
  const r = runStage(
    { 'a.tgz': '@slothfulchat/a@1.0.0', 'b.tgz': '@slothfulchat/b@1.0.0' },
    { fail: ['a.tgz'] }
  )
  ok(r.status !== 0, `a registry 500 was swallowed:\n${r.stdout}`)
  match(r.stdout, /500 Internal Server Error/) // the real error is surfaced, not eaten
  ok(
    !r.calls.includes('stage publish npm-tarballs/b.tgz --access public --ignore-scripts'),
    'kept staging after a hard failure'
  )
})
