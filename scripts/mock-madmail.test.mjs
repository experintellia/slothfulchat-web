// Contract check for the shared mock madmail server. Five e2e scripts
// provision their accounts against it, so a silent change here shows up as a
// confusing failure in whichever of them runs first.
//   node --test scripts/mock-madmail.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMockMadmail } from './mock-madmail.mjs'

const api = mock => {
  const base = `http://127.0.0.1:${mock.port}`
  return {
    provision: () => fetch(`${base}/new`, { method: 'POST' }).then(r => r.json()),
    get: (u, path) =>
      fetch(base + path, { headers: { 'X-Email': u.email, 'X-Password': u.password } }),
    del: (u, path) =>
      fetch(base + path, {
        method: 'DELETE',
        headers: { 'X-Email': u.email, 'X-Password': u.password },
      }),
    send: (u, to, body) =>
      fetch(`${base}/webimap/send`, {
        method: 'POST',
        headers: {
          'X-Email': u.email,
          'X-Password': u.password,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to, body }),
      }),
  }
}

test('provisions distinct accounts', async () => {
  const mock = await startMockMadmail()
  try {
    const a = await api(mock).provision()
    const b = await api(mock).provision()
    assert.match(a.email, /@webimap\.example$/)
    assert.notEqual(a.email, b.email)
    assert.notEqual(a.password, b.password)
    assert.equal(mock.counters.newCalls, 2)
  } finally {
    mock.close()
  }
})

test('refuses /webimap without valid credentials', async () => {
  const mock = await startMockMadmail()
  try {
    const a = await api(mock).provision()
    assert.equal((await api(mock).get(a, '/webimap/mailboxes')).status, 200)
    const wrong = { email: a.email, password: 'nope' }
    assert.equal((await api(mock).get(wrong, '/webimap/mailboxes')).status, 401)
    const unknown = { email: 'nobody@webimap.example', password: 'x' }
    assert.equal((await api(mock).get(unknown, '/webimap/mailboxes')).status, 401)
  } finally {
    mock.close()
  }
})

test('delivers a message and serves it once, then deletes it', async () => {
  const mock = await startMockMadmail()
  const c = api(mock)
  try {
    const alice = await c.provision()
    const bob = await c.provision()
    await c.send(alice, [bob.email], 'hello bob')

    const listed = await (await c.get(bob, '/webimap/messages?since_uid=0')).json()
    assert.equal(listed.length, 1, 'bob has exactly one message')
    const uid = listed[0].uid

    const full = await (await c.get(bob, `/webimap/message/${uid}`)).json()
    assert.equal(full.body, 'hello bob')

    assert.equal((await c.del(bob, `/webimap/message/${uid}`)).status, 200)
    const after = await (await c.get(bob, '/webimap/messages?since_uid=0')).json()
    assert.equal(after.length, 0, 'deleted message is gone')

    // the sender's own mailbox stays empty — delivery is one-way
    const senderBox = await (await c.get(alice, '/webimap/messages?since_uid=0')).json()
    assert.equal(senderBox.length, 0)
  } finally {
    mock.close()
  }
})

test('a parked long-poll is woken by delivery, not left to time out', async () => {
  // This is the behaviour the e2e scripts actually depend on: the core parks a
  // poll, the other account sends, and the poll must return promptly.
  const mock = await startMockMadmail()
  const c = api(mock)
  try {
    const alice = await c.provision()
    const bob = await c.provision()
    const started = Date.now()
    const parked = c.get(bob, '/webimap/messages?since_uid=0&wait=120')
    await new Promise(r => setTimeout(r, 100)) // let it park
    await c.send(alice, [bob.email], 'wake up')
    const listed = await (await parked).json()
    assert.equal(listed.length, 1)
    assert.ok(Date.now() - started < 5000, 'poll returned on delivery, not on timeout')
  } finally {
    mock.close()
  }
})

test('close() answers parked polls so the loop can exit', async () => {
  // Not cosmetic: server.close() waits for open connections, so a poll left
  // hanging keeps both its 120s timer and its socket alive and the process
  // never exits — which is exactly how this test first failed.
  const mock = await startMockMadmail()
  const c = api(mock)
  const bob = await c.provision()
  const parked = c.get(bob, '/webimap/messages?since_uid=0&wait=120')
  await new Promise(r => setTimeout(r, 100))
  const user = mock.users.get(bob.email)
  assert.equal(user.waiters.length, 1, 'a poll is parked')
  mock.close()
  assert.equal(user.waiters.length, 0, 'close() dropped it')
  assert.deepEqual(await (await parked).json(), [], 'and answered it')
})

test('probes serve the two 404-tolerance shapes, and only when asked', async () => {
  const plain = await startMockMadmail()
  try {
    const u = await api(plain).provision()
    const listed = await (await api(plain).get(u, '/webimap/messages?since_uid=0')).json()
    assert.equal(listed.length, 0, 'no phantom without probes')
  } finally {
    plain.close()
  }

  const mock = await startMockMadmail({ probes: true })
  const c = api(mock)
  try {
    const alice = await c.provision()
    const bob = await c.provision()

    // phantom: advertised once, already gone on GET
    const first = await (await c.get(bob, '/webimap/messages?since_uid=0')).json()
    assert.equal(first.length, 1, 'phantom uid is listed once')
    assert.equal((await c.get(bob, `/webimap/message/${first[0].uid}`)).status, 404)
    const second = await (await c.get(bob, '/webimap/messages?since_uid=0')).json()
    assert.equal(second.length, 0, 'phantom is not listed again')

    // real mail starts above the phantom uid, so it is never shadowed
    await c.send(alice, [bob.email], 'real one')
    const real = await (await c.get(bob, '/webimap/messages?since_uid=0')).json()
    assert.equal(real.length, 1)
    assert.ok(real[0].uid > first[0].uid, 'real uid is above the phantom')

    // first DELETE really deletes but answers 404; the next one answers 200
    assert.equal((await c.del(bob, `/webimap/message/${real[0].uid}`)).status, 404)
    const gone = await (await c.get(bob, '/webimap/messages?since_uid=0')).json()
    assert.equal(gone.length, 0, 'the 404-answered delete still deleted')
    await c.send(alice, [bob.email], 'another')
    const next = await (await c.get(bob, '/webimap/messages?since_uid=0')).json()
    assert.equal((await c.del(bob, `/webimap/message/${next[0].uid}`)).status, 200)
  } finally {
    mock.close()
  }
})
