// In-process mock "madmail" webimap server — the one every offline e2e script
// provisions its accounts against, so none of them touches the network.
//
// It speaks the subset of the madmail HTTP API the core's webimap transport
// uses:
//   POST   /new                     provision an account -> { email, password }
//   GET    /webimap/mailboxes       INBOX counts (hit during addTransportFromQr)
//   GET    /webimap/messages        metadata newer than ?since_uid, long-polling
//                                   up to ?wait seconds for delivery
//   GET    /webimap/message/<uid>   one message, with its raw body
//   DELETE /webimap/message/<uid>   delete-after-receive
//   POST   /webimap/send            deliver to any local recipient, waking
//                                   whatever long-polls are parked on them
// Everything under /webimap/ requires the X-Email / X-Password headers from
// /new. CORS is permissive on every response, including the preflight the
// browser sends for those custom auth headers.
//
// Five scripts each carried their own copy of this, drifted by small amounts
// (see `probes` below for the one difference that was load-bearing). The two
// that remain inline — test-link-preview-e2e.mjs and test-sidebar-resize-e2e.mjs
// — are deliberately NOT this server: their accounts never receive mail and
// they answer polls instantly, where this one parks the request for `wait`
// seconds. That is correct madmail behaviour but the wrong shape for a test
// about something else entirely.
//
// Self-check: node --test scripts/mock-madmail.test.mjs
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const readBody = req =>
  new Promise(resolve => {
    let b = ''
    req.on('data', c => (b += c))
    req.on('end', () => resolve(b))
  })

const json = (res, code, obj) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(obj))
}

// metadata shape the transport expects (body only on the single-message route)
const meta = (uid, raw) => ({
  uid,
  seq_num: uid,
  flags: [],
  size: Buffer.byteLength(raw),
  date: new Date().toISOString(),
  envelope: {},
})

/**
 * Start the server on an ephemeral port, bound to loopback.
 *
 * @param {object}  [options]
 * @param {boolean} [options.probes] Serve the two 404-tolerance shapes the
 *   core must survive rather than back off from (see the core patch "webimap:
 *   treat 404 on GET/DELETE as already-gone"): a phantom UID listed once but
 *   already gone on GET, and one DELETE answered 404 even though the message
 *   really is deleted. Only test-webimap.mjs — which exists to test the
 *   transport itself — turns these on; for every other caller they would be
 *   noise in a test about something else.
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   port: number,
 *   users: Map<string, object>,
 *   counters: { newCalls: number, sendCalls: number, deleteCalls: number,
 *               phantom404Gets: number, delete404s: number },
 *   close: () => void,
 * }>}
 */
export async function startMockMadmail({ probes = false } = {}) {
  const users = new Map()
  // phantom404Gets / delete404s only ever move when `probes` is on; they are
  // what test-webimap.mjs asserts the core actually walked into both shapes.
  const counters = {
    newCalls: 0,
    sendCalls: 0,
    deleteCalls: 0,
    phantom404Gets: 0,
    delete404s: 0,
  }
  let userSeq = 0

  const respondMessages = (res, user, sinceUid) => {
    const out = []
    if (user.phantomOnce !== undefined) {
      out.push(meta(user.phantomOnce, ''))
      user.phantomOnce = undefined
    }
    for (const [uid, raw] of user.msgs) if (uid > sinceUid) out.push(meta(uid, raw))
    json(res, 200, out)
  }

  const server = createServer(async (req, res) => {
    // CORS on EVERY response — the browser preflights the custom auth headers.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'X-Email, X-Password, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return void res.end()
    }

    const url = new URL(req.url, 'http://mock')
    const path = url.pathname

    if (req.method === 'POST' && path === '/new') {
      counters.newCalls++
      const email = `u${++userSeq}@webimap.example`
      const password = randomBytes(9).toString('hex')
      users.set(email, {
        password,
        // uid 1 is the phantom when probing, so real mail starts at 2
        nextUid: probes ? 2 : 1,
        msgs: new Map(),
        waiters: [],
        ...(probes ? { phantomOnce: 1, delete404Once: true } : {}),
      })
      return void json(res, 200, { email, password, dclogin_url: '' })
    }

    if (path.startsWith('/webimap/')) {
      const email = req.headers['x-email']
      const user = email && users.get(email)
      if (!user || user.password !== req.headers['x-password']) {
        return void json(res, 401, { error: 'bad credentials' })
      }

      if (req.method === 'GET' && path === '/webimap/mailboxes') {
        const n = user.msgs.size
        return void json(res, 200, [{ name: 'INBOX', messages: n, unseen: n }])
      }

      if (req.method === 'GET' && path === '/webimap/messages') {
        const sinceUid = Number(url.searchParams.get('since_uid') ?? '0') || 0
        const wait = Math.min(Number(url.searchParams.get('wait') ?? '0') || 0, 120)
        const hasNew =
          user.phantomOnce !== undefined || [...user.msgs.keys()].some(uid => uid > sinceUid)
        if (hasNew || wait <= 0) return void respondMessages(res, user, sinceUid)
        // park the request until /send wakes it or `wait` elapses
        const waiter = {
          timer: setTimeout(() => {
            user.waiters = user.waiters.filter(w => w !== waiter)
            respondMessages(res, user, sinceUid)
          }, wait * 1000),
          respond: () => respondMessages(res, user, sinceUid),
          // close() uses this to finish the exchange rather than abandon it
          res,
        }
        user.waiters.push(waiter)
        return
      }

      const m = path.match(/^\/webimap\/message\/(\d+)$/)
      if (m) {
        const uid = Number(m[1])
        if (req.method === 'GET') {
          const raw = user.msgs.get(uid)
          // a phantom uid was advertised but never stored -> 404, on purpose
          if (raw === undefined) {
            counters.phantom404Gets++
            return void json(res, 404, { error: 'no such message' })
          }
          return void json(res, 200, { ...meta(uid, raw), body: raw })
        }
        if (req.method === 'DELETE') {
          counters.deleteCalls++
          user.msgs.delete(uid)
          if (user.delete404Once) {
            // deleted for real, but answered 404 — the late-landing-delete shape
            user.delete404Once = false
            counters.delete404s++
            return void json(res, 404, { error: 'no such message' })
          }
          return void json(res, 200, { status: 'ok' })
        }
      }

      if (req.method === 'POST' && path === '/webimap/send') {
        counters.sendCalls++
        let payload = {}
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          /* keep {} — a malformed body delivers to nobody */
        }
        const recipients = []
          .concat(payload.to ?? [])
          .flatMap(r => (typeof r === 'string' ? r.split(/[,\s]+/) : []))
          .map(r => r.trim())
          .filter(Boolean)
        for (const rcpt of recipients) {
          const dest = users.get(rcpt)
          if (!dest) continue
          dest.msgs.set(dest.nextUid++, payload.body ?? '')
          const waiters = dest.waiters
          dest.waiters = []
          for (const w of waiters) {
            clearTimeout(w.timer)
            w.respond()
          }
        }
        return void json(res, 200, { status: 'sent' })
      }
    }

    json(res, 404, { error: 'not found' })
  })

  await new Promise(r => server.listen(0, '127.0.0.1', r))

  return {
    server,
    port: server.address().port,
    users,
    counters,
    // Answer every parked long-poll before closing. server.close() stops new
    // connections but waits for open ones, so a poll left hanging would keep
    // both the 120s timer and its socket alive and the process would never
    // exit. Replying empty is what the caller would have got on timeout.
    close() {
      for (const user of users.values()) {
        const waiters = user.waiters
        user.waiters = []
        for (const w of waiters) {
          clearTimeout(w.timer)
          json(w.res, 200, [])
        }
      }
      server.close()
    },
  }
}
