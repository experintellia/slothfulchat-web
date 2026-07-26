/**
 * Bridges the wasm transport to profiling + usage analytics.
 *
 * The frontend performs every core action as a JSON-RPC call through
 * transport.request(method, params). Wrapping that one method lets us derive —
 * with only a single onboarding-funnel hook in the frontend — both:
 *
 *   • Action profiling: interesting round-trips (account configure, send by
 *     kind, backup import/export, chat load) timed into perf.ts. Local only.
 *
 *   • Usage analytics: a closed set of events (analytics.EVENTS) describing
 *     *which options are used* — never message content, addresses, or params
 *     text. We look only at method names, a message's viewtype, a chat-list
 *     length, and coarse per-account facts (server kind, transport) probed via
 *     the same RPC API. Sends nothing unless analytics is enabled.
 *
 * Everything here is best-effort and must never break or slow a real RPC call.
 *
 * Onboarding RPC map (verified against deltachat-desktop ConfigureProgressDialog):
 *   - manual email login  → add_or_update_transport
 *   - default chatmail / scanned QR / webimap → add_transport_from_qr(id, qr)
 *   (bare `configure` / `add_transport` are never called by the frontend.)
 */
import * as perf from './perf'
import * as analytics from './analytics'

type Request = (method: string, params: unknown) => Promise<unknown>
type Transport = { request: Request }

// Accounts we've already counted a creation for this session (so re-saving
// transport settings — also add_or_update_transport — doesn't re-fire).
const createdAccounts = new Set<number>()
// Lazily-probed, non-identifying per-account send context: is it a chatmail
// server, and does it use the bridge-free webimap transport.
const sendCtx = new Map<number, { transport: string; chatmail: string }>()
const sendCtxPending = new Map<number, Promise<{ transport: string; chatmail: string }>>()

let qrScanSent = false // dedupe qr_scan, and mark "user scanned a code" this visit
const milestonesSent = new Set<string>() // in-memory first-line dedupe (storage may be blocked)

/** Wrap transport.request once. `raw` (the unwrapped bound original) is reused
 * for our own side probes so they are never re-observed or double-timed. */
export function observeTransport(transport: Transport): void {
  if ((transport as any).__scObserved) return
  ;(transport as any).__scObserved = true

  const raw: Request = transport.request.bind(transport)

  transport.request = (method: string, params: unknown) => {
    const p = raw(method, params)
    try {
      handle(method, params, p, raw)
    } catch {
      /* telemetry must never affect the call */
    }
    return p
  }
}

function handle(method: string, params: unknown, p: Promise<unknown>, raw: Request): void {
  const accountId = Array.isArray(params) && typeof params[0] === 'number' ? params[0] : undefined

  switch (method) {
    // manual login (addr + password) — the "Use webimap" advanced toggle makes
    // this a bridge-free madmail/webimap transport instead of ordinary IMAP
    case 'add_or_update_transport': {
      const webimap = /webimap/i.test(safeJson(params))
      onConfigure(accountId, webimap ? 'webimap' : 'imap', webimap ? 'webimap' : 'manual', p)
      break
    }

    // default chatmail relay / scanned QR / webimap — distinguished by the QR
    case 'add_transport_from_qr': {
      const qr = Array.isArray(params) ? String(params[1] ?? '') : ''
      const method2 = /webimap/i.test(qr) ? 'webimap' : qrScanSent ? 'qr' : 'chatmail'
      onConfigure(accountId, method2 === 'webimap' ? 'webimap' : 'imap', method2, p)
      break
    }

    case 'send_msg': {
      const type = viewtypeOf(params)
      timed(`send ${type}`, p)
      if (accountId != null) {
        ensureSendCtx(accountId, raw).then(ctx =>
          analytics.event('send', { type, transport: ctx.transport, chatmail: ctx.chatmail }),
        )
      }
      break
    }

    case 'check_qr':
    case 'set_config_from_qr':
    case 'secure_join':
      if (!qrScanSent) {
        qrScanSent = true
        analytics.event('qr_scan')
      }
      break

    // experimental admin groups (ArcaneChat port); the matching
    // 'setting_enabled' action fires from the settings toggle via
    // window.__slothfulTrack
    case 'create_group_with_admin':
      analytics.event('admin_group', { action: 'create' })
      break

    case 'export_backup':
      analytics.event('backup', { action: 'export' })
      timed('export backup', p)
      break
    case 'import_backup':
      analytics.event('backup', { action: 'import' })
      timed('import backup', p)
      break
    case 'export_self_keys':
      analytics.event('keys', { action: 'export' })
      break
    case 'import_self_keys':
      analytics.event('keys', { action: 'import' })
      break

    case 'get_message_list_items':
      timed('load chat', p)
      break

    case 'get_chatlist_entries':
      p.then(res => reportChatMilestones(res)).catch(() => {})
      break
  }
}

/** Handle an account configure attempt: time it, and (only the first time per
 * account this session, so a settings re-save doesn't re-fire) emit the
 * onboarding funnel + account_created events. */
function onConfigure(
  accountId: number | undefined,
  transport: string,
  method: string,
  p: Promise<unknown>,
): void {
  timed('configure account', p)
  const creation = accountId == null || !createdAccounts.has(accountId)
  if (!creation) return

  analytics.event('onboarding', { step: 'configuring', method })
  p.then(
    () => {
      if (accountId != null) {
        createdAccounts.add(accountId)
        sendCtx.set(accountId, { transport, chatmail: method === 'chatmail' ? 'yes' : 'no' })
      }
      analytics.event('account_created', { transport, method })
      analytics.event('onboarding', { step: 'success', method })
      perf.boot('first-account') // dedupes to the first account created this load
    },
    err => analytics.event('onboarding', { step: 'failed', method, reason: classifyError(err) }),
  )
}

/** Cache/probe the coarse send context for an account. Probes is_chatmail and
 * the transport list via the same RPC API, so returning users (configured in a
 * previous session) are labelled correctly too. Never sends any of the probed
 * data — only the derived yes/no + imap/webimap categories. */
function ensureSendCtx(accountId: number, raw: Request): Promise<{ transport: string; chatmail: string }> {
  const cached = sendCtx.get(accountId)
  if (cached) return Promise.resolve(cached)
  const pending = sendCtxPending.get(accountId)
  if (pending) return pending
  const probe = Promise.all([
    raw('get_config', [accountId, 'is_chatmail']).catch(() => ''),
    raw('list_transports', [accountId]).catch(() => []),
  ])
    .then(([isChatmail, transports]) => {
      const ctx = {
        chatmail: isChatmail === '1' ? 'yes' : 'no',
        transport: /webimap/i.test(safeJson(transports)) ? 'webimap' : 'imap',
      }
      sendCtx.set(accountId, ctx)
      return ctx
    })
    .catch(() => ({ transport: 'imap', chatmail: 'no' }))
  sendCtxPending.set(accountId, probe)
  return probe
}

// --- one-shot chat milestones ------------------------------------------------
// "first" is offset by one because onboarding always auto-creates (and selects)
// the Device Messages chat, so a fresh account already reports length 1.

const MILESTONE_KEY = 'slothfulchat.milestones'
function reportChatMilestones(result: unknown): void {
  const n = Array.isArray(result) ? result.length : 0
  if (n >= 2) sendMilestoneOnce('first') // >= 1 real chat beyond the device chat
  if (n > 11) sendMilestoneOnce('ten') // > 10 real chats beyond the device chat
}
function sendMilestoneOnce(milestone: 'first' | 'ten'): void {
  if (milestonesSent.has(milestone)) return // in-memory guard first (storage may throw)
  milestonesSent.add(milestone)
  try {
    const seen = new Set<string>(JSON.parse(localStorage.getItem(MILESTONE_KEY) || '[]'))
    if (seen.has(milestone)) return
    seen.add(milestone)
    localStorage.setItem(MILESTONE_KEY, JSON.stringify([...seen]))
  } catch {
    /* storage blocked: the in-memory guard still prevents a per-refresh flood */
  }
  analytics.event('chats', { milestone })
}

// --- helpers -----------------------------------------------------------------

function timed(label: string, p: Promise<unknown>): void {
  const start = performance.now()
  const done = () => perf.recordAction(label, performance.now() - start)
  p.then(done, done)
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? '')
  } catch {
    return ''
  }
}

/** Map a send_msg viewtype to a fixed, lowercase category. */
function viewtypeOf(params: unknown): string {
  const raw =
    Array.isArray(params) && params[2] && typeof params[2] === 'object'
      ? String((params[2] as any).viewtype ?? '')
      : ''
  switch (raw) {
    case 'Text':
      return 'text'
    case 'Image':
    case 'Gif':
      return 'image'
    case 'Voice':
      return 'voice'
    case 'Audio':
      return 'audio'
    case 'Video':
      return 'video'
    case 'Sticker':
      return 'sticker'
    case 'File':
      return 'file'
    default:
      return raw ? 'other' : 'text'
  }
}

/** Bucket a configure failure into a coarse reason (no message text is sent). */
function classifyError(err: unknown): string {
  const m = String((err as any)?.message ?? err ?? '').toLowerCase()
  if (/network|timeout|connect|dns|unreachable|offline|socket/.test(m)) return 'network'
  if (/auth|password|login|credential|certificate|tls/.test(m)) return 'auth'
  return 'other'
}
