// Self-check for the shared e2e boot/teardown. Nineteen scripts start this
// way, so "the server never came up" or "the children outlived the run" would
// show up as a baffling failure in whichever of them runs first.
//   node --test scripts/harness.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { request } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServers, script } from './harness.mjs'

const get = (port, path = '/') =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })

const alive = async port => {
  try {
    await get(port)
    return true
  } catch {
    return false
  }
}

test('script() resolves repo paths from scripts/, not the cwd', () => {
  assert.ok(script('../packages/web-app/serve.mjs').endsWith('/packages/web-app/serve.mjs'))
  assert.ok(!script('../packages/web-app/serve.mjs').includes('/scripts/../'))
})

test('starts the app server, serves from it, and cleanup kills it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-test-'))
  await writeFile(join(dir, 'main.html'), '<p>up</p>')
  const port = 8761
  const { appServer, proxy, procs, cleanup, watchdog } = await startServers({
    app: port,
    appRoot: dir,
  })
  try {
    assert.equal(proxy, null, 'no proxy was requested')
    assert.equal(procs.length, 1)
    assert.equal(watchdog, null, 'no watchdog was requested')
    assert.equal(await get(port, '/main.html'), 200)
    assert.equal(await get(port, '/'), 200, 'SERVE_INDEX default is main.html')
  } finally {
    cleanup()
    await rm(dir, { recursive: true, force: true })
  }
  // kill is asynchronous; give the child a moment to actually go
  for (let i = 0; i < 40 && (await alive(port)); i++) {
    await new Promise(r => setTimeout(r, 50))
  }
  assert.equal(appServer.killed, true)
  assert.equal(await alive(port), false, 'port released after cleanup')
})

test('appIndex maps "/" to a different entry point', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-test-'))
  await writeFile(join(dir, 'other.html'), '<p>other</p>')
  const port = 8762
  const { cleanup } = await startServers({ app: port, appRoot: dir, appIndex: 'other.html' })
  try {
    assert.equal(await get(port, '/'), 200)
  } finally {
    cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the watchdog fails the run and takes the children with it', async () => {
  // Run in a child: the watchdog calls process.exit, which would end this one.
  const runner = fileURLToPath(new URL('./harness.test.watchdog.mjs', import.meta.url))
  const { code, stderr } = await new Promise(resolve => {
    execFile('node', [runner], (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stderr })
    )
  })
  assert.equal(code, 1, 'a hung run exits non-zero')
  assert.match(stderr, /global watchdog/, 'and says why')
  assert.match(stderr, /wedged-example/, 'naming the run')
})
