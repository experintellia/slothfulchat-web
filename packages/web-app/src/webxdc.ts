/**
 * Running webxdc apps (WEBXDC.md, issue #2) — the app-side half. The other
 * half lives on the app's own origin, `<slug>.webxdc.<app-host>`
 * (webxdc-host.ts + webxdc-sw.ts), and knows nothing about webxdc.
 *
 * Opening an app: read the .xdc from the core's memfs, unzip it, add our
 * webxdc.js (webxdc-shim.ts), frame the origin's bootstrap page and post the
 * files in. From then on the frame is the app, and its webxdc.js talks to us
 * over postMessage — answered here against the core, exactly what Electron's
 * main process does over IPC (target-electron webxdc.ts). Each instance
 * (account + message) gets its own origin, so the browser's same-origin policy
 * walls apps off from the chat app and from each other; the frame's sandbox
 * and the CSP its service worker puts on every response keep it off the
 * network.
 *
 * Where the frame lives: on a desktop, in a browser window of its own —
 * static/webxdc-window.html, same origin as this page, which we fill from here
 * (an installed PWA opens it as an app window, a browser as a popup). On a
 * phone or tablet, or when the browser refuses the window, in a window
 * floating in this page (full screen on a phone, where the back gesture
 * closes it). Either way it is this page that talks to the app.
 */
import { unzipSync } from 'fflate'
import type { Core, T } from '@slothfulchat/core-wasm'
import { XDC_FRAME_CSS, el, overlayCard, scButton, showOnTop } from './ui-shared'
import { appEntry, xdcOrigin, xdcPath, xdcSlug } from './webxdc-origin.ts'
import { shimSource } from './webxdc-shim.ts'

type Log = { warn(...a: unknown[]): void; error(...a: unknown[]): void }
type SendToChat = (
  file: { file_name: string; file_content: string } | null,
  text: string | null,
  accountId: number
) => void
export type OpenParams = {
  accountId: number
  displayname: string | null
  chatName: string
  webxdcInfo: T.WebxdcMessageInfo
  href: string
}
type App = {
  accountId: number
  msgId: number
  origin: string
  /** carries the loading/failed state: the floating window, or the app window's body */
  win: HTMLElement
  frame: HTMLIFrameElement
  /** the app's own browser window, if it got one */
  popup: Window | null
  /** where it starts: an info message's href, or its start page */
  href: string
  /** handed over and loaded — from now on a new href navigates the frame */
  live: boolean
  realtime: boolean
  /** requests to the core not yet answered */
  busy: number
}
type Deps = {
  getCore: () => Core
  log: Log
  iconURL: (accountId: number, msgId: number) => string
  sendToChat: SendToChat
  /** false in a throwaway (?persist=0) session — see `record` */
  persist: boolean
  /** the "warn before opening webxdc apps" setting */
  warn: () => Promise<boolean>
  /** a link an app handed out: mailto:, invites, web links (runtime openAppLink) */
  openLink: (url: string, accountId: number) => void
}

const RECORD_KEY = 'slothfulchat.webxdcOrigins'
/** account config key holding that account's slug salt (see xdcSlug) */
const SALT_KEY = 'ui.slothfulchat.webxdc_salt'
/** Unpacked size a .xdc may declare. fflate allocates each entry's declared
 * size up front and never grows past it, so this bounds what a zip bomb from a
 * chat partner can take — synchronously, on this thread. */
const MAX_UNPACKED = 256 * 1024 * 1024
/** what core accepts per realtime message (peer_channels.rs) */
const MAX_REALTIME = 128 * 1024
/** requests one app may have waiting on the core: enough for any honest app
 * (they await their calls), a ceiling for one that loops on the bridge */
const MAX_BUSY = 64
const WINDOW_PAGE = 'webxdc-window.html'
const SELFHOSTING_WEBXDC_URL =
  'https://github.com/experintellia/slothfulchat-web/blob/main/SELFHOSTING.md#optional-webxdc-apps'
/** the app window's page has no styles of its own: these */
const WINDOW_CSS = `html,body{margin:0;height:100%;background:#1e1e1e}
body{display:flex;flex-direction:column;font:13px/1.4 system-ui,sans-serif}
${XDC_FRAME_CSS}`

// main.html's static frame-src has to admit any https: frame — the app host is
// not known at build time, and the same build runs on many. This second
// policy narrows it to exactly this host's webxdc origins and the one page of
// ours that is ever framed, the HTML-mail viewer (policies intersect, so it
// can only ever take away). It is also what stops an app from navigating its
// own frame elsewhere: the parent's frame-src governs every navigation of the
// frame, not just the first — so not 'self' either, under which an app could
// send any GET to this origin (a server-side endpoint, a page of ours that
// isn't the app) with data in the URL. An app window gets the same, before its
// frame exists.
function pinFrameSrc(doc: Document) {
  const csp = doc.createElement('meta')
  csp.httpEquiv = 'Content-Security-Policy'
  // no blob: — an app could turn its own frame into a page it wrote, one
  // without the guard its service worker puts first in every page
  const mail = new URL('html-email.html', location.href)
  csp.content = `frame-src ${mail.origin}${mail.pathname} ${location.protocol}//*.webxdc.${location.host}`
  doc.head.append(csp)
}
pinFrameSrc(document)

/** Desktop browsers get app windows. Not iOS (and not touch-first Android,
 * whose pointer is coarse): there, window.open hands the page to an in-app
 * browser that is no window of ours. */
const windowed = () =>
  matchMedia('(pointer: fine)').matches &&
  !(/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
/** Electron's window title (makeTitle in target-electron webxdc.ts). */
const titleOf = (info: T.WebxdcMessageInfo, chatName: string) =>
  `${info.document ? truncate(info.document, 32) + ' - ' : ''}${truncate(info.name, 42)} – ${chatName}`

class NotServed extends Error {}

/** Resolves once the bootstrap page on `origin` has said hello AND finished
 * loading — so the frame's next load event is whatever it navigates to. A
 * frame that loads without a hello is not ours — no DNS for the wildcard, no
 * Caddy route, a plain static host — and that is how "webxdc is not served
 * here" shows. Listens where the frame lives: this page or an app window. */
function hostReady(frame: HTMLIFrameElement, origin: string): Promise<void> {
  const w = frame.ownerDocument.defaultView!
  return new Promise((resolve, reject) => {
    let hello = false
    let loaded = false
    const fail = () => (cleanup(), reject(new NotServed()))
    const done = () => hello && loaded && (cleanup(), resolve())
    let timer = setTimeout(fail, 20_000)
    // its hello is posted before its load event; grace for delivery order
    const onLoad = () => {
      loaded = true
      clearTimeout(timer)
      timer = setTimeout(fail, 3000)
      done()
    }
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== origin) return
      if (e.data?.type === 'hello') (hello = true), done()
    }
    const cleanup = () => {
      clearTimeout(timer)
      frame.removeEventListener('load', onLoad)
      w.removeEventListener('message', onMsg)
    }
    frame.addEventListener('load', onLoad, { once: true })
    w.addEventListener('message', onMsg)
  })
}

/** Next message of `type` from the bootstrap page; its 'error' rejects. */
function fromHost(frame: HTMLIFrameElement, origin: string, type: string, ms: number): Promise<void> {
  const w = frame.ownerDocument.defaultView!
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (cleanup(), reject(new Error(`no ${type} from ${origin}`))), ms)
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== origin) return
      if (e.data?.type === type) cleanup(), resolve()
      else if (e.data?.type === 'error') cleanup(), reject(new Error(e.data.message))
    }
    const cleanup = () => (clearTimeout(timer), w.removeEventListener('message', onMsg))
    w.addEventListener('message', onMsg)
  })
}

/** The app's sandboxed frame, created in the document it will live in. */
function appFrame(doc: Document, origin: string, name: string): HTMLIFrameElement {
  const frame = doc.createElement('iframe')
  frame.className = 'sc-xdc-frame'
  // no allow-popups / allow-top-navigation*: the app can open nothing and
  // move nothing but its own frame (and the frame-src pin limits that)
  frame.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock'
  )
  frame.allow = 'fullscreen'
  frame.referrerPolicy = 'no-referrer'
  frame.title = name
  frame.src = `${origin}/webxdc-host.html`
  return frame
}

/** Our page in `w`, once it has loaded — or null if it never does (blocked,
 * closed, or the browser put something else there). */
function windowPage(w: Window): Promise<Document | null> {
  const t0 = Date.now()
  return new Promise(resolve => {
    const tick = () => {
      try {
        if (w.closed) return resolve(null)
        const doc = w.document
        if (doc.readyState === 'complete' && w.location.pathname.endsWith(`/${WINDOW_PAGE}`)) return resolve(doc)
      } catch {}
      if (Date.now() - t0 > 5000) return resolve(null)
      setTimeout(tick, 30)
    }
    tick()
  })
}

export class WebxdcManager {
  private apps = new Map<string, App>()
  private opening = new Set<string>()
  private salts = new Map<number, Promise<string>>()
  private top = 1000
  /** origin -> [accountId, msgId] of every app this device ran, so its
   * storage can be wiped when the message or account goes. Kept in memory
   * only for a throwaway session: its account ids restart at 1, and wiping
   * by such an id would hit the real profile's apps. */
  private record: Record<string, [number, number]>
  private wipes = Promise.resolve()
  /** keys of floating apps that own a history entry, oldest first */
  private back: string[] = []
  /** apps closed a moment ago, by origin: see onAppMessage */
  private closed = new Map<string, App>()
  private d: Deps

  constructor(deps: Deps) {
    this.d = deps
    let saved = {}
    try {
      if (deps.persist) saved = JSON.parse(localStorage.getItem(RECORD_KEY) || '{}')
    } catch {}
    this.record = saved
    addEventListener('message', this.onAppMessage)
    // a click inside an app frame never reaches this document — but focus
    // leaving it for the frame does, and that is the moment to raise it
    // (apps that load our webxdc.js also say so themselves: 'focus')
    addEventListener('blur', () =>
      setTimeout(() => {
        for (const app of this.apps.values()) if (document.activeElement === app.frame) this.raise(app)
      })
    )
    // the back gesture closes the newest floating app (see mount)
    addEventListener('popstate', () => {
      const current = history.state?.webxdc
      while (this.back.length && this.back.at(-1) !== current) this.close(this.back.pop()!)
    })
    // app windows talk to this page only: they go with it
    addEventListener('pagehide', () => this.closeAll())
  }

  private get rpc() {
    return this.d.getCore().dc.rpc
  }
  private save() {
    if (!this.d.persist) return
    try {
      localStorage.setItem(RECORD_KEY, JSON.stringify(this.record))
    } catch {}
  }

  /** The account's random slug prefix, created on first use. One promise per
   * account, so two apps opened at once can't each mint (and store) one. */
  private salt(accountId: number): Promise<string> {
    let p = this.salts.get(accountId)
    if (!p) {
      p = (async () => {
        const have = await this.rpc.getConfig(accountId, SALT_KEY)
        if (have && /^[a-z0-9]{10,40}$/.test(have)) return have
        const salt = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join('')
        await this.rpc.setConfig(accountId, SALT_KEY, salt)
        return salt
      })()
      this.salts.set(accountId, p)
      p.catch(() => this.salts.delete(accountId))
    }
    return p
  }

  async open(msgId: number, p: OpenParams): Promise<void> {
    const key = `${p.accountId}.${msgId}`
    const existing = this.apps.get(key)
    if (existing?.popup?.closed) this.close(key)
    else if (existing) {
      this.raise(existing)
      // an info message's href: show that place in the app — once it runs;
      // until then it is where the app will start
      if (p.href) {
        existing.href = p.href
        if (existing.live) existing.frame.src = existing.origin + appEntry(p.href)
      }
      return
    }
    if (this.opening.has(key)) return
    this.opening.add(key)
    let app: App
    try {
      const origin = xdcOrigin(location, xdcSlug(await this.salt(p.accountId), msgId))
      // the first start of each app on this device, unless switched off
      if (!this.record[origin] && (await this.d.warn()) && !(await confirmRisk())) return
      app = await this.mount(key, p, msgId, origin)
    } catch (err) {
      return this.d.log.error('opening webxdc failed', err)
    } finally {
      this.opening.delete(key)
    }
    // closed while still starting (by the user, an account switch, a deleted
    // message): then nothing below may touch it, nor speak up
    const gone = () => this.apps.get(key) !== app
    // listen from the start: the frame loads while we unzip, and a cached
    // bootstrap page can say hello before files() is done
    const ready = hostReady(app.frame, app.origin)
    ready.catch(() => {})
    try {
      const files = await this.files(p, msgId)
      await ready
      if (gone()) return
      this.record[app.origin] = [p.accountId, msgId]
      this.save()
      const entry = app.href
      // the next load is the app itself, served by the origin's SW (a
      // failure to get there arrives as an 'error' message: onAppMessage)
      app.frame.addEventListener(
        'load',
        () => {
          app.win.classList.remove('sc-xdc-loading')
          app.live = true
          if (app.href !== entry) app.frame.src = app.origin + appEntry(app.href)
        },
        { once: true }
      )
      app.frame.contentWindow!.postMessage(
        { type: 'open', files, entry: appEntry(entry) },
        app.origin,
        files.map(f => f[1])
      )
    } catch (err) {
      if (gone()) return
      if (!(err instanceof NotServed)) return this.fail(app, err instanceof Error ? err.message : String(err))
      this.close(key)
      showNotServedDialog()
    }
  }

  /** The archive's files plus our webxdc.js, ready to transfer. */
  private async files(p: OpenParams, msgId: number): Promise<[string, ArrayBuffer][]> {
    const { file } = await this.rpc.getMessage(p.accountId, msgId)
    if (!file) throw new Error(`webxdc message ${msgId} has no file`)
    const info = p.webxdcInfo
    const shim = shimSource({
      parentOrigin: location.origin,
      selfAddr: info.selfAddr || 'unknown@unknown',
      selfName: p.displayname || info.selfAddr || 'unknown',
      sendUpdateInterval: info.sendUpdateInterval,
      sendUpdateMaxSize: info.sendUpdateMaxSize,
      isAppSender: info.isAppSender,
      isBroadcast: info.isBroadcast,
    })
    let total = 0
    const entries = unzipSync(await this.d.getCore().fsRead(file), {
      filter: f => {
        total += f.originalSize
        if (total > MAX_UNPACKED) throw new Error('it is larger than 256 MB unpacked')
        // ours replaces the archive's, under every spelling of the name
        return !f.name.endsWith('/') && xdcPath(f.name, false) !== 'webxdc.js'
      },
    })
    entries['webxdc.js'] = new TextEncoder().encode(shim)
    // slice(): a stored (uncompressed) entry is a view into the whole archive,
    // and each needs a buffer of its own to be transferred
    return Object.entries(entries).map(([name, data]) => [name, data.slice().buffer as ArrayBuffer])
  }

  /** An app window on a desktop, else a floating one; loading until handover. */
  private async mount(key: string, p: OpenParams, msgId: number, origin: string): Promise<App> {
    const title = titleOf(p.webxdcInfo, p.chatName)
    const icon = new URL(this.d.iconURL(p.accountId, msgId), location.href).href
    const status = el('div', 'sc-xdc-status', 'Loading…')
    const base = { accountId: p.accountId, msgId, origin, href: p.href, live: false, realtime: false, busy: 0 }

    // the browser grants a popup in a click's wake; where that has run out
    // (Safari, after our awaits) it refuses one, and the app floats instead
    const popup = windowed() ? window.open(WINDOW_PAGE, `webxdc-${key}`, 'popup,width=375,height=667') : null
    const doc = popup && (await windowPage(popup))
    if (popup && doc) {
      pinFrameSrc(doc)
      doc.head.append(Object.assign(doc.createElement('style'), { textContent: WINDOW_CSS }))
      doc.head.append(Object.assign(doc.createElement('link'), { rel: 'icon', href: icon }))
      doc.title = title
      doc.body.className = 'sc-xdc-loading'
      const frame = appFrame(doc, origin, p.webxdcInfo.name)
      doc.body.append(el('div', 'sc-xdc-body', [frame, status]))
      const app: App = { ...base, win: doc.body, frame, popup }
      // the app's requests arrive where its frame lives
      popup.addEventListener('message', this.onAppMessage)
      // closed by the user (or reloaded: that closes it too — start it again)
      popup.addEventListener('pagehide', () => this.close(key))
      this.apps.set(key, app)
      popup.focus()
      return app
    }
    popup?.close()

    const win = el('section', 'sc-xdc sc-xdc-loading')
    win.setAttribute('role', 'dialog')
    win.setAttribute('aria-label', p.webxdcInfo.name)
    const n = this.apps.size
    const w = Math.min(375, innerWidth - 16)
    const h = Math.min(667, innerHeight - 16)
    Object.assign(win.style, {
      width: `${w}px`,
      height: `${h}px`,
      // side by side while there is room, then stacked at the left edge
      left: `${Math.max(8, innerWidth - w - 24 - (w + 16) * n)}px`,
      top: `${Math.min(innerHeight - h - 8, 24 + 28 * n)}px`,
    })
    const img = el('img', 'sc-xdc-icon')
    img.src = icon
    img.alt = ''
    const close = el('button', 'sc-xdc-btn', '✕')
    close.title = close.ariaLabel = 'Close'
    close.onclick = () => this.close(key)
    const bar = el('header', 'sc-xdc-bar', [img, el('span', 'sc-xdc-title', title), close])
    const frame = appFrame(document, origin, p.webxdcInfo.name)
    win.append(bar, el('div', 'sc-xdc-body', [frame, status]))
    const app: App = { ...base, win, frame, popup: null }
    dragBy(bar, win)
    win.addEventListener('pointerdown', () => this.raise(app), true)
    this.apps.set(key, app)
    this.raise(app)
    document.body.append(win)
    // a history entry of its own, so the back gesture (Android, the browser's
    // back button) closes the app rather than leaving the chat
    history.pushState({ ...history.state, webxdc: key }, '')
    this.back.push(key)
    return app
  }

  private raise(app: App) {
    if (app.popup) app.popup.focus()
    else app.win.style.zIndex = String(++this.top)
  }

  private fail(app: App, message: string) {
    this.d.log.error('webxdc app failed to start', message)
    app.win.classList.add('sc-xdc-failed')
    app.win.querySelector('.sc-xdc-status')!.textContent = `This app could not be started: ${message}`
  }

  close(key: string) {
    const app = this.apps.get(key)
    if (!app) return
    this.apps.delete(key)
    this.closed.set(app.origin, app)
    setTimeout(() => this.closed.get(app.origin) === app && this.closed.delete(app.origin), 5000)
    if (app.popup) app.popup.close()
    else {
      // Unload the app while its frame is still attached, so its pagehide,
      // visibilitychange and unload handlers run and what they send arrives
      // (an app saving on close); a removed frame's messages never do. An app
      // window closed by the user only gets beforeunload through (WEBXDC.md).
      // In a cross-process frame about:blank commits first and the app's
      // unload handlers run after, in their own process — so the frame stays,
      // hidden, a while past that load. ponytail: 2 s, far above Chrome's own
      // bound for a subframe's unload; a slower one loses its messages.
      app.win.hidden = true
      app.frame.addEventListener('load', () => setTimeout(() => app.win.remove(), 2000), { once: true })
      app.frame.src = 'about:blank'
      setTimeout(() => app.win.remove(), 7000)
    }
    if (app.realtime) this.rpc.leaveWebxdcRealtime(app.accountId, app.msgId).catch(() => {})
    // the entry the browser is on is this app's: take it along, and those of
    // any closed out of turn beneath it (popstate closes find it gone already)
    if (history.state?.webxdc === key && this.back.at(-1) === key) {
      let n = 0
      while (this.back.length && !this.apps.has(this.back.at(-1)!)) this.back.pop(), n++
      history.go(-n)
    }
  }

  closeAll() {
    for (const key of [...this.apps.keys()]) this.close(key)
  }

  // ---- the bridge: requests from an app's webxdc.js ----
  private onAppMessage = async (e: MessageEvent) => {
    const d = e.data
    let app: App | undefined
    // (e.source, not null: a frame that is gone has a null contentWindow too)
    for (const a of this.apps.values()) if (e.source && e.source === a.frame.contentWindow) app = a
    // A page on its way out (pagehide, visibilitychange, unload) posts
    // without a source, or as an app just closed. Its origin, one per
    // instance, says whose it is — only that app's code is served there — and
    // what it sends then is the app saving its state: losing it loses data.
    if (!app && e.source === null) app = [...this.apps.values()].find(a => a.origin === e.origin)
    let closed = false
    if (!app && (app = this.closed.get(e.origin))) closed = true
    // the origin check is what binds a request to an instance: a frame that
    // navigated somewhere else is still the same window, but no longer the app
    if (!app || e.origin !== app.origin) return
    // a closed app may still save; nothing else (no realtime rejoin, no
    // picker, no link after the user closed it)
    if (closed && d?.webxdc !== 'sendUpdate') return
    // the bootstrap page could not hand over to the app (no service workers in
    // a private window, say). The app can post this too — about itself only.
    if (d?.type === 'error') return this.fail(app, String(d.message))
    if (typeof d?.webxdc !== 'string') return
    if (d.webxdc === 'focus') return this.raise(app)
    if (d.webxdc === 'openLink') return void this.openLink(app, String(d.url))
    const { accountId, msgId, frame, origin } = app
    const reply = (result?: unknown, error?: string) =>
      frame.contentWindow?.postMessage({ webxdc: 'reply', id: d.id, result, error }, origin)
    if (app.busy >= MAX_BUSY) return reply(undefined, 'too many webxdc calls at once')
    app.busy++
    try {
      if (d.webxdc === 'getUpdates') {
        if (!Number.isSafeInteger(d.serial) || d.serial < 0) throw new Error('bad serial')
        reply(await this.rpc.getWebxdcStatusUpdates(accountId, msgId, d.serial))
      } else if (d.webxdc === 'sendUpdate') {
        if (typeof d.update !== 'string') throw new Error('update must be a JSON string')
        reply(await this.rpc.sendWebxdcStatusUpdate(accountId, msgId, d.update, ''))
      } else if (d.webxdc === 'sendToChat') {
        const f = d.file
        if (f != null && (typeof f.file_name !== 'string' || typeof f.file_content !== 'string')) {
          throw new Error('bad file')
        }
        if (d.text != null && typeof d.text !== 'string') throw new Error('bad text')
        this.d.sendToChat(f ? { file_name: f.file_name, file_content: f.file_content } : null, d.text ?? null, accountId)
        // the chat picker opens here, maybe behind the app's window (Electron
        // focuses its main window too)
        focus()
        reply()
      } else if (d.webxdc === 'realtimeAdvertise') {
        app.realtime = true
        reply(await this.rpc.sendWebxdcRealtimeAdvertisement(accountId, msgId))
      } else if (d.webxdc === 'realtimeSend') {
        // isView, not instanceof: in an app window the bytes arrive in that
        // window's realm
        if (!ArrayBuffer.isView(d.data) || d.data.byteLength > MAX_REALTIME) throw new Error('bad realtime data')
        const bytes = new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength)
        reply(await this.rpc.sendWebxdcRealtimeData(accountId, msgId, Array.from(bytes)))
      } else if (d.webxdc === 'realtimeLeave') {
        app.realtime = false
        reply(await this.rpc.leaveWebxdcRealtime(accountId, msgId))
      } else {
        throw new Error(`unknown webxdc call ${d.webxdc}`)
      }
    } catch (err) {
      reply(undefined, String(err))
    } finally {
      app.busy--
    }
  }

  /** Web links leave the sandbox with whatever the app put in them, so they
   * are shown and asked about first (one click on "Continue" would do
   * otherwise); mailto: and invites go to flows that ask for themselves. */
  private async openLink(app: App, url: string) {
    if (document.getElementById('sc-webxdc-link')) return // one at a time
    const web = /^https?:/i.test(url)
    focus() // the dialog, or the chat the link opens, is here
    if (web && !(await confirmLink(url))) return
    this.d.openLink(url, app.accountId)
  }

  // ---- core events (frontend system-integration/webxdc.ts) ----
  statusUpdate(accountId: number, msgId: number) {
    const app = this.apps.get(`${accountId}.${msgId}`)
    app?.frame.contentWindow?.postMessage({ webxdc: 'statusUpdate' }, app.origin)
  }

  realtimeData(accountId: number, msgId: number, data: number[]) {
    const app = this.apps.get(`${accountId}.${msgId}`)
    app?.frame.contentWindow?.postMessage({ webxdc: 'realtime', data: Uint8Array.from(data) }, app.origin)
  }

  /** Fires for every MsgsChanged: only an open app's title can need it. */
  async messageChanged(accountId: number, msgId: number) {
    const app = this.apps.get(`${accountId}.${msgId}`)
    if (!app) return
    const info = await this.rpc.getWebxdcInfo(accountId, msgId)
    const { chatId } = await this.rpc.getMessage(accountId, msgId)
    const { name } = await this.rpc.getBasicChatInfo(accountId, chatId)
    if (app.popup) app.popup.document.title = titleOf(info, name)
    else app.win.querySelector('.sc-xdc-title')!.textContent = titleOf(info, name)
  }

  /** A message was deleted (msgId), or a chat with unknown ones in it (null):
   * close what is open and wipe the storage of every app that is gone. The
   * account is told apart by its salt in the origin, not by the id recorded:
   * ids can be renumbered, and a wrong one would ask the wrong account's core
   * which of its messages still exist. */
  async instanceDeleted(accountId: number, msgId: number | null) {
    const salt = await this.rpc.getConfig(accountId, SALT_KEY)
    if (!salt) return // never ran an app
    const mine = (origin: string) => origin.includes(`//${salt}m`)
    if (msgId != null) await this.wipeWhere((origin, _, m) => mine(origin) && m === msgId)
    const ours = Object.entries(this.record).filter(([o]) => mine(o)).map(([, [, m]]) => m)
    if (!ours.length) return
    const alive = await this.rpc.getExistingMsgIds(accountId, ours)
    await this.wipeWhere((origin, _, m) => mine(origin) && !alive.includes(m))
  }

  /** The account is gone already (backend-com.ts removes it first), and its
   * salt with it — so this goes by the id it had, sparing every origin whose
   * salt a remaining account still has (a backup restored next to its
   * original brings the same salt along, and with it the same origins). */
  async deleteAccountData(accountId: number): Promise<void> {
    const ids = await this.rpc.getAllAccountIds()
    const live = await Promise.all(ids.map(id => this.rpc.getConfig(id, SALT_KEY).catch(() => null)))
    return this.wipeWhere((origin, a) => a === accountId && !live.some(s => s && origin.includes(`//${s}m`)))
  }

  /** One at a time: each wipe is a frame and a round trip of its own. An entry
   * whose wipe fails (offline, say) stays recorded for the next cleanup. */
  private wipeWhere(match: (origin: string, accountId: number, msgId: number) => boolean): Promise<void> {
    this.wipes = this.wipes.then(async () => {
      for (const [origin, [a, m]] of Object.entries(this.record)) {
        if (!match(origin, a, m)) continue
        for (const [key, app] of this.apps) if (app.origin === origin) this.close(key)
        try {
          await wipe(origin)
          delete this.record[origin]
          this.save()
        } catch (err) {
          this.d.log.warn('webxdc storage wipe failed, will retry', origin, err)
        }
      }
    })
    return this.wipes
  }
}

/** Wipe one webxdc origin's storage from INSIDE it: a hidden frame of its
 * bootstrap page, embedded under this same top-level page so it lands in the
 * very storage partition the app wrote to (WEBXDC.md, "Storage and deletion"). */
async function wipe(origin: string): Promise<void> {
  const frame = el('iframe', { display: 'none' })
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  frame.src = `${origin}/webxdc-host.html`
  document.body.append(frame)
  try {
    await hostReady(frame, origin)
    const wiped = fromHost(frame, origin, 'wiped', 15_000)
    frame.contentWindow!.postMessage({ type: 'wipe' }, origin)
    await wiped
  } finally {
    frame.remove()
  }
}

/** Move `win` by dragging `handle`. The frame inside would swallow the
 * pointer the moment it passed over it, hence the dragging class (CSS turns
 * its pointer events off). The title bar never leaves the viewport. */
function dragBy(handle: HTMLElement, win: HTMLElement) {
  handle.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('button') || e.button !== 0) return
    const dx = e.clientX - win.offsetLeft
    const dy = e.clientY - win.offsetTop
    handle.setPointerCapture(e.pointerId)
    win.classList.add('sc-xdc-dragging')
    const move = (ev: PointerEvent) => {
      win.style.left = `${Math.min(Math.max(ev.clientX - dx, 40 - win.offsetWidth), innerWidth - 40)}px`
      win.style.top = `${Math.min(Math.max(ev.clientY - dy, 0), innerHeight - 40)}px`
    }
    const up = () => {
      win.classList.remove('sc-xdc-dragging')
      handle.removeEventListener('pointermove', move)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
    handle.addEventListener('pointercancel', up, { once: true })
  })
}

/** The opt-in (issue #2: a hard requirement), before the first start of each
 * app on this device — each new app is a new decision about whom to trust.
 * Settings › Chats switches it off for good. */
function confirmRisk(): Promise<boolean> {
  return new Promise(resolve => {
    const [overlay, card] = overlayCard('sc-webxdc-risk', 'wide')
    const done = (ok: boolean) => {
      overlay.remove()
      resolve(ok)
    }
    overlay.onclose = () => done(false)
    const cancel = scButton('Cancel')
    cancel.onclick = () => done(false)
    const ok = scButton('I understand the risk — open app', true)
    ok.onclick = () => done(true)
    card.append(
      el('h2', {}, 'Open a webxdc app?'),
      el(
        'p',
        {},
        'Webxdc apps are small programs that your chat partners send. In this browser edition each app runs on its own web address, walled off by your browser from your chats, your account and every other app.'
      ),
      el(
        'p',
        {},
        'This sandbox has not been independently audited. Apps are blocked from the internet, but a malicious app may still find a way to send data off your device — for example over WebRTC or DNS lookups, which a browser cannot switch off for a single page.'
      ),
      el(
        'p',
        {},
        'Only open apps from people you trust. For the most secure experience, use the official Delta Chat apps.'
      ),
      el(
        'p',
        {},
        'You are asked once for every new app. To stop these warnings, turn off "Warn before opening webxdc apps" in Settings › Chats.'
      ),
      el('div', 'sc-row', [cancel, ok])
    )
    document.body.append(overlay)
    showOnTop(overlay)
  })
}

function confirmLink(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const [overlay, card] = overlayCard('sc-webxdc-link', 'wide')
    const done = (ok: boolean) => {
      overlay.remove()
      resolve(ok)
    }
    overlay.onclose = () => done(false)
    const cancel = scButton('Cancel')
    cancel.onclick = () => done(false)
    const ok = scButton('Open link', true)
    ok.onclick = () => done(true)
    const shown = el('p', { wordBreak: 'break-all', fontFamily: 'monospace' }, url)
    card.append(
      el('h2', {}, 'Open a link from a webxdc app?'),
      el('p', {}, 'The app wants to open this address. Whatever is in it reaches that website, so only open it if you trust the app:'),
      shown,
      el('div', 'sc-row', [cancel, ok])
    )
    document.body.append(overlay)
    showOnTop(overlay)
  })
}

function showNotServedDialog() {
  if (document.getElementById('sc-webxdc-dialog')) return
  const [overlay, card] = overlayCard('sc-webxdc-dialog')
  overlay.onclose = () => overlay.remove()
  const offline = navigator.onLine === false
  const link = el('a', 'sc-link', 'How to enable webxdc on a server →')
  link.href = SELFHOSTING_WEBXDC_URL
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  const closeBtn = scButton('Close', true)
  closeBtn.onclick = () => overlay.remove()
  card.append(
    el('h2', {}, offline ? 'You are offline' : 'Webxdc apps are not available here'),
    el(
      'p',
      {},
      offline
        ? 'Starting a webxdc app needs a connection to this server. Try again once you are back online.'
        : `Each app needs a web address of its own (*.webxdc.${location.host}) to run isolated from your chats, and this server does not provide one. You can still open the app in the official Delta Chat apps.`
    ),
    ...(offline ? [] : [link]),
    el('div', 'sc-row', [closeBtn])
  )
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove()
  }
  document.body.append(overlay)
  showOnTop(overlay)
}
