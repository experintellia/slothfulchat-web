// The webxdc.js an app sees, driven against a fake parent window.
//   node --test packages/web-app/src/webxdc-shim.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shimSource, webxdcShim, type ShimConfig } from './webxdc-shim.ts'

const APP = 'https://chat.example'
const cfg: ShimConfig = {
  parentOrigin: APP,
  selfAddr: 'me@x',
  selfName: 'Me "</script>',
  sendUpdateInterval: 10000,
  sendUpdateMaxSize: 128000,
  isAppSender: false,
  isBroadcast: false,
}

/** A frame whose parent records what it is sent; `from` delivers a message. */
function frame() {
  const sent: any[] = []
  const listeners: Record<string, ((e: any) => void)[]> = {}
  const parent = { postMessage: (m: any, origin: string) => sent.push({ ...m, origin }) }
  const location = { href: 'https://abcm1.webxdc.chat.example/index.html', origin: 'https://abcm1.webxdc.chat.example' }
  const w: any = { parent, location, addEventListener: (t: string, f: any) => (listeners[t] ??= []).push(f) }
  webxdcShim(cfg, w)
  const from = (source: any, origin: string, data: any) => listeners.message.forEach(f => f({ source, origin, data }))
  const reply = (id: number, result: unknown) => from(parent, APP, { webxdc: 'reply', id, result })
  return { w, sent, parent, from, reply, listeners }
}
const tick = () => new Promise(r => setTimeout(r, 0))

test('requests go to the parent, at the app origin only', async () => {
  const { w, sent } = frame()
  w.webxdc.sendUpdate({ payload: 1 })
  assert.match(sent[0].id, /^[a-z0-9]+\.1$/)
  assert.deepEqual(sent, [{ webxdc: 'sendUpdate', id: sent[0].id, update: '{"payload":1}', origin: APP }])
  assert.equal(w.webxdc.selfName, cfg.selfName)
})

test('setUpdateListener replays from the serial, then resolves', async () => {
  const { w, sent, reply } = frame()
  const got: any[] = []
  let ready = false
  w.webxdc.setUpdateListener((u: any) => got.push(u.payload), 2).then(() => (ready = true))
  assert.equal(sent[0].serial, 2)
  reply(sent[0].id, JSON.stringify([{ payload: 'a', max_serial: 3 }, { payload: 'b', max_serial: 4 }]))
  await tick()
  assert.deepEqual(got, ['a', 'b'])
  assert.equal(ready, true)
})

test('an update announced while fetching is fetched right after', async () => {
  // upstream's preload only caught up on the NEXT announcement here
  const { w, sent, reply, from, parent } = frame()
  const got: any[] = []
  w.webxdc.setUpdateListener((u: any) => got.push(u.payload))
  from(parent, APP, { webxdc: 'statusUpdate' }) // arrives mid-fetch
  reply(sent[0].id, JSON.stringify([{ payload: 'a', max_serial: 1 }]))
  await tick()
  assert.equal(sent.length, 2, 'a second fetch follows')
  assert.equal(sent[1].serial, 1)
  reply(sent[1].id, JSON.stringify([{ payload: 'b', max_serial: 2 }]))
  await tick()
  assert.deepEqual(got, ['a', 'b'])
})

test('messages from any other origin are ignored', async () => {
  const { w, sent, from, parent } = frame()
  w.webxdc.setUpdateListener(() => {})
  from(parent, 'https://evil.example', { webxdc: 'statusUpdate' })
  from({}, 'https://evil.example', { webxdc: 'reply', id: sent[0].id, result: '[{"max_serial":9}]' })
  await tick()
  assert.equal(sent.length, 1, 'no extra fetch was triggered')
})

test('replies come from the chat app origin, also from its window (app windows)', async () => {
  const { w, sent, from } = frame()
  let ready = false
  w.webxdc.setUpdateListener(() => {}).then(() => (ready = true))
  from({ opener: true }, APP, { webxdc: 'reply', id: sent[0].id, result: '[]' })
  await tick()
  assert.equal(ready, true)
})

test('a stale reply from before a reload cannot settle a new request', async () => {
  const before = frame()
  before.w.webxdc.sendToChat({ text: 'x' })
  const after = frame()
  let ready = false
  after.w.webxdc.setUpdateListener(() => {}).then(() => (ready = true))
  after.reply(before.sent[0].id, undefined) // same number, other document
  await tick()
  assert.equal(ready, false)
  assert.notEqual(before.sent[0].id, after.sent[0].id)
})

test('getMemberList asks the parent and resolves with its answer', async () => {
  const { w, sent, reply } = frame()
  const list = w.webxdc.getMemberList()
  assert.deepEqual(sent, [{ webxdc: 'getMemberList', id: sent[0].id, origin: APP }])
  reply(sent[0].id, [['abc', 'Alice']])
  assert.deepEqual(await list, [['abc', 'Alice']])
})

test('sendToChat validates like upstream and posts base64', async () => {
  const { w, sent, reply } = frame()
  await assert.rejects(w.webxdc.sendToChat({}), /Invalid empty message/)
  await assert.rejects(w.webxdc.sendToChat({ file: { base64: 'eA==' } }), /file name is missing/)
  await assert.rejects(w.webxdc.sendToChat({ file: { name: 'a', base64: 'eA==', plainText: 'x' } }), /only set one/)
  const done = w.webxdc.sendToChat({ file: { name: 'a.txt', base64: 'eA==' }, text: 'hi' })
  await tick()
  assert.deepEqual(sent.at(-1).file, { file_name: 'a.txt', file_content: 'eA==' })
  assert.equal(sent.at(-1).text, 'hi')
  reply(sent.at(-1).id, undefined)
  await done
})

test('realtime: join advertises, send/receive bytes, leave', async () => {
  const { w, sent, from, parent } = frame()
  const rt = w.webxdc.joinRealtimeChannel()
  assert.equal(sent[0].webxdc, 'realtimeAdvertise')
  assert.throws(() => w.webxdc.joinRealtimeChannel(), /already exists/)
  const got: Uint8Array[] = []
  rt.setListener((d: Uint8Array) => got.push(d))
  from(parent, APP, { webxdc: 'realtime', data: new Uint8Array([7, 8]) })
  assert.deepEqual([...got[0]], [7, 8])
  assert.ok(got[0] instanceof Uint8Array)
  rt.send(new Uint8Array([1, 2]))
  assert.equal(sent[1].webxdc, 'realtimeSend')
  assert.deepEqual([...sent[1].data], [1, 2])
  assert.throws(() => rt.send([1, 2]), /Uint8Array/)
  rt.leave()
  assert.equal(sent[2].webxdc, 'realtimeLeave')
  assert.equal(rt.is_trashed(), true)
  assert.throws(() => rt.send(new Uint8Array([1])), /trashed/)
  from(parent, APP, { webxdc: 'realtime', data: new Uint8Array([9]) })
  assert.equal(got.length, 1, 'nothing arrives after leave')
  w.webxdc.joinRealtimeChannel() // a new one may be joined after leaving
})

test('a click inside the app asks to be raised', () => {
  const { sent, listeners } = frame()
  listeners.pointerdown.forEach(f => f({}))
  assert.deepEqual(sent, [{ webxdc: 'focus', origin: APP }])
})

test('the served source runs standalone, config strings stay strings', () => {
  const src = shimSource(cfg)
  const w: any = { parent: { postMessage() {} }, addEventListener() {} }
  new Function('window', src)(w)
  assert.equal(w.webxdc.selfName, cfg.selfName)
  assert.equal(w.webxdc.selfAddr, 'me@x')
})

test('links off the app origin go to the chat app, its own pages stay', () => {
  const { sent, listeners } = frame()
  const click = (href: string, defaultPrevented = false, download = false) => {
    const a = { href, hasAttribute: (n: string) => n === 'download' && download }
    const e = { target: { closest: () => a }, defaultPrevented, prevented: false, preventDefault() { this.prevented = true } }
    listeners.click.forEach(f => f(e))
    return e.prevented
  }
  assert.equal(click('mailto:bob@example.org'), true)
  assert.equal(click('https://example.org/?q=1'), true)
  assert.deepEqual(sent.map(m => m.url), ['mailto:bob@example.org', 'https://example.org/?q=1'])
  assert.equal(click('https://abcm1.webxdc.chat.example/page.html'), false, 'its own page')
  assert.equal(click('https://example.org/', true), false, 'the app handled it itself')
  assert.equal(click('data:text/plain,hi', false, true), false, 'a download stays the app\'s')
  assert.equal(click('javascript:void 0'), false, 'javascript: runs in the app')
  assert.equal(sent.length, 2)
})
