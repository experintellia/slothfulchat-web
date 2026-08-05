// serve.mjs is the dev static server for both the web-app dist/ and the
// core-wasm example. Its one piece of non-trivial logic is the boundary check,
// so that is what this covers: what it serves, and what it must refuse.
//   node --test packages/web-app/serve.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 8749
const serveMjs = fileURLToPath(new URL('./serve.mjs', import.meta.url))
let base, child

// Layout: base/root is served, base/ is the boundary. So base/outside is
// reachable through a symlink (the pnpm case the example needs) while
// base-evil, a sibling sharing the boundary's string prefix, is not.
before(async () => {
  base = await mkdtemp(join(tmpdir(), 'serve-test-'))
  await mkdir(join(base, 'root'))
  await writeFile(join(base, 'root', 'index.html'), '<p>hi</p>')
  await writeFile(join(base, 'outside.txt'), 'in boundary, outside root')
  await writeFile(join(base, 'secret.txt'), 'never served')
  await symlink(join(base, 'outside.txt'), join(base, 'root', 'linked.txt'))
  await symlink('/etc/hostname', join(base, 'root', 'escape.txt'))

  child = spawn('node', [serveMjs], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SERVE_ROOT: join(base, 'root'),
      SERVE_BOUNDARY: base,
      SERVE_INDEX: 'index.html',
    },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try {
      await get('/index.html')
      return
    } catch {
      await new Promise(r => setTimeout(r, 50))
    }
  }
  throw new Error('server did not start')
})

after(async () => {
  child?.kill()
  await rm(base, { recursive: true, force: true })
})

// node:http with an explicit `path`, NOT fetch(): fetch resolves dot-segments
// client-side per WHATWG URL, so `/../../etc/passwd` would leave as `/etc/passwd`
// and the traversal cases would silently test nothing.
const get = (path, port = PORT) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })

test('serves a file under the root', async () => {
  const res = await get('/index.html')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/html')
  assert.match(res.body, /hi/)
})

test('"/" maps to SERVE_INDEX', async () => {
  assert.equal((await get('/')).status, 200)
})

test('follows a symlink that stays inside the boundary', async () => {
  // the pnpm case: the example's deps are symlinks out into the workspace
  const res = await get('/linked.txt')
  assert.equal(res.status, 200)
  assert.match(res.body, /in boundary, outside root/)
})

test('refuses a symlink pointing outside the boundary', async () => {
  // realpath resolves before the check, so the target is what gets judged
  assert.equal((await get('/escape.txt')).status, 404)
})

test('dot-segments never reach the filesystem', async () => {
  // Pinned, not guarded-against: `new URL()` resolves BOTH `../` and its
  // percent-encoded `%2e%2e` form away during parsing, so no request path can
  // climb. That is why the boundary check below is about symlinks, which the
  // URL parser knows nothing about.
  assert.equal((await get('/../../etc/hostname')).status, 404)
  assert.equal((await get('/%2e%2e/%2e%2e/etc/hostname')).status, 404)
})

test('the default boundary is the served root', async () => {
  // What the web-app itself runs with: no SERVE_BOUNDARY, so the symlink that
  // resolves above the root — served in the widened-boundary case above — is
  // refused here.
  const port = PORT + 1
  const tight = spawn('node', [serveMjs], {
    env: { ...process.env, PORT: String(port), SERVE_ROOT: join(base, 'root') },
    stdio: 'ignore',
  })
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await get('/index.html', port)
        break
      } catch {
        await new Promise(r => setTimeout(r, 50))
      }
    }
    assert.equal((await get('/index.html', port)).status, 200)
    assert.equal((await get('/linked.txt', port)).status, 404)
  } finally {
    tight.kill()
  }
})

test('a sibling sharing the boundary prefix is not inside it', async () => {
  // Guards the classic bare-startsWith bug: boundary /base must not match
  // /base-evil. Reached by symlink, the only way out of the boundary left.
  const evil = `${base}-evil`
  await mkdir(evil, { recursive: true })
  await writeFile(join(evil, 'pwned.txt'), 'nope')
  await symlink(join(evil, 'pwned.txt'), join(base, 'root', 'sibling.txt'))
  try {
    const res = await get('/sibling.txt')
    assert.equal(res.status, 404, 'a path sharing the boundary prefix must not be served')
  } finally {
    await rm(evil, { recursive: true, force: true })
  }
})

test('404s a missing file', async () => {
  assert.equal((await get('/nope.txt')).status, 404)
})
