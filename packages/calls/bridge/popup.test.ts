import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CALL_POPUP_PROTOCOL,
  PopupRpcClient,
  parsePopupMessage,
  servePopupRpc,
  type CallPopupInit,
  type PopupMessage,
  type SignalingPort,
} from './popup-signaling.ts'
import { connectCallPopup } from './popup-client.ts'
import { CallPopupHost } from './popup-host.ts'
import type { CallsRpcClient } from './index.ts'

// ── Test doubles ──────────────────────────────────────────────────────────────

/** A synchronous in-memory pair of SignalingPorts (stands in for the two
 * same-origin windows' postMessage transport). `a.post` delivers to `b`'s
 * handlers and vice versa — the exact objects, already "parsed". */
function createPortPair(): [SignalingPort, SignalingPort] {
  const aHandlers = new Set<(m: PopupMessage) => void>()
  const bHandlers = new Set<(m: PopupMessage) => void>()
  let openA = true
  let openB = true
  const a: SignalingPort = {
    post(m) {
      if (openB) for (const h of [...bHandlers]) h(m)
    },
    onMessage(h) {
      aHandlers.add(h)
      return () => aHandlers.delete(h)
    },
    close() {
      openA = false
      aHandlers.clear()
    },
  }
  const b: SignalingPort = {
    post(m) {
      if (openA) for (const h of [...aHandlers]) h(m)
    },
    onMessage(h) {
      bHandlers.add(h)
      return () => bHandlers.delete(h)
    },
    close() {
      openB = false
      bHandlers.clear()
    },
  }
  return [a, b]
}

/** A minimal fake CallsRpcClient recording calls, with configurable results. */
function fakeRpc(overrides: Partial<CallsRpcClient> = {}): {
  rpc: CallsRpcClient
  calls: { method: string; args: unknown[] }[]
} {
  const calls: { method: string; args: unknown[] }[] = []
  const rpc: CallsRpcClient = {
    placeOutgoingCall: async (a, c, info, v) => {
      calls.push({ method: 'placeOutgoingCall', args: [a, c, info, v] })
      return 4242
    },
    acceptIncomingCall: async (a, m, info) => {
      calls.push({ method: 'acceptIncomingCall', args: [a, m, info] })
    },
    endCall: async (a, m) => {
      calls.push({ method: 'endCall', args: [a, m] })
    },
    iceServers: async a => {
      calls.push({ method: 'iceServers', args: [a] })
      return '[]'
    },
    callInfo: async (a, m) => {
      calls.push({ method: 'callInfo', args: [a, m] })
      return { sdpOffer: '', hasVideo: false, state: { kind: 'Missed' } }
    },
    ...overrides,
  }
  return { rpc, calls }
}

function fakeWindow(): Window & { close: () => void; closed: boolean } {
  let closed = false
  return {
    get closed() {
      return closed
    },
    close() {
      closed = true
    },
    // Not used — the host is given an injected createPort in these tests.
  } as unknown as Window & { close: () => void; closed: boolean }
}

const OUTGOING_INIT: CallPopupInit = {
  direction: 'outgoing',
  accountId: 1,
  chatId: 7,
  hasVideo: false,
  callMessageId: null,
  offerSdp: null,
  title: 'Alice',
}

// ── parsePopupMessage ─────────────────────────────────────────────────────────

test('parsePopupMessage rejects foreign / malformed values', () => {
  assert.equal(parsePopupMessage(null), null)
  assert.equal(parsePopupMessage('hello'), null)
  assert.equal(parsePopupMessage({ kind: 'ready' }), null, 'missing protocol tag')
  assert.equal(
    parsePopupMessage({ protocol: 'other', kind: 'ready' }),
    null,
    'wrong protocol tag'
  )
  assert.equal(
    parsePopupMessage({ protocol: CALL_POPUP_PROTOCOL, kind: 'rpc', id: 'x', method: 'endCall', args: [] }),
    null,
    'rpc needs a numeric id'
  )
  assert.equal(
    parsePopupMessage({ protocol: CALL_POPUP_PROTOCOL, kind: 'rpc-result', id: 1 }),
    null,
    'rpc-result needs a boolean ok'
  )
})

test('parsePopupMessage accepts well-formed protocol messages', () => {
  const ready = { protocol: CALL_POPUP_PROTOCOL, kind: 'ready' }
  assert.deepEqual(parsePopupMessage(ready), ready)
  const rpc = { protocol: CALL_POPUP_PROTOCOL, kind: 'rpc', id: 2, method: 'iceServers', args: [1] }
  assert.deepEqual(parsePopupMessage(rpc), rpc)
})

// ── RPC relay roundtrip ───────────────────────────────────────────────────────

test('PopupRpcClient relays calls to servePopupRpc and back', async () => {
  const [opener, popup] = createPortPair()
  const { rpc, calls } = fakeRpc()
  const captured: number[] = []
  servePopupRpc(opener, rpc, { onCallMessageId: id => captured.push(id) })
  const client = new PopupRpcClient(popup)

  const msgId = await client.placeOutgoingCall(1, 7, 'SDP-OFFER', true)
  assert.equal(msgId, 4242)
  assert.deepEqual(calls[0], { method: 'placeOutgoingCall', args: [1, 7, 'SDP-OFFER', true] })
  assert.deepEqual(captured, [4242], 'onCallMessageId fires for placeOutgoingCall')

  assert.equal(await client.iceServers(1), '[]')
  await client.acceptIncomingCall(1, 9, 'SDP-ANSWER')
  assert.deepEqual(calls[2], { method: 'acceptIncomingCall', args: [1, 9, 'SDP-ANSWER'] })
})

test('PopupRpcClient rejects when the relayed call throws on the opener', async () => {
  const [opener, popup] = createPortPair()
  const { rpc } = fakeRpc({
    endCall: async () => {
      throw new Error('core is down')
    },
  })
  servePopupRpc(opener, rpc)
  const client = new PopupRpcClient(popup)
  await assert.rejects(() => client.endCall(1, 2), /core is down/)
})

test('PopupRpcClient.dispose rejects in-flight calls', async () => {
  const [, popup] = createPortPair() // no server → never answers
  const client = new PopupRpcClient(popup)
  const pending = client.placeOutgoingCall(1, 2, 'x', false)
  client.dispose()
  await assert.rejects(() => pending, /relay closed/)
  await assert.rejects(() => client.iceServers(1), /relay closed/)
})

// ── Full host ⇄ client handshake + event forwarding ───────────────────────────

test('host handshake hands over init; core events reach the popup', async () => {
  const [opener, popup] = createPortPair()
  const { rpc } = fakeRpc()

  let ready = false
  let ended = false
  let endedReachedConnected: boolean | null = null
  const host = new CallPopupHost(fakeWindow(), OUTGOING_INIT, {
    rpc,
    createPort: () => opener,
    onReady: () => {
      ready = true
    },
    onEnded: reachedConnected => {
      ended = true
      endedReachedConnected = reachedConnected
    },
  })

  const connection = connectCallPopup(popup)
  const init = await connection.init
  assert.equal(ready, true, 'host.onReady fired on handshake')
  assert.deepEqual(init, OUTGOING_INIT, 'popup received the init payload')

  const events: string[] = []
  connection.onEvent(e => events.push(e.type))
  host.forwardAnswer('SDP-ANSWER')
  host.forwardRemoteEnded()
  assert.deepEqual(events, ['answer', 'remote-ended'])

  // A clean popup-side end reaches the host's onEnded, carrying whether the
  // popup's engine ever reached `connected` (M5 call-outcome analytics).
  connection.reportEnded(true)
  assert.equal(ended, true)
  assert.equal(endedReachedConnected, true)
})

test('onEnded defaults reachedConnected to false when the popup omits it', async () => {
  const [opener, popup] = createPortPair()
  let endedReachedConnected: boolean | null = null
  const host = new CallPopupHost(fakeWindow(), OUTGOING_INIT, {
    rpc: fakeRpc().rpc,
    createPort: () => opener,
    onEnded: reachedConnected => {
      endedReachedConnected = reachedConnected
    },
  })
  const connection = connectCallPopup(popup)
  await connection.init
  connection.reportEnded() // no argument — the conservative "unknown" default
  assert.equal(endedReachedConnected, false)
  void host
})

test('answer event carries the accept_call_info payload', async () => {
  const [opener, popup] = createPortPair()
  const host = new CallPopupHost(fakeWindow(), OUTGOING_INIT, {
    rpc: fakeRpc().rpc,
    createPort: () => opener,
  })
  const connection = connectCallPopup(popup)
  await connection.init
  let received: string | null = null
  connection.onEvent(e => {
    if (e.type === 'answer') received = e.acceptCallInfo
  })
  host.forwardAnswer('THE-ANSWER-SDP')
  assert.equal(received, 'THE-ANSWER-SDP')
  host.close() // stop the closed-poll interval so the test process can exit
})

// ── Fallback (handshake timeout) ──────────────────────────────────────────────

test('host falls back and closes the window if the popup never handshakes', async () => {
  const [opener] = createPortPair() // popup side never connects
  const win = fakeWindow()
  let fallbackReason: string | null = null
  new CallPopupHost(win, OUTGOING_INIT, {
    rpc: fakeRpc().rpc,
    createPort: () => opener,
    readyTimeoutMs: 10,
    onFallback: reason => {
      fallbackReason = reason
    },
  })
  await new Promise(r => setTimeout(r, 40))
  assert.equal(fallbackReason, 'handshake-timeout')
  assert.equal(win.closed, true, 'blank popup window was closed on fallback')
})

// ── Abrupt close safety net (endCall) ─────────────────────────────────────────

const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

test('an abrupt popup close sends endCall for the tracked message id', async () => {
  const [opener, popup] = createPortPair()
  const { rpc, calls } = fakeRpc()
  const incomingInit: CallPopupInit = {
    direction: 'incoming',
    accountId: 3,
    chatId: 8,
    hasVideo: false,
    callMessageId: 555,
    offerSdp: 'OFFER',
    title: 'Bob',
  }
  let ended = false
  const win = fakeWindow()
  const host = new CallPopupHost(win, incomingInit, {
    rpc,
    createPort: () => opener,
    closedPollMs: 5, // short real interval — no faked clock (see popup-host.ts)
    onEnded: () => {
      ended = true
    },
  })
  connectCallPopup(popup) // synchronous handshake
  assert.equal(host.isReady, true)

  // User closes the window abruptly (no clean `ended`).
  win.close()
  await tick(20) // let the closed-poll trip
  assert.deepEqual(calls.at(-1), { method: 'endCall', args: [3, 555] }, 'safety-net endCall sent')
  assert.equal(ended, true)
})

test('a remote CallEnded does NOT trigger the abrupt-close safety net', async () => {
  const [opener, popup] = createPortPair()
  const { rpc, calls } = fakeRpc()
  const win = fakeWindow()
  const host = new CallPopupHost(win, { ...OUTGOING_INIT, callMessageId: 77 }, {
    rpc,
    createPort: () => opener,
    closedPollMs: 5,
  })
  connectCallPopup(popup)
  host.forwardRemoteEnded() // marks endedCleanly
  win.close()
  await tick(20)
  assert.equal(
    calls.some(c => c.method === 'endCall'),
    false,
    'no endCall — the remote already tore the call down'
  )
})
