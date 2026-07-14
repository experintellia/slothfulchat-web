/**
 * SlothfulChat BrowserRuntime: sets `window.r` before bundle.js loads, exactly
 * like upstream's target-browser runtime.js — but instead of talking to a
 * node backend over websockets/HTTP it runs chatmail core as wasm in a Web
 * Worker and keeps all "backend" state in localStorage / the core's memfs.
 *
 * Forked from vendor/deltachat-desktop/packages/target-browser/runtime-browser/runtime.ts
 * (upstream file untouched). bundle.js stays byte-identical to upstream.
 */
import { startCore, type Core, type BaseDeltaChat } from '@slothfulchat/core-wasm'
import {
  CallBridge,
  CallPopupHost,
  RingtonePlayer,
  classifyCallOutcome,
  defaultMediaFactories,
  fetchIceServers,
  listInputDevices,
  openCallPopup,
  type CallBridgeCallbacks,
  type CallDirection,
  type CallPopupInit,
  type CallResult,
  type CallsRpcClient,
  type CallState,
} from '@slothfulchat/calls/bridge'
import { CallsUiStore, mountCallsUi } from '@slothfulchat/calls/ui'
import * as perf from './perf'
import * as analytics from './analytics'
import * as session from './session'
import { observeTransport } from './telemetry'
import { showAnalyticsInfoDialog } from './consent'
import { initDiagnostics } from './diagnostics'

// earliest boot milestone we control: our runtime bundle has finished loading
perf.boot('runtime-eval')

// ponytail: local structural types instead of importing @deltachat-desktop/*
// type packages (they are not part of this workspace). bundle.js only cares
// about runtime shape at runtime, not TS types.
type Theme = {
  name: string
  description: string
  address: string
  is_prototype: boolean
}
type DesktopSettings = ReturnType<typeof getDefaultSettings>
type Logger = {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  critical(...args: unknown[]): void
}

const SETTINGS_KEY = 'slothfulchat.desktopSettings'
const PROXY_KEY = 'slothfulchat.proxyUrl'
const DEFAULT_LOCAL_BRIDGE = 'ws://localhost:8641'

// mirrors @deltachat-desktop/shared/state.ts getDefaultState(),
// with minimizeToTray:false like upstream target-browser
function getDefaultSettings() {
  return {
    bounds: {},
    HTMLEmailWindowBounds: undefined,
    enterKeySends: false,
    notifications: true,
    showNotificationContent: true,
    locale: null as string | null,
    credentials: undefined,
    lastAccount: undefined as number | undefined,
    enableOnDemandLocationStreaming: false,
    linkPreviewSuggestions: false,
    chatViewBgImg: undefined as string | undefined,
    lastChats: {},
    zoomFactor: undefined,
    activeTheme: 'system',
    minimizeToTray: false,
    syncAllAccounts: true,
    lastSaveDialogLocation: undefined,
    enableWebxdcDevTools: false,
    HTMLEmailAskForRemoteLoadingConfirmation: true,
    HTMLEmailAlwaysLoadRemoteContent: false,
    galleryImageKeepAspectRatio: false,
    useSystemUIFont: false,
    contentProtectionEnabled: false,
    inChatSoundsVolume: 0.5,
    autostart: true,
    autostartElectron: false,
    appStoreBaseUrl: undefined,
    hideNewChatSuggestions: false,
    publicBotsRemoteLoadConsent: false,
  }
}

// copied from @deltachat-desktop/shared/themes.ts (assemble.mjs has the JS twin)
const HIDDEN_THEME_PREFIX = 'dev_'
function parseThemeMetaData(rawTheme: string): {
  name: string
  description: string
} {
  const meta_data_block =
    /.theme-meta ?{([^]*)}/gm.exec(rawTheme)?.[1].trim() || ''
  const regex = /--(\w*): ?['"]([^]*?)['"];?/gi
  const meta: { [key: string]: string } = {}
  let last_result: RegExpExecArray | null = null
  while ((last_result = regex.exec(meta_data_block))) {
    meta[last_result[1]] = last_result[2]
  }
  if (!meta.name || !meta.description) {
    throw new Error(
      'The meta variables meta.name and meta.description must be defined'
    )
  }
  return meta as { name: string; description: string }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  txt: 'text/plain',
}
const mimeFromName = (name: string) =>
  MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ??
  'application/octet-stream'

/** Where backup exports land in the core memfs; the blobs SW serves
 * GET /download-backup/:filename from here. */
const EXPORTS_DIR = '/exports'

/** Path the app is served under, e.g. "/" locally or "/slothfulchat-web/" on
 * GitHub Pages project sites. Derived from the page URL so the same build works
 * at any base without a build-time flag. Always ends in "/". */
const BASE = new URL('.', location.href).pathname

/** Instance display name (config.js, baked by assemble.mjs / customize.mjs);
 * used for the tab title and fatal dialogs. */
const APP_NAME = (window as any).__slothfulConfig?.instanceName || 'SlothfulChat'

/** Prefixes the Delta Chat core's checkQr understands as an invite / login /
 * verification payload. Used to sniff a deep-linked QR out of the page URL so
 * we can hand it to the frontend's onOpenQrUrl. Matched case-insensitively. */
const QR_URL_PREFIXES = [
  'openpgp4fpr:', // verified-contact / group invite (QR + `openpgp4fpr:` scheme)
  'https://i.delta.chat/', // same invite, https fallback form ("invite link")
  'dcaccount:', // scan-to-configure a chatmail account
  'dclogin:', // scan-to-login
]

/** What the app was launched to do, sniffed out of the page URL at boot:
 *  - `qr`: an invite / login / verification payload → frontend `onOpenQrUrl`.
 *  - `text`: arbitrary shared text/link → frontend `onWebxdcSendToChat` as a
 *    plain message (opens the "send to which chat?" picker, drafts the text). */
type BootShareAction =
  | { kind: 'qr'; url: string }
  | { kind: 'text'; text: string }
  | null

/** Classifies a launch's query params into an action, without touching the URL.
 *
 * Two manifest entries feed query params here:
 *  - `protocol_handlers`: the `openpgp4fpr:` scheme is on the browser's
 *    registerProtocolHandler safelist, so the OS/browser can send an
 *    `openpgp4fpr:…` URI straight to the installed PWA — it arrives in `?qr=`
 *    (the handler's `%s` slot).
 *  - `share_target`: a cross-origin `https://i.delta.chat/…` invite link can't
 *    be a protocol handler (not our origin, needs no upstream registration),
 *    but the PWA can register as a share target, so a link shared from another
 *    app lands in `?url=` / `?text=` / `?title=`.
 *
 * A field that is *exactly* a recognized invite (a single token, no prose) is
 * treated as a QR and handed verbatim to the frontend's onOpenQrUrl → core
 * checkQr. Anything else is a plain message to forward into a chat via
 * onWebxdcSendToChat — including prose that merely mentions an invite link,
 * which we send whole rather than tearing the link out of its message.
 * (`.xdc` file opens don't come through here — they arrive via launchQueue.) */
function parseShareAction(params: URLSearchParams): BootShareAction {
  const looksLikeQr = (s: string) =>
    QR_URL_PREFIXES.some(p => s.toLowerCase().startsWith(p))
  const asBareInvite = (s: string | null | undefined): string | null => {
    const t = s?.trim()
    return t && !/\s/.test(t) && looksLikeQr(t) ? t : null
  }

  for (const key of ['qr', 'url', 'text', 'title']) {
    let invite = asBareInvite(params.get(key))
    if (invite) {
      // core workaround (deltachat-core-rust#1969): an openpgp4fpr: URI whose
      // '#' arrived percent-encoded won't parse; restore it. Mirrors electron
      // open_url.ts.
      if (invite.toLowerCase().startsWith('openpgp4fpr') && !invite.includes('#')) {
        invite = invite.replace('%23', '#')
      }
      return { kind: 'qr', url: invite }
    }
  }

  // no invite: join the non-empty, distinct shared fields into one message.
  const seen = new Set<string>()
  const parts: string[] = []
  for (const key of ['title', 'text', 'url']) {
    const v = params.get(key)?.trim()
    if (v && !seen.has(v)) {
      seen.add(v)
      parts.push(v)
    }
  }
  return parts.length ? { kind: 'text', text: parts.join('\n') } : null
}

/** Reads what the app was launched with out of the page URL (if anything) and
 * strips the consumed params so a reload doesn't replay the action. */
function extractBootShareAction(): BootShareAction {
  const params = new URLSearchParams(location.search)
  const action = parseShareAction(params)
  if (!action) return null

  // scrub only the params we consumed; keep the rest (e.g. ?proxy=).
  for (const key of ['qr', 'url', 'text', 'title']) params.delete(key)
  try {
    const clean = new URL(location.href)
    clean.search = params.toString()
    history.replaceState(history.state, '', clean.toString())
  } catch {
    /* replaceState can throw in exotic sandboxes; the action still fires */
  }
  return action
}

/** Computed once at module load (before `new BrowserRuntime()`), so the very
 * first thing the runtime knows is whether it was launched to open an invite or
 * forward a shared message. A warm launch into an already-open window arrives
 * later via launchQueue instead (see the consumer in `initialize`). */
const BOOT_SHARE = extractBootShareAction()

/** base64 (no data-URL prefix) of a Blob's bytes, via FileReader so large
 * archives don't blow the call stack the way `btoa(String.fromCharCode(...))`
 * would. Used to hand a launched `.xdc` to the frontend's send-to-chat dialog,
 * which expects base64 `file_content` (same contract electron/tauri use). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('FileReader did not return a data URL'))
        return
      }
      // strip the "data:<mime>;base64," header (first comma terminates it)
      resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

let core: Core | null = null
function getCore(): Core {
  if (!core) {
    const params = new URLSearchParams(location.search)
    const wsProxyUrl = resolveBridgeUrl()
    // OPFS persistence is on by default; ?persist=0 opts out (fresh-core tests)
    const persist = params.get('persist') !== '0'
    // which kind of bridge this session uses (local device / instance-provided /
    // user-custom); no-op unless analytics is enabled
    analytics.event('bridge', { kind: bridgeKind(wsProxyUrl) })
    perf.boot('worker-spawn')
    core = startCore({ wsProxyUrl, persist }, new URL(BASE + 'core/worker.js', location.href))
    // time selected RPC round-trips (local) + derive anonymous usage events
    observeTransport(core.transport as any)
    // the worker reports when it gave up waiting for the OPFS lock — the core
    // is (almost certainly) running in another tab. ponytail: no faster
    // web-lock detection — its release lags on reloads and false-positives
    core.worker.addEventListener('message', event => {
      const type = (event as MessageEvent).data?.type
      if (type === 'fatal-opfs-locked') {
        analytics.event('boot_error', { kind: 'opfs-locked' })
        showFatalDialog(
          'sc-already-running-dialog',
          'Already running in another tab',
          `${APP_NAME} is already open in another tab or window and can ` +
            'only run in one at a time. Close the other tab, then retry.'
        )
      } else if (type === 'fatal-storage-blocked') {
        analytics.event('boot_error', { kind: 'storage-blocked' })
        showFatalDialog(
          'sc-storage-blocked-dialog',
          'Browser storage is blocked',
          `${APP_NAME} needs to store data in your browser, but your ` +
            'browser is blocking it. Please allow cookies/site data for ' +
            `${location.hostname} and reload — on iPhone/iPad, turn off ` +
            'Settings → Safari → Advanced → Block All Cookies.'
        )
      } else if (type === 'fatal-init-error') {
        analytics.event('boot_error', { kind: 'init-error' })
        showFatalDialog(
          'sc-init-error-dialog',
          `${APP_NAME} could not start`,
          'The stored data could not be loaded. Details: ' +
            ((event as MessageEvent).data?.message ?? 'unknown error')
        )
      }
    })
    // The frontend passes the magic destination '<BROWSER>' to exportBackup on
    // the browser target (upstream's node server rewrites it to a tmp dir).
    // There is no server here, so rewrite it to a memfs dir before it reaches
    // the core. bundle.js stays untouched.
    const activeCore = core
    // request ids of in-flight import_backup calls, so we can hold their
    // success response until the imported blobs are durable (see below)
    const pendingImports = new Set<number | string>()
    const originalSend = core.transport._send.bind(core.transport)
    core.transport._send = (message: any) => {
      if (
        message?.method === 'export_backup' &&
        message.params?.[1] === '<BROWSER>'
      ) {
        message.params[1] = EXPORTS_DIR
      }
      // Backup import writes every blob into the memfs and queues it for the
      // ASYNC OPFS flusher. If the page reloads before that queue drains, the
      // memfs is rebuilt from OPFS without the un-flushed blobs → broken images
      // that only return once re-fetched from the server ("reload N times to
      // see the images", #77). Track the call so we can drain before reporting
      // success — see the _onmessage wrap.
      if (message?.method === 'import_backup' && message.id != null) {
        pendingImports.add(message.id)
      }
      originalSend(message)
    }
    // Hold a successful import_backup response until fsFlush() confirms every
    // imported blob has reached OPFS, so the frontend's importBackup promise
    // resolves only once a reload would find everything. Errors pass straight
    // through (a failed import wrote nothing to persist).
    const transport = core.transport as any
    const originalOnMessage = transport._onmessage.bind(transport)
    transport._onmessage = (message: any) => {
      if (message?.id != null && pendingImports.delete(message.id) && !message.error) {
        activeCore
          .fsFlush()
          .catch(err => console.warn('post-import OPFS flush failed', err))
          .finally(() => originalOnMessage(message))
        return
      }
      originalOnMessage(message)
    }
    // debug/smoke marker: proves the wasm core booted and answers rpc
    core.transport
      .request('get_system_info', [])
      .then(info => {
        perf.boot('core-ready') // first successful RPC = core is up
        ;(window as any).__coreSystemInfo = info
      })
      .catch(err => console.error('wasm core get_system_info failed', err))
    // classify the session as onboarding (no account yet) vs returning, for the
    // cold/warm startup bucket and the pageview retention prop, then send the
    // one pageview + startup sample once account state is known (so mode is
    // accurate). All no-ops unless analytics is enabled.
    core.transport
      .request('get_all_account_ids', [])
      .then(ids => session.setHadAccount(Array.isArray(ids) && ids.length > 0))
      .catch(() => {})
      .finally(() => {
        perf.recordStartup()
        analytics.pageview()
        analytics.trackStartup(perf.getStartup())
      })
  }
  return core
}

/** local device / instance-provided / user-custom bridge, for the `bridge`
 * event. Matches the resolved URL against the known options (localhost + the
 * operator's default/public bridges); anything else is a user-entered custom. */
function bridgeKind(url: string): 'local' | 'provided' | 'custom' {
  const n = normBridgeUrl(url)
  if (n === normBridgeUrl(DEFAULT_LOCAL_BRIDGE)) return 'local'
  const known = new Set(bridgeOptions().map(o => normBridgeUrl(o.url)))
  return known.has(n) ? 'provided' : 'custom'
}

const isIOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

/** Hand bytes to the user as a saved file, from this page's context. On an iOS
 * installed PWA neither window.open nor <a download> can deliver a file to the
 * Files app (the download opens a separate, core-less browser context), so use
 * the share sheet ("Save to Files"); everywhere else a plain download anchor is
 * simplest. Callers must invoke this within a user gesture — fsRead is a fast
 * worker round-trip so navigator.share still runs inside the tap's transient
 * activation window (~5s). */
async function saveFile(data: Uint8Array, name: string): Promise<void> {
  const file = new File([data as BlobPart], name, { type: mimeFromName(name) })
  if (isIOS && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return // user closed the sheet
      // otherwise fall through to the anchor download as a last resort
    }
  }
  const objUrl = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(objUrl), 10_000)
}

// The frontend downloads a finished backup by window.open('/download-backup/
// <name>') — the blobs SW then asks a window client (this page) for the bytes.
// On an iOS installed PWA that new window is a separate browser context with no
// wasm core, so the SW can never be served and nothing downloads. Intercept the
// open here and save the bytes straight from this page instead. Other
// window.open calls (external links, /blobs attachment views) don't match and
// pass through untouched.
const nativeOpen = window.open.bind(window)
window.open = ((url?: string | URL, ...rest: any[]) => {
  if (typeof url === 'string' && url.includes('/download-backup/')) {
    const name = decodeURIComponent(
      new URL(url, location.href).pathname.split('/').pop() || 'backup.tar'
    )
    getCore()
      .fsRead(`${EXPORTS_DIR}/${name}`)
      .then(data => saveFile(data, name))
      .catch(err => console.error('backup download failed', err))
    return null
  }
  return nativeOpen(url as any, ...rest)
}) as typeof window.open

/** blob service worker: page side. The SW forwards GET /blobs/:acc/:file to
 * us, we read from the core memfs and post the bytes back. */
function initBlobServiceWorker(log: Logger) {
  if (!('serviceWorker' in navigator)) {
    log.warn('no serviceWorker support, blob urls will not load')
    return
  }
  navigator.serviceWorker.addEventListener('message', async event => {
    const msg = event.data
    if (msg?.type !== 'blob-request') return
    const reply = (payload: object, transfer: Transferable[] = []) =>
      ((event.source as unknown as ServiceWorker) ??
        navigator.serviceWorker.controller)?.postMessage(payload, transfer)
    try {
      let data: Uint8Array
      let mime: string
      if (msg.webxdcIcon) {
        // icon lives inside the .xdc archive, not the memfs
        const { accountId, msgId } = msg.webxdcIcon
        const info = (await getCore().transport.request('get_webxdc_info', [
          accountId,
          msgId,
        ])) as { icon: string }
        const b64 = (await getCore().transport.request('get_webxdc_blob', [
          accountId,
          msgId,
          info.icon,
        ])) as string
        data = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        mime = mimeFromName(info.icon)
      } else {
        // msg.path = absolute memfs path (backup downloads, temp files),
        // otherwise a blob
        data = await getCore().fsRead(
          msg.path ?? `/accounts/${msg.accountId}/dc.db-blobs/${msg.filename}`
        )
        mime = mimeFromName(msg.filename)
      }
      reply(
        { type: 'blob-response', id: msg.id, data, mime },
        [data.buffer as ArrayBuffer]
      )
    } catch (error) {
      log.warn('blob-request failed', msg.accountId, msg.filename, error)
      reply({ type: 'blob-response', id: msg.id })
    }
  })
  navigator.serviceWorker
    // updateViaCache 'none': deploys announce themselves via a changed
    // sw-precache.js; the default ('imports') would let update checks read a
    // still-"fresh" old copy from the HTTP cache (Pages sends max-age=600)
    .register(BASE + 'blobs-sw.js', { scope: BASE, updateViaCache: 'none' })
    .then(reg => {
      if (navigator.serviceWorker.controller || !reg.active) {
        // controlled, or first install (claim() will take over) — all good
        try {
          sessionStorage.removeItem('sw-force-reloaded')
        } catch {}
        return
      }
      // hard reload bypassed the active SW for this page's whole lifetime;
      // blob urls can't load without it, so reload once (now controlled)
      try {
        if (sessionStorage.getItem('sw-force-reloaded')) {
          log.warn('page still uncontrolled after reload, blob urls will not load')
          return
        }
        sessionStorage.setItem('sw-force-reloaded', '1')
      } catch {
        return // no sessionStorage → can't guard against a reload loop
      }
      location.reload()
    })
    .catch(err => log.error('blobs-sw registration failed', err))
}

class BrowserRuntime {
  private rc_config: Record<string, unknown> | null = null
  private runtime_info: Record<string, unknown> | null = null

  onDrop: { elementRef: any; handler: (paths: string[]) => void } | null = null
  setDropListener(onDrop: BrowserRuntime['onDrop']) {
    this.onDrop = onDrop
  }

  // #region event callbacks set by the frontend (browser: mostly unused)
  onThemeUpdate: (() => void) | undefined
  onChooseLanguage: ((locale: string) => Promise<void>) | undefined
  onShowDialog: Function | undefined
  onResumeFromSleep: (() => void) | undefined
  onToggleNotifications: (() => void) | undefined
  // #endregion

  // Launch payloads (openpgp4fpr invite, shared text, opened .xdc) are captured
  // as soon as the runtime exists, but must NOT be delivered until the frontend
  // is *fully* ready. The frontend registers onOpenQrUrl/onWebxdcSendToChat on
  // its first render — with no account selected yet — and its onOpenQrUrl throws
  // "accountId is not set" while the send-to-chat picker throws "no account
  // selected". So we hold everything until emitUIFullyReady() (the same gate
  // electron uses via its `frontendReady` IPC), which the frontend calls only
  // after startup() has selected an account and re-registered both callbacks.
  private uiReady = false

  // #region onOpenQrUrl — deferred deep-link / invite delivery
  private _onOpenQrUrl: ((url: string) => void) | undefined
  private pendingQrUrl: string | null =
    BOOT_SHARE?.kind === 'qr' ? BOOT_SHARE.url : null
  get onOpenQrUrl(): ((url: string) => void) | undefined {
    return this._onOpenQrUrl
  }
  set onOpenQrUrl(cb: ((url: string) => void) | undefined) {
    this._onOpenQrUrl = cb
    this.flushPendingQrUrl()
  }
  private flushPendingQrUrl() {
    if (!this.uiReady || !this._onOpenQrUrl || this.pendingQrUrl == null) return
    const url = this.pendingQrUrl
    this.pendingQrUrl = null
    // defer past the current microtask so React has committed the
    // account-selected re-render; read the callback at fire time so we hit that
    // latest (valid-accountId) registration, not a stale closure.
    setTimeout(() => {
      try {
        this._onOpenQrUrl?.(url)
      } catch (err) {
        this.log.error('onOpenQrUrl deep-link delivery failed', err)
      }
    }, 0)
  }
  // #endregion

  // #region onWebxdcSendToChat — deferred "forward into a chat" delivery
  // The frontend's target-agnostic "send this into a chat" entry point: opens a
  // chat picker and drafts a message with the given text and/or file (electron/
  // tauri call it to route an opened .xdc into a chat; the dialog also accepts
  // file=null for a plain text share). Fed by shared text (extractBootShareAction)
  // and opened .xdc files (launchQueue); a small queue so opening several files
  // before the UI is ready doesn't drop all but the last.
  private _onWebxdcSendToChat: Function | undefined
  private pendingSendToChat: Array<{
    file: { file_name: string; file_content: string } | null
    text: string | null
  }> = BOOT_SHARE?.kind === 'text' ? [{ file: null, text: BOOT_SHARE.text }] : []
  get onWebxdcSendToChat(): Function | undefined {
    return this._onWebxdcSendToChat
  }
  set onWebxdcSendToChat(cb: Function | undefined) {
    this._onWebxdcSendToChat = cb
    this.flushPendingSendToChat()
  }
  /** Queue a message/file to forward into a chat; delivered once the frontend
   * handler is registered and the UI is fully ready. */
  private enqueueSendToChat(payload: BrowserRuntime['pendingSendToChat'][number]) {
    this.pendingSendToChat.push(payload)
    this.flushPendingSendToChat()
  }
  private flushPendingSendToChat() {
    if (!this.uiReady || !this._onWebxdcSendToChat || !this.pendingSendToChat.length) {
      return
    }
    const queued = this.pendingSendToChat
    this.pendingSendToChat = []
    setTimeout(() => {
      for (const { file, text } of queued) {
        try {
          this._onWebxdcSendToChat?.(file, text, undefined)
        } catch (err) {
          this.log.error('onWebxdcSendToChat delivery failed', err)
        }
      }
    }, 0)
  }
  // #endregion

  openMapsWebxdc(_accountId: number, _chatId?: number): void {
    throw new Error('Method not implemented.')
  }

  emitUIFullyReady(): void {
    perf.boot('ui-fully-ready')
    // The frontend has finished startup() and selected an account, so its
    // onOpenQrUrl / onWebxdcSendToChat are now registered with a real accountId.
    // Open the gate and flush any launch payload captured before now.
    this.uiReady = true
    this.flushPendingQrUrl()
    this.flushPendingSendToChat()
  }
  emitUIReady(): void {
    perf.boot('ui-ready')
    // send the bucketed startup sample (fires once, and only once cold/warm is
    // known — see analytics.trackStartup; getCore's account probe also calls it)
    analytics.trackStartup(perf.getStartup())
    console.log('emitUIReady') // no backend to notify
  }
  onDragFileOut(_file: string): void {
    return // browser can not implement this
  }
  isDroppedFileFromOutside(_file: string): boolean {
    return true
  }

  createDeltaChatConnection(
    _callCounterFunction: (label: string) => void
  ): BaseDeltaChat<any> {
    const dc = getCore().dc
    // Bring the call manager up as soon as the connection exists so it is
    // subscribed to IncomingCall on the in-page emitter and can ring for
    // incoming calls without the user having opened any call UI first. Guarded:
    // a fault in the (prototype) call subsystem must never break the core
    // connection the whole app depends on.
    try {
      getCallManager(this.log)
    } catch (err) {
      this.log.error('failed to initialize call manager', err)
    }
    return dc
  }

  openMessageHTML(): void {
    throw new Error('Method not implemented.')
  }
  notifyWebxdcStatusUpdate(): void {
    this.log.critical('Method not implemented.')
  }
  notifyWebxdcRealtimeData(): void {
    this.log.critical('Method not implemented.')
  }
  notifyWebxdcMessageChanged(): void {
    this.log.critical('Method not implemented.')
  }
  notifyWebxdcInstanceDeleted(): void {
    this.log.critical('Method not implemented.')
  }
  /**
   * Place an outgoing 1:1 call. `startWithCameraEnabled` (M3) is the upstream
   * `ChatView` call button's own audio-vs-video choice ("start_audio_call" vs
   * "start_video_call" in its context menu, both already calling this exact
   * method/signature) — `true` acquires the camera alongside the mic and
   * advertises `has_video` to the peer. The whole call — mic/camera
   * acquisition, non-trickle ICE, offer, ringing, connect, hangup — is
   * conducted by the call manager against the wasm core's jsonrpc client.
   * Runs inside the call-button click gesture, so the mic/camera-permission
   * prompt is allowed.
   */
  startOutgoingVideoCall(
    accountId: number,
    chatId: number,
    param?: { startWithCameraEnabled: boolean }
  ): void {
    getCallManager(this.log).startOutgoingCall(accountId, chatId, param?.startWithCameraEnabled ?? false)
  }
  /**
   * Show the incoming-call ring and, on accept, answer the call. Called both
   * from the IncomingCall event subscription and from the chat log's
   * accept/redial buttons (Message.tsx). `startWithCameraEnabled` (M3) mirrors
   * the CALLER's own `has_video` (the `IncomingCall` event's `has_video`) — we
   * add our own camera track to the answer so both sides carry video, per
   * ordinary WebRTC offer/answer symmetry (see `IncomingCallParams.hasVideo`'s
   * doc in `@slothfulchat/calls/bridge`).
   */
  async openIncomingVideoCallWindow(params: {
    accountId: number
    chatId: number
    callMessageId: number
    callerWebrtcOffer: string
    startWithCameraEnabled: boolean
  }): Promise<void> {
    getCallManager(this.log).openIncomingCall(params)
  }
  async saveBackgroundImage(
    _file: string,
    _isDefaultPicture: boolean
  ): Promise<string> {
    // ponytail: appearance-settings-only feature; needs a place to serve the
    // copied image from. Implement via memfs + SW route when someone asks.
    throw new Error('saveBackgroundImage not implemented in wasm edition yet')
  }

  async getLocaleData(locale?: string): Promise<object> {
    const messagesEnglish = await (await fetch(BASE + 'locales/en.json')).json()
    const untranslated = await (
      await fetch(BASE + 'locales/_untranslated_en.json')
    ).json()

    if (!locale) {
      return {
        locale: 'en',
        messages: { ...messagesEnglish, ...untranslated },
        dir: 'ltr',
      }
    }

    let localeMessages: object
    try {
      localeMessages = await (await fetch(`${BASE}locales/${locale}.json`)).json()
    } catch (error1) {
      // dialect fallback: de-CH -> de
      try {
        if (locale.indexOf('-') !== -1) {
          const base_locale = (locale = locale.split('-')[0])
          localeMessages = await (
            await fetch(`${BASE}locales/${base_locale}.json`)
          ).json()
        } else {
          throw new Error(
            'language load failed, even alternative of base language failed.'
          )
        }
      } catch (error2) {
        this.log.error(
          `Could not load messages for ${locale}, falling back to english`,
          error1,
          error2
        )
        locale = 'en'
        localeMessages = messagesEnglish
      }
    }
    return {
      locale,
      messages: { ...localeMessages, ...untranslated },
      dir: 'ltr',
    }
  }
  setLocale(_locale: string): Promise<void> {
    throw new Error('Method not implemented.')
  }

  async getDesktopSettings(): Promise<DesktopSettings> {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    const config = { ...getDefaultSettings(), ...stored }
    if (config.locale === null) {
      config.locale = navigator.language
    }
    return config
  }
  async setDesktopSetting(
    key: keyof DesktopSettings,
    value: string | number | boolean | undefined
  ): Promise<void> {
    if (key === 'notifications' && Boolean(value)) {
      await this.askBrowserForNotificationPermission()
    }
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    stored[key] = value
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored))
  }

  async getAvailableThemes(): Promise<Theme[]> {
    return (await fetch(BASE + 'themes.json')).json()
  }
  async getActiveTheme(): Promise<{ theme: Theme; data: string } | null> {
    const address = (await this.getDesktopSettings()).activeTheme
    let [location, id] = address.split(':')
    if (location === 'system') {
      location = 'dc'
      id = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    if (location !== 'dc') {
      throw new Error('only dc themes are implemented in the wasm edition')
    }
    const theme_file_request = await fetch(`${BASE}themes/${id}.css`)
    if (!theme_file_request.ok) {
      throw new Error('error loading theme: ' + theme_file_request.statusText)
    }
    const data = await theme_file_request.text()
    const metadata = parseThemeMetaData(data)
    return {
      theme: {
        address,
        description: metadata.description,
        name: metadata.name,
        is_prototype: id.startsWith(HIDDEN_THEME_PREFIX),
      },
      data,
    }
  }

  // #region temp files — live in the core memfs under /tmp
  private tmpPath(name: string): string {
    const base = name.split(/[/\\]/).pop() || 'file'
    return `/tmp/${crypto.randomUUID()}/${base}`
  }
  async writeTempFileFromBase64(name: string, content: string): Promise<string> {
    const binary = atob(content)
    const data = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)
    const path = this.tmpPath(name)
    await getCore().fsWrite(path, data)
    return path
  }
  async writeTempFile(name: string, content: string): Promise<string> {
    const path = this.tmpPath(name)
    await getCore().fsWrite(path, new TextEncoder().encode(content))
    return path
  }
  async copyFileToInternalTmpDir(
    fileName: string,
    sourcePath: string
  ): Promise<string> {
    const data = await getCore().fsRead(sourcePath)
    const path = this.tmpPath(fileName)
    await getCore().fsWrite(path, data)
    return path
  }
  async removeTempFile(name: string): Promise<void> {
    // same guard as upstream backendApi
    if (name.includes('tmp') && !name.includes('..')) {
      await getCore().fsRemove(name)
    }
  }
  // #endregion

  // #region notifications — verbatim from upstream runtime-browser
  activeNotifications: {
    [accountId: number]: { [chatId: number]: Notification[] }
  } = {}
  notificationCB: (data: {
    accountId: number
    chatId: number
    msgId: number
  }) => void = () => {
    this.log.critical('notification click handler not initialized yet')
  }
  setNotificationCallback(cb: BrowserRuntime['notificationCB']): void {
    this.notificationCB = cb
  }
  async showNotification(data: {
    accountId: number
    chatId: number
    messageId: number
    title: string
    body: string
    icon: string | null
  }): Promise<void> {
    if (Notification.permission != 'granted') {
      this.log.warn(
        "failed to showNotification: we don't have permission to send notifications"
      )
      return
    }
    const { accountId, chatId, body, title, icon: notificationIcon, messageId } = data
    this.log.debug('showNotification', { accountId, chatId, messageId })

    let icon = new URL(BASE + 'images/icon-256.png', location.origin).toString()
    if (notificationIcon) {
      try {
        const response = await fetch(
          notificationIcon.startsWith('data:')
            ? notificationIcon
            : this.transformBlobURL(notificationIcon)
        )
        if (!response.ok) {
          throw new Error('request failed: code' + response.status)
        }
        const blob = await response.blob()
        icon = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.onabort = reject
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      } catch (error) {
        this.log.warn('failed to load thumbnail for notification', error)
      }
    }

    const notification = new Notification(title, {
      body,
      icon,
      tag: `${accountId}.${chatId}.${messageId}`,
    })
    notification.onclick = this.notificationCB.bind(this, {
      accountId,
      chatId,
      msgId: messageId,
    })
    if (!this.activeNotifications[accountId]) {
      this.activeNotifications[accountId] = {}
    }
    if (this.activeNotifications[accountId][chatId]) {
      this.activeNotifications[accountId][chatId].push(notification)
    } else {
      this.activeNotifications[accountId][chatId] = [notification]
    }
  }
  clearAllNotifications(): void {
    for (const accountId of Object.keys(this.activeNotifications)) {
      if (!Number.isNaN(Number(accountId))) {
        this.clearNotificationsForAccount(Number(accountId))
      }
    }
  }
  clearNotificationsForAccount(accountId: number): void {
    for (const chatId of Object.keys(this.activeNotifications[accountId] ?? {})) {
      if (!Number.isNaN(Number(chatId))) {
        this.clearNotifications(accountId, Number(chatId))
      }
    }
  }
  clearNotifications(accountId: number, chatId: number): void {
    if (this.activeNotifications[accountId]?.[chatId]) {
      for (const notify of this.activeNotifications[accountId][chatId]) {
        notify.close()
      }
      delete this.activeNotifications[accountId][chatId]
    }
  }
  // #endregion

  setBadgeCounter(value: number): void {
    document.title = `${APP_NAME}${value ? `(${value})` : ''}`
  }
  deleteWebxdcAccountData(_accountId: number): Promise<void> {
    this.log.warn('deleteWebxdcAccountData method does not exist in browser.')
    return Promise.resolve()
  }
  closeAllWebxdcInstances(): void {
    this.log.critical('Method not implemented.')
  }
  restartApp(): void {
    this.log.critical('Method not implemented.')
  }
  getRuntimeInfo(): object {
    if (this.runtime_info === null) {
      throw new Error('this.runtime_info is not set')
    }
    return this.runtime_info
  }
  getWebxdcIconURL(accountId: number, msgId: number): string {
    // served by the blobs SW: it asks the page, which reads the icon out of
    // the .xdc archive via get_webxdc_info + get_webxdc_blob
    return `${BASE}webxdc-icon/${accountId}/${msgId}`
  }
  openWebxdc(): void {
    showWebxdcNotImplementedDialog()
  }
  async openPath(path: string): Promise<string> {
    if (path.includes('dc.db-blobs')) {
      window.open(this.transformBlobURL(path), '_blank')?.focus()
      return ''
    }
    throw new Error(
      'Browser does not support opening urls outside of blob directory'
    )
  }
  async getAppPath(_name: string): Promise<string> {
    // only used as a file-dialog defaultPath, which showOpenFileDialog ignores
    // in the browser — no real filesystem here. ponytail: '' is the no-op.
    return ''
  }
  async downloadFile(pathToSource: string, filename: string): Promise<void> {
    // blobdir attachments plus our own temp files (e.g. the chat HTML export,
    // which the frontend stages via writeTempFile before downloading)
    if (
      !pathToSource.includes('dc.db-blobs') &&
      !pathToSource.startsWith('/tmp/')
    ) {
      throw new Error(
        'Browser does not support opening urls outside of blob directory'
      )
    }
    // read the attachment from the core memfs and save it from this page, so it
    // works on an iOS installed PWA (see saveFile) instead of window.open-ing a
    // core-less browser context that the blobs SW can never serve
    await saveFile(await getCore().fsRead(pathToSource), filename)
  }

  // #region clipboard — verbatim from upstream runtime-browser
  readClipboardText(): Promise<string> {
    return navigator.clipboard.readText()
  }
  async readClipboardImage(): Promise<string | null> {
    try {
      const clipboardItems = await navigator.clipboard.read()
      for (const clipboardItem of clipboardItems) {
        for (const type of clipboardItem.types) {
          if (type.startsWith('image')) {
            const blob = await clipboardItem.getType(type)
            return await new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.onloadend = () => resolve(reader.result as string)
              reader.onabort = reject
              reader.onerror = reject
              reader.readAsDataURL(blob)
            })
          }
        }
      }
    } catch (err) {
      this.log.error('error in readClipboardImage', err)
    }
    return null
  }
  writeClipboardText(text: string): Promise<void> {
    return navigator.clipboard.writeText(text)
  }
  async writeClipboardImage(path: string): Promise<void> {
    try {
      const imgURL = this.transformBlobURL(path)
      const data = await fetch(imgURL)
      let blob = await data.blob()
      if (!blob.type.startsWith('image')) {
        throw new Error('Not an image mimetype:' + blob.type)
      }
      if (blob.type !== 'image/png') {
        const img = new Image()
        const blobPromise = new Promise<Blob>((resolve, reject) => {
          img.onload = async () => {
            try {
              const canvas = new OffscreenCanvas(
                img.naturalWidth,
                img.naturalHeight
              )
              const ctx = canvas.getContext('2d')
              if (!ctx) {
                throw new Error('canvas context creation error')
              }
              ctx.fillRect(0, 0, canvas.width, canvas.height)
              ctx.drawImage(img, 0, 0)
              resolve(await canvas.convertToBlob())
            } catch (error) {
              reject(error)
            }
          }
          img.onerror = reject
          img.onabort = reject
        })
        img.src = imgURL
        blob = await blobPromise
      }
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      this.log.debug('Fetched image copied.')
    } catch (err) {
      this.log.error('error in writeClipboardImage', err)
      throw err
    }
  }
  // #endregion

  transformBlobURL(blob_path: string): string {
    const matches = blob_path.match(/.*(:?\\|\/)(.+?)\1dc.db-blobs\1(.*)/)
    if (matches) {
      return `${BASE}blobs/${matches[2]}/${matches[3]}`
    }
    // absolute memfs path outside the blobdir (e.g. /tmp/<uuid>/<file> from
    // tmpPath(): draft attachments, file-picker uploads) — the SW resolves it
    // via the blob-request `path` field
    if (blob_path.startsWith('/')) {
      return `${BASE}blob-path/${encodeURIComponent(blob_path)}`
    }
    if (blob_path !== '') {
      this.log.error('transformBlobURL wrong url format', blob_path)
    }
    return ''
  }
  transformStickerURL(sticker_path: string): string {
    // stickers live in <accounts>/<id>/stickers/<pack>/<file>, a sibling of
    // dc.db-blobs — an absolute memfs path, so transformBlobURL routes it
    // through /blob-path/ (the dc.db-blobs branch never matches) and the SW
    // serves it exactly like any other blob.
    return this.transformBlobURL(sticker_path)
  }
  async deleteSticker(stickerPath: string): Promise<void> {
    // the frontend passes the pack directory; fs_remove deletes a tree
    await getCore().fsRemove(stickerPath)
  }

  async showOpenFileDialog(options: {
    filters?: { extensions: string[] }[]
    properties: string[]
  }): Promise<string[]> {
    const extstring = options.filters
      ?.map(filter => filter.extensions)
      .reduce((p, c) => c.concat(p))
      .map(ext => `.${ext}`)
      .join()
    return new Promise((resolve, reject) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = extstring || ''
      if (options.properties.includes('multiSelections')) {
        input.multiple = true
      }
      // iOS Safari only opens the picker for an input that is in the DOM; a
      // detached input (fine on desktop) silently does nothing, so backup
      // import never got a file. Attach it hidden and clean up after.
      input.style.display = 'none'
      document.body.append(input)
      // onchange never fires when the user cancels, so also drop the node when
      // focus returns to the page. ponytail: worst case is one empty hidden
      // input if both miss — negligible.
      window.addEventListener('focus', () => input.remove(), { once: true })
      input.onchange = async () => {
        input.remove()
        if (input.files != null) {
          // upstream uploads to the backend; we write into the core memfs
          const uploads = [...input.files].map(async file => {
            const data = new Uint8Array(await file.arrayBuffer())
            const path = this.tmpPath(file.name)
            await getCore().fsWrite(path, data)
            return path
          })
          const results = await Promise.allSettled(uploads)
          const uploadedFiles = results
            .filter(r => r.status == 'fulfilled')
            .map(r => (r as PromiseFulfilledResult<string>).value)
          const rejectedPromise = results.find(r => r.status == 'rejected')
          if (rejectedPromise) {
            this.log.warn(
              'some file failed to upload, removing other files now:',
              (rejectedPromise as PromiseRejectedResult).reason
            )
            uploadedFiles.forEach(path => this.removeTempFile(path))
            reject((rejectedPromise as PromiseRejectedResult).reason)
          } else {
            resolve(uploadedFiles)
          }
        } else {
          resolve([])
        }
      }
      input.click()
    })
  }

  openLink(link: string): void {
    // all in-app external links funnel through here (About dialog, ClickableLink)
    analytics.trackLink(link)
    window.open(link, '_blank')?.focus()
  }

  private log: Logger = console as unknown as Logger
  async initialize(
    setLogHandler: (
      handler: (...args: any[]) => void,
      rcConfig: object
    ) => void,
    getLogger: (channel: string) => Logger
  ): Promise<void> {
    this.log = getLogger('runtime/wasm-browser')

    // no backend: rc_config / runtime_info are built locally,
    // mirroring target-browser/src/rc-config.ts and backendApi.ts.
    // devmode comes from config.js (assemble.mjs): false on release builds,
    // defaulting to true for local dev.
    const devmode = (window as any).__slothfulConfig?.devmode ?? true
    const config = (this.rc_config = {
      'log-debug': devmode,
      'log-to-console': true,
      'machine-readable-stacktrace': false,
      devmode,
      theme: undefined,
      'theme-watch': false,
      'translation-watch': false,
      'allow-unsafe-core-replacement': false,
      minimized: false,
      version: false,
      v: false,
      help: false,
      h: false,
    })
    this.runtime_info = {
      buildInfo: {
        VERSION: '2.53.1-slothfulchat-wasm',
        GIT_REF: 'unknown',
        BUILD_TIMESTAMP: 0,
      },
      isAppx: false,
      isMac: false,
      target: 'browser',
      versions: [{ label: 'Browser UA', value: navigator.userAgent }],
      isContentProtectionSupported: false,
    }

    // logs stay in the browser console ('log-to-console' above); no backend log file
    setLogHandler(() => {}, config)

    initBlobServiceWorker(this.log)
    this.askBrowserForNotificationPermission()

    // diagnostics panel (opened from the Log dialog); a no-op on self-hosted
    // builds, where analytics is unconfigured. (The pageview + startup sample
    // are sent from getCore once account state is known.)
    initDiagnostics()

    // onboarding funnel hook: WelcomeScreen (desktop patch) calls this for the
    // top-of-funnel "welcome" step; the chosen method and success/failure are
    // derived from RPCs in telemetry.ts. Just forwards to analytics, guarded and
    // best-effort — a no-op when analytics is off.
    ;(window as any).__slothfulTrack = (name: string, props?: Record<string, string>) => {
      try {
        analytics.event(name, props)
      } catch {
        /* never let a UI hook throw */
      }
    }

    // analytics consent UI hook: the welcome screen and Settings → Advanced
    // (desktop patches) render an opt-out checkbox through this. Opt-out
    // semantics: 'unset' counts as enabled. configured=false (every self-hosted
    // build) hides the checkbox entirely.
    ;(window as any).__slothfulAnalyticsUi = {
      configured: analytics.isConfigured(),
      enabled: () => analytics.getConsent() !== 'denied',
      setEnabled: (on: boolean) => analytics.setConsent(on ? 'granted' : 'denied'),
      showInfo: showAnalyticsInfoDialog,
    }

    document.body.addEventListener('drop', async e => {
      if (!this.onDrop) {
        this.log.warn('file dropped, but no drop handler set')
        return
      }
      const dropTarget = this.onDrop.elementRef.current
      if (!dropTarget) {
        this.log.warn('file dropped, but drop target is unset')
        return
      }
      if (!e.dataTransfer) {
        return
      }
      if (!(e.target && dropTarget.contains(e.target as HTMLElement))) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const paths: string[] = []
      for (const file of e.dataTransfer.files) {
        const data = new Uint8Array(await file.arrayBuffer())
        const path = this.tmpPath(file.name)
        await getCore().fsWrite(path, data)
        paths.push(path)
      }
      this.onDrop.handler(paths)
    })

    // File Handling API + focus-existing launches. Chromium-desktop only; a
    // no-op elsewhere.
    //  - files: an installed PWA registered for `.xdc` (manifest file_handlers)
    //    is launched with the opened archive(s) here. Running webxdc isn't
    //    supported in this edition, but we can still forward the archive into a
    //    chat (the recipient's client runs it) — reuse the send-to-chat picker
    //    via onWebxdcSendToChat, exactly as the electron/tauri targets do.
    //  - targetURL: with `launch_handler: focus-existing`, a protocol/share
    //    launch into an already-open window does NOT navigate (so
    //    extractBootShareAction never re-runs); the launch URL arrives here
    //    instead. The very first callback corresponds to this window's own cold
    //    start, whose URL was already consumed from location.search by
    //    BOOT_SHARE — skip its targetURL to avoid a double delivery; handle
    //    every later (warm) launch.
    const launchQueue = (window as any).launchQueue
    if (launchQueue && typeof launchQueue.setConsumer === 'function') {
      let coldStart = true
      launchQueue.setConsumer(async (launchParams: any) => {
        const isColdStart = coldStart
        coldStart = false

        for (const handle of launchParams?.files ?? []) {
          try {
            const blob: File = await handle.getFile()
            if (!/\.xdc$/i.test(blob.name)) continue
            const file_content = await blobToBase64(blob)
            this.enqueueSendToChat({
              file: { file_name: blob.name, file_content },
              text: null,
            })
          } catch (err) {
            this.log.error('failed to read launched .xdc file', err)
          }
        }

        const targetURL = launchParams?.targetURL
        if (targetURL && !isColdStart) {
          try {
            const action = parseShareAction(new URL(targetURL, location.href).searchParams)
            if (action?.kind === 'qr') {
              this.pendingQrUrl = action.url
              this.flushPendingQrUrl()
            } else if (action?.kind === 'text') {
              this.enqueueSendToChat({ file: null, text: action.text })
            }
          } catch (err) {
            this.log.error('failed to handle launch targetURL', err)
          }
        }
      })
    }
  }

  async askBrowserForNotificationPermission() {
    if ('Notification' in window && Notification.permission !== 'granted') {
      const result = await Notification.requestPermission()
      this.log.debug('Notification.requestPermission', { result })
    }
  }

  getRC_Config(): object {
    if (this.rc_config === null) {
      throw new Error('this.rc_config is not set')
    }
    return this.rc_config
  }
  async openHelpWindow(anchor?: string): Promise<void> {
    const curLang = (window as any).localeData.locale
    const anchorPath = anchor ? '#' + anchor : ''
    const response = await fetch(`/help/${curLang}/help.html`, {
      method: 'HEAD',
    })
    const lang = response.ok ? curLang : 'en'
    window.open(`/help/${lang}/help.html${anchorPath}`, '_blank')?.focus()
  }
  openLogFile(): void {
    this.log.warn('no log file in wasm edition, logs are in the browser console')
  }
  getCurrentLogLocation(): string {
    return 'browser console'
  }
  async readCurrentLog(): Promise<string> {
    return ''
  }
  reloadWebContent(): void {
    window.location.reload()
  }
  getConfigPath(): string {
    this.log.warn('getConfigPath method does not exist in browser.')
    return ''
  }
  getAutostartState(): Promise<{
    isSupported: boolean
    isRegistered: boolean | null
  }> {
    return Promise.resolve({ isSupported: false, isRegistered: null })
  }
  async checkMediaAccess(
    mediaType: string
  ): Promise<'granted' | 'not-determined' | 'denied' | 'unknown'> {
    return navigator.permissions
      .query({ name: mediaType as PermissionName })
      .then(result => {
        if (result.state === 'granted') {
          return 'granted' as const
        } else if (result.state === 'prompt') {
          return 'not-determined' as const
        } else if (result.state === 'denied') {
          return 'denied' as const
        }
        return 'unknown' as const
      })
  }
  askForMediaAccess(mediaType: string): Promise<boolean> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.log.error('askForMediaAccess failed: no mediaDevices')
      return Promise.resolve(false)
      // ponytail: upstream inverted this test ('!== microphone'), which sent
      // every real mic request to the "not implemented" branch below.
    } else if (mediaType === 'microphone' || mediaType === 'camera') {
      // request-then-stop just primes the permission; callers (voice message
      // recorder, QR reader) open their own stream afterwards
      return navigator.mediaDevices
        .getUserMedia(mediaType === 'camera' ? { video: true } : { audio: true })
        .then(
          stream => {
            stream.getTracks().forEach(track => track.stop())
            return true
          },
          err => {
            this.log.error(`askForMediaAccess "${mediaType}" failed`, err)
            return false
          }
        )
    } else {
      this.log.error(
        `askForMediaAccess failed: mediaType "${mediaType}" not implemented`
      )
      return Promise.resolve(false)
    }
  }
}

;(window as any).r = new BrowserRuntime()

// --- WS→TCP bridge reachability notice -------------------------------------
// The wasm core can only send/receive through a reachable WS→TCP bridge
// (packages/ws-tcp-proxy). If it's down, IMAP/SMTP just fail with an opaque
// error, which is baffling on first start. Surface it as a clickable warning
// toast (vanilla DOM, so it stays out of the byte-identical bundle.js) that
// opens a small dialog: how to start the bridge, or point at an alternative one
// (saved by appending ?proxy= to the URL, as the app already reads on boot).
//
// ponytail: edit BRIDGE_HELP_URL to your repo if you fork this.
const BRIDGE_HELP_URL =
  'https://github.com/experintellia/slothfulchat-web/tree/main/packages/ws-tcp-proxy'

// priority: ?proxy= > saved > per-instance default (assemble.mjs) > localhost.
// The one resolver for both the actual connection (getCore) and the
// probe/toast/picker UI below — they must agree on the URL in use.
function resolveBridgeUrl(): string {
  const params = new URLSearchParams(location.search)
  return (
    params.get('proxy') ||
    localStorage.getItem(PROXY_KEY) ||
    (window as any).__slothfulConfig?.defaultProxyUrl ||
    DEFAULT_LOCAL_BRIDGE
  )
}

// for option dedupe/matching only — the raw URL is what gets stored/connected
const normBridgeUrl = (u: string): string => u.trim().replace(/\/+$/, '')

/** Options offered in the bridge picker: localhost always first, then the
 * instance default (unless the operator's public list already covers it — the
 * operator's description wins then), then the public bridges baked into
 * config.js (SLOTHFUL_PUBLIC_BRIDGES). Deduped by normalized URL. */
function bridgeOptions(): { url: string; description: string }[] {
  const options = [
    {
      url: DEFAULT_LOCAL_BRIDGE,
      description: 'Local bridge on this device — most private and secure',
    },
  ]
  const cfg = (window as any).__slothfulConfig ?? {}
  const seen = new Set(options.map(o => normBridgeUrl(o.url)))
  const publicBridges: { url?: string; description?: string }[] =
    Array.isArray(cfg.publicBridges) ? cfg.publicBridges : []
  for (const bridge of publicBridges) {
    // defensive: config.js may be hand-edited in a customized release zip
    if (!bridge?.url || seen.has(normBridgeUrl(bridge.url))) continue
    seen.add(normBridgeUrl(bridge.url))
    options.push({ url: bridge.url, description: bridge.description || '' })
  }
  if (cfg.defaultProxyUrl && !seen.has(normBridgeUrl(cfg.defaultProxyUrl))) {
    options.splice(1, 0, {
      url: cfg.defaultProxyUrl,
      description: 'Default bridge of this instance',
    })
  }
  return options
}

/** Reachable = a WS to the bridge's /dns health endpoint opens (it replies with
 * JSON then closes). Down = error/close before open, or timeout. */
function probeBridge(url: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise(resolve => {
    let ws: WebSocket
    try {
      ws = new WebSocket(url.replace(/\/$/, '') + '/dns/localhost')
    } catch {
      resolve(false)
      return
    }
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* already closing */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    ws.onopen = () => finish(true)
    ws.onmessage = () => finish(true)
    ws.onerror = () => finish(false)
    ws.onclose = () => finish(false)
  })
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  Object.assign(node.style, style)
  if (text != null) node.textContent = text
  return node
}

/** Blocking full-screen dialog for fatal core-worker states (nothing works,
 * only reload can help). Not dismissable. */
function showFatalDialog(id: string, titleText: string, bodyText: string) {
  if (document.getElementById(id)) return
  const overlay = el('dialog', {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    maxWidth: 'none',
    maxHeight: 'none',
    margin: '0',
    padding: '0',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,.5)',
  })
  overlay.id = id
  overlay.oncancel = e => e.preventDefault() // Esc must not reveal a dead app

  const panel = el('div', {
    width: 'min(400px, 92vw)',
    padding: '20px',
    borderRadius: '10px',
    background: '#1e1e1e',
    color: '#eee',
    font: '14px/1.5 system-ui, sans-serif',
    boxShadow: '0 8px 40px rgba(0,0,0,.5)',
  })
  const title = el('h2', { margin: '0 0 8px', fontSize: '17px' }, titleText)
  const body = el('p', { margin: '0 0 12px', color: '#bbb' }, bodyText)
  const row = el('div', { display: 'flex', justifyContent: 'flex-end', marginTop: '16px' })
  const retryBtn = el(
    'button',
    {
      padding: '8px 14px',
      borderRadius: '6px',
      border: 'none',
      cursor: 'pointer',
      fontSize: '13px',
      background: '#2d7dff',
      color: '#fff',
    },
    'Retry'
  )
  retryBtn.onclick = () => location.reload()
  row.append(retryBtn)
  panel.append(title, body, row)
  overlay.append(panel)
  document.body.appendChild(overlay)
  overlay.showModal()
}

const WEBXDC_ISSUE_URL =
  'https://github.com/experintellia/slothfulchat-web/issues/2'

/** Webxdc apps can't run yet in the wasm edition (needs a separate-origin
 * sandboxed host, see WEBXDC_ISSUE_URL). Native <dialog>+showModal() so it
 * lands above the app's own top-layer modals (same trick as the bridge
 * dialog). */
function showWebxdcNotImplementedDialog() {
  if (document.getElementById('sc-webxdc-dialog')) return
  const overlay = el('dialog', {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    maxWidth: 'none',
    maxHeight: 'none',
    margin: '0',
    padding: '0',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,.5)',
  })
  overlay.id = 'sc-webxdc-dialog'
  overlay.onclose = () => overlay.remove()

  const panel = el('div', {
    width: 'min(400px, 92vw)',
    padding: '20px',
    borderRadius: '10px',
    background: '#1e1e1e',
    color: '#eee',
    font: '14px/1.5 system-ui, sans-serif',
    boxShadow: '0 8px 40px rgba(0,0,0,.5)',
  })
  const title = el('h2', { margin: '0 0 8px', fontSize: '17px' }, 'Webxdc apps')
  const body = el(
    'p',
    { margin: '0 0 12px', color: '#bbb' },
    'Running webxdc apps is not implemented (yet) in this browser edition.'
  )
  const link = el('a', { color: '#4ea1ff', fontSize: '13px' }, 'Follow the GitHub issue →')
  ;(link as HTMLAnchorElement).href = WEBXDC_ISSUE_URL
  ;(link as HTMLAnchorElement).target = '_blank'
  ;(link as HTMLAnchorElement).rel = 'noopener noreferrer'

  const row = el('div', { display: 'flex', justifyContent: 'flex-end', marginTop: '16px' })
  const closeBtn = el(
    'button',
    {
      padding: '8px 14px',
      borderRadius: '6px',
      border: 'none',
      cursor: 'pointer',
      fontSize: '13px',
      background: '#2d7dff',
      color: '#fff',
    },
    'Close'
  )
  closeBtn.onclick = () => overlay.remove()
  row.append(closeBtn)
  panel.append(title, body, link, row)
  overlay.append(panel)
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove()
  }
  document.body.appendChild(overlay)
  overlay.showModal()
}

// --- Native 1:1 calls (audio, M1) ------------------------------------------
// The runtime side of packages/calls: subscribe to the core's call events on
// the in-page emitter (getCore().dc), and drive the engine (via the bridge)
// against the typed jsonrpc client. Ringing + in-call UI is our own React
// tree from packages/calls/ui — the incoming-ring dialog and the in-page call
// overlay (hangup, mute) — mounted once (`mountCallsUi`) into the main window
// (docs/calls.md: "Ringing always renders in the main window … can never be
// popup-blocked"). `CallManager` below owns no DOM itself: it only pushes
// state into the shared `CallsUiStore` that the mounted React tree observes —
// including, as of M2, the `onLocalLevel`/`onRemoteLevel` Web-Audio meter
// callbacks that drive the per-participant speaking rings in `CallOverlay`,
// and the mic/camera `DevicePicker` (enumerate once the local stream exists,
// hot-switch the mic mid-call via `CallBridge.switchMicrophone` ->
// `RTCRtpSender.replaceTrack` — no renegotiation, see `AudioCallEngine`'s
// "DEVICE HOT-SWITCHING" doc). The detached popup window + signaling IPC (M4)
// builds on top of this same seam later.

/** `${accountId}` scoping is implicit (one call at a time in M1). */
class CallManager {
  private readonly log: Logger
  private readonly factories = defaultMediaFactories()
  /** The single shared call-UI store; the React tree mounted by
   * `mountCallsUi` observes it and re-renders on every push below. */
  private readonly ui = new CallsUiStore()
  private get rpc(): CallsRpcClient {
    // The real generated RawClient is structurally a CallsRpcClient.
    return getCore().dc.rpc as unknown as CallsRpcClient
  }
  /** Whether to prefer a detached popup window for the active call (M4). The
   * ring always stays in the main window regardless; this only governs where
   * the *in-call* engine+UI live. Popup failures fall back to the overlay, so
   * this stays `true` — a hook for a future "always overlay" setting. */
  private readonly popupPreferred = true
  /** The single active call (M1: one at a time). */
  private call: {
    accountId: number
    chatId: number
    /** M4: outgoing vs incoming — needed by the popup handoff / fallback,
     * which (unlike the M1 overlay path) can re-derive the call from the slot. */
    direction: CallDirection
    hasVideo: boolean
    /** Best-effort chat/contact name (resolved by `decorateTitle`). */
    title: string
    /** Incoming: the caller's raw-SDP offer, retained so an accept can build a
     * `CallBridge` (overlay) or hand it to the popup (`CallPopupInit.offerSdp`). */
    offerSdp: string | null
    /** Incoming: the info-message id (known from the `IncomingCall` event, so
     * events route even before the ringing bridge exists). Outgoing: `null`
     * until placed — then read off `bridge`/`popup` instead. */
    callMessageId: number | null
    /** M4: where the in-call engine+UI live. `overlay` = main-window `CallBridge`
     * + `CallsUiStore` (M1 path); `popup` = a detached `CallPopupHost` relays
     * signaling to the popup's own engine (this window shows nothing). */
    mode: 'overlay' | 'popup'
    bridge: CallBridge | null
    /** M4: set in `popup` mode — the opener-side relay to the detached window. */
    popup: CallPopupHost | null
    cancelled: boolean
    /** Set when a fatal error is being shown, to keep the UI up. */
    errored: boolean
    /** M2: guards `refreshDevices` running more than once per call — it's
     * driven off every `onState` tick (there is no dedicated "local stream
     * ready" runtime event; the engine-level one, `onLocalTrackChanged`, is
     * consumed by the bridge's level-meter retap, not surfaced here). */
    devicesRefreshed: boolean
    /** M5 call-outcome analytics (docs/calls.md: "missed/busy/timeout … via
     * call_info"): whether this call's `CallState` was ever observed reaching
     * `connected` — in EITHER mode: the overlay path sets it directly
     * (`onState`); a popup-mode call sets it from the popup's own report
     * (`CallPopupHost.onEnded`'s `reachedConnected`), since the popup owns the
     * engine and this window's `onState`/`onError` are no-ops while
     * `mode === 'popup'`. */
    connectedOnce: boolean
    /** Set the moment WE decide to end the call ourselves before it ever
     * connected (`hangupCurrent`) — that is an unambiguous local
     * declined/cancelled, never worth an extra `call_info` round-trip. */
    locallyEnded: boolean
    /** `reportCallOutcome` fires at most once per call; also set (without a
     * result) when the outcome genuinely isn't this device's to report — the
     * call was accepted on ANOTHER device (`IncomingCallAccepted{
     * from_this_device:false}`), which is a real connect, just not one this
     * session should claim. */
    outcomeReported: boolean
  } | null = null
  /** The shared ringtone/vibration for an incoming ring (M5, docs/calls.md).
   * Ringing always renders in the main window regardless of popup preference
   * (see the §Windowing note above), so one instance here covers every call. */
  private readonly ringtone = new RingtonePlayer()
  /** M2: live device-list refresh while a call is up (e.g. a mic/camera is
   * plugged/unplugged mid-call) — registered in `startOutgoingCall`/
   * `openIncomingCall`, torn down in `teardown`. */
  private deviceChangeHandler: (() => void) | null = null

  constructor(log: Logger) {
    this.log = log
    mountCallsUi(this.ui, {
      onAccept: () => this.acceptCurrent(),
      onHangup: () => this.hangupCurrent(),
      onToggleMute: () => this.toggleMuteCurrent(),
      onSelectMicrophone: deviceId => this.selectMicrophone(deviceId),
      onSelectCamera: deviceId => this.selectCamera(deviceId),
      onToggleScreenShare: () => this.toggleScreenShareCurrent(),
    })
    this.subscribe()
  }

  private subscribe(): void {
    const dc = getCore().dc
    dc.on('IncomingCall', (accountId, event) => {
      this.log.info('IncomingCall', accountId, event.msg_id)
      this.openIncomingCall({
        accountId,
        chatId: event.chat_id,
        callMessageId: event.msg_id,
        callerWebrtcOffer: event.place_call_info,
        startWithCameraEnabled: event.has_video,
      })
    })
    dc.on('OutgoingCallAccepted', (accountId, event) => {
      this.log.info('OutgoingCallAccepted', accountId, event.msg_id)
      const slot = this.slotForCall(accountId, event.msg_id)
      if (slot == null) return
      // Route the peer's answer to wherever the engine lives: relay it to the
      // detached popup (M4), or feed the main-window overlay bridge (M1).
      if (slot.mode === 'popup') slot.popup?.forwardAnswer(event.accept_call_info)
      else slot.bridge?.provideAnswer(event.accept_call_info)
    })
    dc.on('IncomingCallAccepted', (accountId, event) => {
      this.log.info('IncomingCallAccepted', accountId, event.msg_id, event.from_this_device)
      // Accepted on ANOTHER device while still ringing here → stop our ring.
      if (event.from_this_device) return
      const slot = this.slotForCall(accountId, event.msg_id)
      // Only meaningful while still ringing (main-window overlay, pre-accept);
      // in popup mode the call is already accepted here, so ignore.
      if (slot == null || slot.mode !== 'overlay') return
      // M5 call-outcome analytics: this call WAS answered — just not by this
      // device/session, so it is not this device's outcome to report (the
      // device that actually accepted it reports 'connected' itself).
      // Suppress before the eventual teardown (sync here, or async via
      // `onState`'s 'ended' handling below) reaches `reportCallOutcome`.
      slot.outcomeReported = true
      if (slot.bridge) {
        if (slot.bridge.state === 'ringing') slot.bridge.acceptedElsewhere()
      } else {
        // Ring not yet backed by a bridge (still fetching ICE) — drop it.
        slot.cancelled = true
        this.teardown(slot)
      }
    })
    dc.on('CallEnded', (accountId, event) => {
      this.log.info('CallEnded', accountId, event.msg_id)
      const slot = this.slotForCall(accountId, event.msg_id)
      if (slot == null) return
      if (slot.mode === 'popup') slot.popup?.forwardRemoteEnded()
      else if (slot.bridge) slot.bridge.remoteEnded()
      else {
        // The caller hung up while we were still setting up the ringing bridge.
        slot.cancelled = true
        this.teardown(slot)
      }
    })
  }

  /** The active call slot iff it matches this (account, message) — else null.
   * The message id is known from the slot itself for an incoming call (routes
   * events even before the ringing bridge exists), and from the popup host or
   * the overlay bridge once an outgoing call has been placed. */
  private slotForCall(accountId: number, msgId: number): NonNullable<CallManager['call']> | null {
    const c = this.call
    if (c == null || c.accountId !== accountId) return null
    const id = c.callMessageId ?? c.popup?.callMessageId ?? c.bridge?.callMessageId ?? null
    return id === msgId ? c : null
  }

  startOutgoingCall(accountId: number, chatId: number, hasVideo = false): void {
    if (this.call) {
      this.log.warn('startOutgoingCall: already in a call, ignoring')
      return
    }
    const slot: NonNullable<CallManager['call']> = {
      accountId,
      chatId,
      direction: 'outgoing',
      hasVideo,
      title: 'Call',
      offerSdp: null,
      callMessageId: null,
      mode: 'overlay',
      bridge: null,
      popup: null,
      cancelled: false,
      errored: false,
      devicesRefreshed: false,
      connectedOnce: false,
      locallyEnded: false,
      outcomeReported: false,
    }
    this.call = slot
    // M4: prefer a detached popup (window.open must run in this click gesture).
    // A synchronous popup-block returns false → fall straight through to the
    // in-page overlay while still gesture-authorized for getUserMedia.
    if (this.tryStartPopup(slot)) return
    this.startOutgoingOverlay(slot)
  }

  /** Outgoing call in the main-window overlay (M1 path): fetch ICE, build the
   * `CallBridge`, place the offer. Used when the popup is blocked/unavailable. */
  private startOutgoingOverlay(slot: NonNullable<CallManager['call']>): void {
    slot.mode = 'overlay'
    this.ui.showCall({ direction: 'outgoing', title: slot.title, hasVideo: slot.hasVideo })
    this.registerDeviceChangeListener(slot)
    void (async () => {
      try {
        const iceServers = await fetchIceServers(this.rpc, slot.accountId)
        if (slot.cancelled || slot.mode !== 'overlay') return
        const bridge = CallBridge.outgoing(
          this.rpc,
          { accountId: slot.accountId, chatId: slot.chatId, hasVideo: slot.hasVideo, iceServers },
          this.factories,
          this.overlayBridgeCallbacks(slot)
        )
        slot.bridge = bridge
        void this.decorateTitle(slot.accountId, slot.chatId) // fire-and-forget (cosmetic)
        await bridge.start()
      } catch (err) {
        this.log.error('startOutgoingCall failed', err)
        this.onError(slot, err instanceof Error ? err : new Error(String(err)))
      }
    })()
  }

  /** The overlay-mode bridge callbacks (identical for outgoing + incoming):
   * push engine state/streams/meters/errors into the shared main-window store.
   * In popup mode the popup wires its OWN equivalents (`src/call-popup.ts`). */
  private overlayBridgeCallbacks(slot: NonNullable<CallManager['call']>): CallBridgeCallbacks {
    return {
      onStateChange: state => this.onState(slot, state),
      onRemoteStream: stream => this.ui.attachRemoteStream(stream),
      // Event routing reads the message id off bridge/popup/slot (set the
      // moment placeOutgoingCall resolves), so no onCallMessageId indexing.
      onError: err => this.onError(slot, err),
      // M2 speaking rings: forward the bridge's Web-Audio meters into the
      // shared store; CallOverlay's SpeakingRing tiles render them.
      onLocalLevel: level => this.ui.setLocalLevel(level),
      onRemoteLevel: level => this.ui.setRemoteLevel(level),
      // M5: non-blocking direct-vs-relay indicator (docs/calls.md) — purely
      // informational, forwarded straight into the shared store.
      onConnectionRouteChanged: route => this.ui.setConnectionRoute(route),
      // M2 device picker: a failed switchMicrophone/switchCamera leaves the
      // call/old device untouched — surface it next to the picker, not as a
      // call-ending error (contrast onError above).
      onDeviceSwitchError: err => this.ui.showDeviceSwitchError(err.message || 'Could not switch device'),
      // M3: local video preview + screen-share toggle state.
      onLocalVideoTrackChanged: () => this.ui.setLocalStream(slot.bridge?.localStream ?? null),
      onScreenShareChanged: sharing => this.ui.setScreenSharing(sharing),
      onScreenShareError: err => this.ui.showScreenShareError(err.message || 'Could not share screen'),
    }
  }

  openIncomingCall(params: {
    accountId: number
    chatId: number
    callMessageId: number
    callerWebrtcOffer: string
    startWithCameraEnabled: boolean
  }): void {
    const { accountId, chatId, callMessageId, callerWebrtcOffer, startWithCameraEnabled: hasVideo } = params
    // Same call already showing (event + Message.tsx button both call in).
    if (this.slotForCall(accountId, callMessageId)) return
    if (this.call) {
      // M5 (docs/calls.md: "busy … via call_info"): we only ever run one call
      // at a time, so a second incoming call is auto-declined rather than
      // left to ring the caller out silently — real telephony "busy". There
      // is no core call-state for this (core only knows the callee explicitly
      // declined or let it time out); it is a purely local, this-device
      // classification, reported immediately (no ambiguity to resolve via
      // `call_info` — we caused the decline ourselves, right now).
      this.log.warn('openIncomingCall: already in a call, declining as busy')
      this.rpc.endCall(accountId, callMessageId).catch(() => {
        /* best-effort — the caller's own ring timeout is the fallback */
      })
      analytics.trackCall({ direction: 'incoming', hasVideo, result: 'busy' })
      return
    }
    // Ringing ALWAYS renders in the main window (docs/calls.md §Windowing) — the
    // popup is only opened on accept (see acceptCurrent). The ringing engine
    // lives in the overlay bridge; it holds no media/pc yet (mic is untouched
    // until accept), so handing it off to a popup later is cheap.
    this.ui.showCall({ direction: 'incoming', title: 'Call', hasVideo })
    const slot: NonNullable<CallManager['call']> = {
      accountId,
      chatId,
      direction: 'incoming',
      hasVideo,
      title: 'Call',
      offerSdp: callerWebrtcOffer,
      callMessageId,
      mode: 'overlay',
      bridge: null,
      popup: null,
      cancelled: false,
      errored: false,
      devicesRefreshed: false,
      connectedOnce: false,
      locallyEnded: false,
      outcomeReported: false,
    }
    this.call = slot
    this.ringtone.start()
    this.registerDeviceChangeListener(slot)

    void (async () => {
      try {
        const iceServers = await fetchIceServers(this.rpc, accountId)
        // Bail if cancelled, or if the user already accepted and we handed the
        // call off to a popup while this ICE fetch was in flight.
        if (slot.cancelled || slot.mode !== 'overlay') return
        const bridge = this.newIncomingBridge(slot, iceServers)
        slot.bridge = bridge
        void this.decorateTitle(accountId, chatId) // fire-and-forget (cosmetic)
        await bridge.start()
      } catch (err) {
        this.log.error('openIncomingCall failed', err)
        this.onError(slot, err instanceof Error ? err : new Error(String(err)))
      }
    })()
  }

  /** Build an overlay-mode incoming `CallBridge` from the slot's retained
   * offer/params. Shared by the ring setup and the popup→overlay fallback. */
  private newIncomingBridge(
    slot: NonNullable<CallManager['call']>,
    iceServers: RTCIceServer[]
  ): CallBridge {
    return CallBridge.incoming(
      this.rpc,
      {
        accountId: slot.accountId,
        chatId: slot.chatId,
        callMessageId: slot.callMessageId ?? 0,
        offerSdp: slot.offerSdp ?? '',
        hasVideo: slot.hasVideo,
        iceServers,
      },
      this.factories,
      this.overlayBridgeCallbacks(slot)
    )
  }

  private acceptCurrent(): void {
    const c = this.call
    if (!c || c.direction !== 'incoming' || c.mode === 'popup') return
    // The ring is answered — silence it regardless of which path (popup
    // handoff or overlay) takes over from here.
    this.ringtone.stop()
    // M4: prefer handing the accepted call to a detached popup. The accept
    // click is a user gesture, so window.open is allowed here.
    if (c.offerSdp != null && this.tryStartPopup(c)) {
      // Discard the main-window ringing engine (no media/pc/accept sent yet);
      // slot.mode is now 'popup', so its 'ended' state change is ignored.
      const ringing = c.bridge
      c.bridge = null
      ringing?.remoteEnded()
      return
    }
    // Overlay accept (popup blocked/disabled, or bridge not ready yet).
    if (!c.bridge) return
    c.bridge.accept().catch(err => {
      this.log.error('accept failed', err)
      this.onError(c, err instanceof Error ? err : new Error(String(err)))
    })
  }

  private hangupCurrent(): void {
    const c = this.call
    if (!c) return
    // M5 call-outcome analytics: a hangup we initiate ourselves — before ever
    // connecting — is an unambiguous local decline/cancel (see
    // `reportCallOutcome`), never worth a `call_info` round-trip. A call that
    // already connected (or already errored) ignores this flag entirely.
    c.locallyEnded = true
    if (c.mode === 'popup') {
      // Rare from the main window (it shows no in-call UI in popup mode), but
      // e.g. app teardown can reach here: end the call from the opener side.
      const msgId = c.callMessageId ?? c.popup?.callMessageId ?? null
      if (msgId != null) this.rpc.endCall(c.accountId, msgId).catch(() => {})
      this.teardown(c)
      return
    }
    // Tell the far end + tear down the engine (idempotent). If the bridge does
    // not exist yet (hung up during ICE fetch), mark the async setup cancelled.
    if (c.bridge) c.bridge.hangup()
    else c.cancelled = true
    // Always drop the UI now — do not wait on the engine's 'ended' emit, which
    // is a no-op if the engine already ended (error Close button, double tap).
    this.teardown(c)
  }

  /** Mute is a local-only `track.enabled` toggle on the engine, so it needs
   * no core RPC — see `AudioCallEngine.setMuted`. */
  private toggleMuteCurrent(): void {
    const c = this.call
    if (!c?.bridge) return
    this.ui.setMuted(c.bridge.toggleMuted())
  }

  /** Toggle screen sharing (M3) — local-only, no core RPC (same
   * `replaceTrack`, no-renegotiation reasoning as mute/device switching); see
   * `AudioCallEngine.startScreenShare`/`stopScreenShare`. The store's
   * `screenSharing`/`screenShareError` fields are kept live by the bridge's
   * `onScreenShareChanged`/`onScreenShareError` callbacks (wired in
   * `startOutgoingCall`/`openIncomingCall`), not by this method's return
   * value — `toggleScreenShare` does real async capture/track work, so the
   * store must reflect the eventual outcome, not an optimistic guess.
   */
  private toggleScreenShareCurrent(): void {
    const c = this.call
    if (!c?.bridge) return
    c.bridge.toggleScreenShare().catch(err => {
      this.log.error('toggleScreenShare failed', err)
    })
  }

  private onState(
    slot: NonNullable<CallManager['call']>,
    state: CallState
  ): void {
    // Only the overlay path drives the main-window store; in popup mode the
    // popup owns its own UI, and a discarded ringing bridge's late 'ended' (on
    // handoff) must not touch anything here.
    if (this.call !== slot || slot.mode !== 'overlay') return
    this.ui.setState(state)
    // M5 call-outcome analytics: remember reaching `connected` at all, even if
    // the call later ends for any reason — a call that connected is always
    // reported as 'connected', never re-classified via `call_info`.
    if (state === 'connected') slot.connectedOnce = true
    // M2 device picker: refresh once the local stream exists — i.e. once we
    // are past `ringing` for an outgoing call (mic acquired to build the
    // offer) or reach `connecting` for an incoming one (mic acquired on
    // accept). `devicesRefreshed` makes this a one-shot per call; a
    // `devicechange` event (see `registerDeviceChangeListener`) re-enumerates
    // later without touching the one-shot selected-device seeding below.
    if (!slot.devicesRefreshed && (state === 'connecting' || state === 'connected')) {
      slot.devicesRefreshed = true
      void this.refreshDevices(slot, { seedSelectedMicrophone: true })
    }
    if (state === 'ended') {
      // The engine also ends autonomously (pc failed/closed, remote CallEnded).
      // Defer so an onError firing synchronously right after end() can flip
      // `errored` first and keep the UI up with its error + Close button.
      queueMicrotask(() => {
        if (this.call === slot && !slot.errored) this.teardown(slot)
      })
    }
  }

  private onError(slot: NonNullable<CallManager['call']>, error: Error): void {
    // Symmetric with onState: only the overlay path owns the main-window store.
    // In popup mode the popup surfaces its own errors; an overlay-callback error
    // here would otherwise paint an error into the (cleared) main window.
    if (this.call !== slot || slot.mode !== 'overlay') return
    slot.errored = true
    this.ui.showError(error.message || 'Call failed')
    // UI stays up (with a Close button → hangupCurrent → teardown).
  }

  private teardown(slot: NonNullable<CallManager['call']>): void {
    if (this.call !== slot) return
    this.call = null
    // The ring (if any) is over one way or another — idempotent (a no-op if
    // already stopped, e.g. by `acceptCurrent`).
    this.ringtone.stop()
    this.reportCallOutcome(slot)
    // M4: close the detached popup (idempotent — a popup that ended itself has
    // already torn its host down). Opener-initiated close does NOT re-send
    // endCall; the popup relayed its own on hangup, and remote/abrupt-close
    // paths are handled inside CallPopupHost.
    slot.popup?.close()
    slot.popup = null
    this.ui.clear()
    this.unregisterDeviceChangeListener()
  }

  /**
   * M5 call-outcome analytics (docs/calls.md: "content-free call analytics …
   * missed/busy/timeout via call_info"). The single choke point: every
   * teardown path funnels through here exactly once per call
   * (`outcomeReported` guards it), classifying WHY the call ended without
   * ever recording anything but the fixed `CallResult` bucket:
   *
   *   1. Already reported, or explicitly suppressed (accepted on another
   *      device — a real connect, just not this session's to claim): no-op.
   *   2. Reached `connected` at any point — locally (overlay) or as reported
   *      by the popup's own engine (`connectedOnce`, set from either path):
   *      'connected', regardless of how (or how badly) it ended afterwards —
   *      a later fatal error on an already-connected call is still a call
   *      that connected, so this is checked BEFORE `errored`.
   *   3. A local engine failure that tore the call down before it ever
   *      connected (`slot.errored`): 'error'.
   *   4. We ourselves ended it before connecting (`locallyEnded`): 'declined'
   *      (incoming) or 'cancelled' (outgoing) — unambiguous, no `call_info`
   *      needed.
   *   5. Otherwise: something else ended it (far end, timeout, a setup
   *      failure before any message existed) — the genuinely ambiguous case
   *      this method exists for. If a call message exists, ask core via
   *      `call_info` and classify with `classifyCallOutcome`; if not (the
   *      call never even reached `placeOutgoingCall`), fall back to the same
   *      safe per-direction default `classifyCallOutcome` would have picked.
   */
  private reportCallOutcome(slot: NonNullable<CallManager['call']>): void {
    if (slot.outcomeReported) return
    slot.outcomeReported = true
    const { direction, hasVideo } = slot
    const report = (result: CallResult) => analytics.trackCall({ direction, hasVideo, result })

    if (slot.connectedOnce) {
      report('connected')
      return
    }
    if (slot.errored) {
      report('error')
      return
    }
    if (slot.locallyEnded) {
      report(direction === 'incoming' ? 'declined' : 'cancelled')
      return
    }
    const msgId = slot.callMessageId ?? slot.bridge?.callMessageId ?? slot.popup?.callMessageId ?? null
    if (msgId == null) {
      // Never reached core (e.g. the ICE fetch itself failed before
      // `placeOutgoingCall`/an offer existed) — nothing for `call_info` to
      // look up; use the same safe default it would classify an unexpected
      // state as, for this direction.
      report(direction === 'incoming' ? 'missed' : 'timeout')
      return
    }
    this.rpc.callInfo(slot.accountId, msgId).then(
      info => report(classifyCallOutcome(direction, info.state)),
      err => {
        this.log.warn('reportCallOutcome: call_info failed', err)
        report(direction === 'incoming' ? 'missed' : 'timeout')
      }
    )
  }

  // ── M4: detached popup window (docs/calls.md §Windowing) ─────────────────────

  /** Whether to attempt a detached popup for the active call. */
  private popupEnabled(): boolean {
    return (
      this.popupPreferred &&
      typeof window !== 'undefined' &&
      typeof window.open === 'function'
    )
  }

  /**
   * Try to open the detached call popup for `slot`. Returns `true` if the popup
   * window opened (we're now in popup mode — the popup runs the engine+UI and
   * relays signaling here); `false` if popups are disabled or `window.open` was
   * blocked (the caller falls back to the overlay synchronously, still inside
   * the user gesture). A popup that opens but never handshakes triggers
   * `onFallback` → {@link onPopupFallback} asynchronously.
   */
  private tryStartPopup(slot: NonNullable<CallManager['call']>): boolean {
    if (!this.popupEnabled()) return false
    const init: CallPopupInit = {
      direction: slot.direction,
      accountId: slot.accountId,
      chatId: slot.chatId,
      hasVideo: slot.hasVideo,
      callMessageId: slot.callMessageId,
      offerSdp: slot.offerSdp,
      title: slot.title,
    }
    const host = openCallPopup(init, {
      rpc: this.rpc,
      onReady: () => this.log.info('call popup ready'),
      onEnded: reachedConnected => {
        // M5 call-outcome analytics: the popup's engine — not this window's
        // (`onState` is a no-op while `mode === 'popup'`) — is the only place
        // that knows whether the call actually connected; take its word for it.
        if (reachedConnected) slot.connectedOnce = true
        if (this.call === slot) this.teardown(slot)
      },
      onFallback: reason => this.onPopupFallback(slot, reason),
    })
    if (host == null) return false // popup-blocked → synchronous overlay fallback
    slot.mode = 'popup'
    slot.popup = host
    // The popup owns the visible call UI now: drop any main-window ring/overlay
    // and its device listener (the popup handles its own device hotplug).
    this.ui.clear()
    this.unregisterDeviceChangeListener()
    return true
  }

  /**
   * The popup opened but never handshaked (blank/failed page) — recover by
   * running the call in the main-window overlay instead. Best-effort: by now
   * the original gesture is stale, but a granted mic permission does not need a
   * fresh gesture on most browsers.
   */
  private onPopupFallback(slot: NonNullable<CallManager['call']>, reason: string): void {
    if (this.call !== slot) return
    this.log.warn(`call popup unavailable (${reason}); falling back to overlay`)
    slot.popup = null
    slot.mode = 'overlay'
    if (slot.direction === 'outgoing') this.startOutgoingOverlay(slot)
    else this.startIncomingOverlayAccept(slot)
  }

  /**
   * Resume an already-accepted incoming call in the overlay (popup fallback):
   * re-show the call UI, build the incoming bridge, and go straight to building
   * the answer — the user accepted in the ring, so there is no second prompt.
   * Ordered so the ringing→connecting transitions land synchronously and the
   * accept/decline dialog never flashes.
   */
  private startIncomingOverlayAccept(slot: NonNullable<CallManager['call']>): void {
    slot.mode = 'overlay'
    this.registerDeviceChangeListener(slot)
    void (async () => {
      try {
        const iceServers = await fetchIceServers(this.rpc, slot.accountId)
        if (slot.cancelled || slot.mode !== 'overlay') return
        this.ui.showCall({ direction: 'incoming', title: slot.title, hasVideo: slot.hasVideo })
        const bridge = this.newIncomingBridge(slot, iceServers)
        slot.bridge = bridge
        void this.decorateTitle(slot.accountId, slot.chatId)
        // start() (sync: register offer, ringing) then accept() (sync: →
        // connecting, then async mic) run back-to-back so the store is already
        // past 'ringing' before React paints — no incoming-ring flash.
        void bridge.start()
        void bridge.accept().catch(err => {
          this.log.error('accept failed', err)
          this.onError(slot, err instanceof Error ? err : new Error(String(err)))
        })
      } catch (err) {
        this.onError(slot, err instanceof Error ? err : new Error(String(err)))
      }
    })()
  }

  /**
   * M2 device picker: enumerate mic/camera options and push them into the
   * store. `seedSelectedMicrophone` additionally reads the ACTUAL device in
   * use off the local track's `getSettings().deviceId` (real browser default
   * selection, e.g. "communications" device — not necessarily
   * `microphones[0]`) so the `<select>` opens pre-selected on the right
   * option rather than defaulting to the first enumerated entry.
   */
  private async refreshDevices(
    slot: NonNullable<CallManager['call']>,
    options: { seedSelectedMicrophone: boolean }
  ): Promise<void> {
    const devices = await listInputDevices()
    if (this.call !== slot) return // call ended/replaced while enumerating
    this.ui.setDevices(devices)
    if (options.seedSelectedMicrophone) {
      const activeDeviceId = slot.bridge?.localStream?.getAudioTracks()[0]?.getSettings().deviceId
      if (activeDeviceId) this.ui.setSelectedMicrophone(activeDeviceId)
      // M3: seed the camera picker the same way, only when this call
      // actually has a live video track to read a deviceId off.
      const activeCameraId = slot.bridge?.localStream?.getVideoTracks()[0]?.getSettings().deviceId
      if (activeCameraId) this.ui.setSelectedCamera(activeCameraId)
    }
  }

  /** Hot-switch the mic (M2) — see `AudioCallEngine.switchMicrophone` for the
   * `RTCRtpSender.replaceTrack` mechanics and failure semantics (the call
   * keeps running on the old mic; `onDeviceSwitchError` surfaces the error). */
  private selectMicrophone(deviceId: string): void {
    const c = this.call
    if (!c?.bridge) return
    const bridge = c.bridge
    void bridge.switchMicrophone(deviceId).then(() => {
      if (this.call !== c) return // call ended/replaced while switching
      // A failure leaves `audioInputDeviceId` unchanged (still the old
      // device); only reflect the pick in the store once it actually took —
      // the onDeviceSwitchError callback above already surfaced the failure.
      if (bridge.audioInputDeviceId === deviceId) this.ui.setSelectedMicrophone(deviceId)
    })
  }

  /** Hot-switch the camera (M3) — see `AudioCallEngine.switchCamera` (mirrors
   * `selectMicrophone` exactly, including its "while screen-sharing this
   * just records a preference" no-op-on-the-wire case). */
  private selectCamera(deviceId: string): void {
    const c = this.call
    if (!c?.bridge) return
    const bridge = c.bridge
    void bridge.switchCamera(deviceId).then(() => {
      if (this.call !== c) return // call ended/replaced while switching
      if (bridge.videoInputDeviceId === deviceId) this.ui.setSelectedCamera(deviceId)
    })
  }

  /** Re-enumerate on `devicechange` (e.g. a mic/camera plugged/unplugged
   * mid-call) so the picker's option list stays live, not just a one-shot
   * snapshot from call start. Does not touch the current selection. */
  private registerDeviceChangeListener(slot: NonNullable<CallManager['call']>): void {
    this.unregisterDeviceChangeListener()
    const handler = () => {
      void this.refreshDevices(slot, { seedSelectedMicrophone: false })
    }
    navigator.mediaDevices.addEventListener('devicechange', handler)
    this.deviceChangeHandler = () => {
      navigator.mediaDevices.removeEventListener('devicechange', handler)
    }
  }

  private unregisterDeviceChangeListener(): void {
    this.deviceChangeHandler?.()
    this.deviceChangeHandler = null
  }

  /** Best-effort: label the UI with the chat name. */
  private async decorateTitle(accountId: number, chatId: number): Promise<void> {
    try {
      const chat = await getCore().dc.rpc.getBasicChatInfo(accountId, chatId)
      if (chat?.name) this.ui.setTitle(chat.name)
    } catch {
      /* keep the generic title */
    }
  }
}

let callManager: CallManager | null = null
/** Lazily create the single call manager (subscribes to call events on first use). */
function getCallManager(log: Logger): CallManager {
  if (!callManager) callManager = new CallManager(log)
  return callManager
}

function hideBridgeToast() {
  document.getElementById('sc-bridge-toast')?.remove()
}

function hideWelcomeHint() {
  document.getElementById('sc-bridge-hint')?.remove()
}

/** The toast is inert under the welcome screen's modal dialog (clicks can't
 * reach past a showModal), so also inject a clickable hint into the welcome
 * screen itself — inside the modal it stays interactive. Re-injected by the
 * poll if a React re-render wipes it. */
function showWelcomeHint() {
  if (document.getElementById('sc-bridge-hint')) return
  // Anchor on data-testid, NOT the CSS-module class name: production builds
  // minify local class names (welcomeScreenButtonGroup → "xo"), so a
  // [class*=...] selector silently matches nothing there. The testids come
  // from upstream's OnboardingScreen (create-account-button) and
  // InstantOnboardingScreen (login-button) button groups — re-check them on
  // every vendor rebase.
  const group = document.querySelector(
    '[data-testid="create-account-button"], [data-testid="login-button"]'
  )?.parentElement
  if (!group) return
  const hint = el(
    'button',
    {
      display: 'block',
      width: '100%',
      marginBottom: '8px',
      padding: '10px 14px',
      borderRadius: '8px',
      border: 'none',
      background: '#8a5a00',
      color: '#fff',
      font: '13px/1.4 system-ui, sans-serif',
      textAlign: 'center',
      cursor: 'pointer',
    },
    '⚠ Bridge not reachable — needed for standard accounts, but not for madmail webimap servers. Click to fix.'
  )
  hint.id = 'sc-bridge-hint'
  // The onboarding button group lives inside a <form>; a button with no type
  // defaults to type="submit", so without this the hint would also submit the
  // display-name form. It should only open the dialog.
  hint.type = 'button'
  hint.onclick = () => showBridgeDialog()
  group.prepend(hint)
}

function showBridgeToast() {
  if (document.getElementById('sc-bridge-toast')) return
  const toast = el(
    'div',
    {
      position: 'fixed',
      inset: 'auto',
      bottom: '16px',
      right: '16px',
      margin: '0',
      border: 'none',
      zIndex: '2147483647',
      maxWidth: '320px',
      padding: '10px 14px',
      borderRadius: '8px',
      background: '#8a5a00',
      color: '#fff',
      font: '13px/1.4 system-ui, sans-serif',
      boxShadow: '0 2px 12px rgba(0,0,0,.35)',
      cursor: 'pointer',
    },
    '⚠ Bridge not reachable — click to fix'
  )
  toast.id = 'sc-bridge-toast'
  toast.onclick = () => showBridgeDialog()
  document.body.appendChild(toast)
  // Upstream dialogs (welcome screen etc.) use showModal(), whose top layer
  // paints over any z-index — join it so the toast stays visible. Note it's
  // still inert while a modal is open; the welcome screen auto-opens the
  // bridge dialog instead (see checkBridge).
  if (toast.showPopover) {
    toast.popover = 'manual'
    toast.showPopover()
  }
}

function showBridgeDialog() {
  if (document.getElementById('sc-bridge-dialog')) return
  // A native <dialog> + showModal(), not a div: upstream's dialogs (welcome
  // screen etc.) are modal and live in the browser top layer, which paints
  // over any z-index. Opening ours last puts it above them and keeps it
  // interactive (topmost modal).
  const overlay = el('dialog', {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    maxWidth: 'none',
    maxHeight: 'none',
    margin: '0',
    padding: '0',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,.5)',
  })
  overlay.id = 'sc-bridge-dialog'
  // Escape closes the dialog without removing it; display:flex would keep it
  // visible, so drop it from the DOM entirely.
  overlay.onclose = () => overlay.remove()

  const panel = el('div', {
    width: 'min(460px, 92vw)',
    maxHeight: '90vh',
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: '20px',
    borderRadius: '10px',
    background: '#1e1e1e',
    color: '#eee',
    font: '14px/1.5 system-ui, sans-serif',
    boxShadow: '0 8px 40px rgba(0,0,0,.5)',
  })

  // neutral title: this dialog is opened both from the bridge-down toast and
  // from the connectivity view's Change… button (bridge may be up)
  const title = el('h2', { margin: '0 0 8px', fontSize: '17px' }, 'Bridge')
  const body = el(
    'p',
    { margin: '0 0 8px', color: '#bbb' },
    'Browsers can’t open direct connections to mail servers, so this app ' +
      'sends its traffic through a small bridge. That traffic is encrypted ' +
      'by default before it reaches the bridge — the bridge only passes it ' +
      'along and can’t read your messages. The most private option is a ' +
      'bridge running on your own device.'
  )

  // the one honest exception to "can't read it", kept out of the main copy
  // so the paragraph stays short — expandable for those who care
  const previewNote = el('details', { margin: '0 0 12px', fontSize: '12px', color: '#bbb' })
  const previewSummary = el(
    'summary',
    { cursor: 'pointer' },
    'One exception: link previews (opt-in)'
  )
  const previewBody = el(
    'p',
    { margin: '6px 0 0' },
    'If you turn on link previews, the bridge fetches the linked web page ' +
      'for you (most sites don’t let the browser fetch them directly), so ' +
      'it can see which pages you preview. This is only about link ' +
      'previews — your messages stay unreadable to the bridge.'
  )
  previewNote.append(previewSummary, previewBody)

  const list = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' })
  const radios: HTMLInputElement[] = []
  const rows: HTMLElement[] = []
  // selected card gets the accent border/tint; inline styles (no stylesheet),
  // so hover/selection are restyled from JS
  const restyleRows = () => {
    rows.forEach((r, i) => {
      r.style.borderColor = radios[i].checked ? '#2d7dff' : '#3a3a3a'
      r.style.background = radios[i].checked ? 'rgba(45,125,255,.12)' : '#262626'
    })
  }
  const mkRadio = (): HTMLInputElement => {
    const radio = el('input', {
      margin: '2px 10px 0 0',
      flexShrink: '0',
      width: '16px',
      height: '16px',
      accentColor: '#2d7dff',
    }) as HTMLInputElement
    radio.type = 'radio'
    radio.name = 'sc-bridge'
    radios.push(radio)
    return radio
  }
  const mkRow = (radio: HTMLInputElement, column: HTMLElement) => {
    const label = el('label', {
      display: 'flex',
      alignItems: 'flex-start',
      padding: '10px 12px',
      borderRadius: '8px',
      border: '1px solid #3a3a3a',
      background: '#262626',
      cursor: 'pointer',
      transition: 'border-color .15s, background-color .15s',
    })
    label.onmouseenter = () => {
      if (!radio.checked) label.style.borderColor = '#5a5a5a'
    }
    label.onmouseleave = restyleRows
    label.append(radio, column)
    list.append(label)
    rows.push(label)
    return label
  }

  const options = bridgeOptions()
  const current = normBridgeUrl(resolveBridgeUrl())
  for (const opt of options) {
    const radio = mkRadio()
    radio.value = opt.url
    if (normBridgeUrl(opt.url) === current) radio.checked = true
    const column = el('div', { flex: '1', minWidth: '0' })
    column.append(
      el(
        'div',
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '13px',
          wordBreak: 'break-all',
          color: '#e8e8e8',
        },
        opt.url
      )
    )
    if (opt.description) {
      column.append(
        el('div', { fontSize: '12px', color: '#a8a8a8', marginTop: '2px' }, opt.description)
      )
    }
    if (opt.url === DEFAULT_LOCAL_BRIDGE) {
      // "run it on your own device" made actionable, on the localhost option
      const NPX_CMD = 'npx @slothfulchat/ws-tcp-proxy'
      const startCmd = el(
        'pre',
        {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          margin: '8px 0 6px',
          padding: '6px 6px 6px 10px',
          borderRadius: '6px',
          background: '#161616',
          color: '#9cdcfe',
          whiteSpace: 'pre-wrap',
          fontSize: '12px',
        },
        NPX_CMD
      )
      const copyBtn = el(
        'button',
        {
          flexShrink: '0',
          padding: '3px 8px',
          borderRadius: '4px',
          border: '1px solid #444',
          background: '#2a2a2a',
          color: '#ccc',
          cursor: 'pointer',
          font: '11px system-ui, sans-serif',
        },
        'Copy'
      )
      // inside the option's <label>: type=button so it doesn't submit, and
      // clicks on it (an interactive element) don't toggle the radio
      copyBtn.type = 'button'
      copyBtn.onclick = () => {
        navigator.clipboard
          ?.writeText(NPX_CMD)
          .then(() => {
            copyBtn.textContent = 'Copied ✓'
            setTimeout(() => (copyBtn.textContent = 'Copy'), 1500)
          })
          .catch(() => {
            copyBtn.textContent = 'Copy failed'
          })
      }
      startCmd.append(copyBtn)
      const help = el('a', { color: '#4ea1ff', fontSize: '12px' }, 'Bridge setup & source →')
      ;(help as HTMLAnchorElement).href = BRIDGE_HELP_URL
      ;(help as HTMLAnchorElement).target = '_blank'
      ;(help as HTMLAnchorElement).rel = 'noopener noreferrer'
      column.append(startCmd, help)
    }
    mkRow(radio, column)
  }

  const customRadio = mkRadio()
  const customColumn = el('div', { flex: '1', minWidth: '0' })
  customColumn.append(el('div', { fontSize: '13px', color: '#e8e8e8' }, 'Custom…'))
  const input = el('input', {
    width: '100%',
    boxSizing: 'border-box',
    marginTop: '6px',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid #444',
    background: '#161616',
    color: '#eee',
    fontSize: '13px',
  }) as HTMLInputElement
  input.type = 'text'
  input.placeholder = 'wss://your-host'
  customColumn.append(input)
  mkRow(customRadio, customColumn)

  // preselect the option matching the URL in use; unknown URL = Custom
  if (!radios.some(r => r.checked)) {
    customRadio.checked = true
    input.value = resolveBridgeUrl()
  }
  restyleRows()

  const row = el('div', {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
    marginTop: '16px',
  })
  const mkBtn = (text: string, primary: boolean) =>
    el(
      'button',
      {
        padding: '8px 14px',
        borderRadius: '6px',
        border: 'none',
        cursor: 'pointer',
        fontSize: '13px',
        background: primary ? '#2d7dff' : '#333',
        color: '#fff',
      },
      text
    )

  const close = () => overlay.remove()
  const closeBtn = mkBtn('Close', false)
  closeBtn.onclick = close

  const testBtn = mkBtn('Test selected', false)
  const onSelectionChange = () => {
    restyleRows()
    testBtn.textContent = 'Test selected'
    input.style.borderColor = '#444'
    if (customRadio.checked) input.focus()
  }
  for (const radio of radios) radio.onchange = onSelectionChange
  // typing into the custom field selects Custom (the input is inside the
  // custom row's <label>, but only pick it once the user actually engages)
  input.onfocus = () => {
    if (!customRadio.checked) {
      customRadio.checked = true
      onSelectionChange()
    }
  }

  /** Checked option's URL; empty string = Custom with a blank input. */
  const selectedUrl = (): string =>
    customRadio.checked
      ? input.value.trim()
      : radios.find(r => r.checked)?.value || input.value.trim()

  testBtn.onclick = async () => {
    const url = selectedUrl()
    if (!url) {
      input.style.borderColor = '#e33'
      input.focus()
      return
    }
    testBtn.textContent = 'Checking…'
    const ok = await probeBridge(url)
    testBtn.textContent = ok ? '✓ Reachable' : '✗ Not reachable — test again'
    // clear the down-toast if the bridge already in use just tested fine
    if (ok && normBridgeUrl(url) === normBridgeUrl(resolveBridgeUrl())) {
      hideBridgeToast()
    }
  }

  const useBtn = mkBtn('Use this bridge', true)
  useBtn.onclick = () => {
    const value = selectedUrl()
    if (!value) {
      input.style.borderColor = '#e33'
      input.focus()
      return
    }
    // Persist in localStorage (survives an installed-PWA launch, where a
    // ?proxy= query param would not). Picking what the app would use anyway
    // (the instance default, or localhost when there is none) clears the key
    // instead, so a later instance-default change still propagates; an
    // explicit localhost pick on an instance WITH a default is stored like
    // any other override. A ?proxy= param still takes precedence over the
    // stored value, so strip it before reloading.
    const appDefault =
      (window as any).__slothfulConfig?.defaultProxyUrl || DEFAULT_LOCAL_BRIDGE
    if (normBridgeUrl(value) === normBridgeUrl(appDefault)) {
      localStorage.removeItem(PROXY_KEY)
    } else {
      localStorage.setItem(PROXY_KEY, value)
    }
    const u = new URL(location.href)
    u.searchParams.delete('proxy')
    if (u.toString() !== location.href) location.href = u.toString()
    else location.reload()
  }

  row.append(closeBtn, testBtn, useBtn)
  panel.append(title, body, previewNote, list, row)
  overlay.append(panel)
  overlay.onclick = e => {
    if (e.target === overlay) close()
  }
  document.body.appendChild(overlay)
  overlay.showModal()
  // showModal focuses the first focusable element — the details summary,
  // which paints a stray focus ring. The checked radio is the better start
  // (arrow keys then move the selection).
  radios.find(r => r.checked)?.focus()
}

// Last bridge probe result, surfaced to the (patched) ConnectivityDialog via
// window.__slothfulchatBridge.reachable(). null = unknown / not probed.
let bridgeReachable: boolean | null = null

/** How the selected account relates to the WS→TCP bridge:
 *  - 'none': webimap-only — never uses the bridge, don't probe or warn.
 *  - 'required': sending needs the bridge (bridge-only account, or a mixed one
 *    whose PRIMARY transport is IMAP/SMTP — core routes all sends through the
 *    primary transport only), or no account / unconfigured yet. An intrusive
 *    toast is warranted when the bridge is down.
 *  - 'fallback': mixed account whose primary transport is webimap — sending
 *    and primary receive work without the bridge; only the secondary IMAP
 *    transport's receive stalls. Not worth blocking the UI: the connectivity
 *    view reports the bridge state instead.
 * Best-effort: on any error, assume 'required'. */
async function bridgeNeed(): Promise<'none' | 'required' | 'fallback'> {
  const accId = (window as any).__selectedAccountId as number | undefined
  if (accId == null) return 'required'
  try {
    const rpc = getCore().dc.rpc
    const transports = await rpc.listTransports(accId)
    if (transports.length === 0) return 'required'
    const hasBridge = transports.some(t => !(t as any).webimap)
    if (!hasBridge) return 'none'
    const primaryAddr = (
      (await rpc.getConfig(accId, 'configured_addr')) ?? ''
    ).toLowerCase()
    const primary = transports.find(
      t => (t.addr ?? '').toLowerCase() === primaryAddr
    )
    return (primary as any)?.webimap ? 'fallback' : 'required'
  } catch {
    return 'required'
  }
}

async function checkBridge(): Promise<boolean> {
  // The frontend sets this while onboarding a bridge-free account (madmail
  // webimap) — suppress the notice so it doesn't wrongly nag on that flow.
  if ((window as any).__slothfulchatSuppressBridgeWarning) {
    hideBridgeToast()
    hideWelcomeHint()
    return true
  }
  const need = await bridgeNeed()
  if (need === 'none') {
    // webimap-only account: the bridge is irrelevant, don't even probe.
    bridgeReachable = null
    hideBridgeToast()
    hideWelcomeHint()
    return true
  }
  const ok = await probeBridge(resolveBridgeUrl())
  bridgeReachable = ok
  if (ok || need === 'fallback') {
    // Up, or the account can still work over webimap — no intrusive toast.
    // (For 'fallback' when down, the connectivity view shows the bridge state.)
    hideBridgeToast()
    hideWelcomeHint()
  } else {
    showBridgeToast()
    showWelcomeHint()
    // ponytail: no longer auto-opens the modal over the welcome screen — that
    // screen now offers a bridge-free path (madmail webimap), so blocking it
    // wrongly implies every account needs the bridge. The toast + clickable
    // hint stay for standard (IMAP/SMTP) accounts.
  }
  return ok
}

// Probe on load, then re-probe periodically so a bridge that goes down mid-use
// also surfaces the toast. Poll fast while down (catches the welcome screen
// rendering after the first failed probe, and clears the toast quickly once
// the user starts the bridge), slow once up. ponytail: a poll instead of
// wiring core connectivity events — cheap (one WS open/close) and works
// before any account exists (when no IO events fire yet).
if (typeof window !== 'undefined') {
  let bridgeUp = false
  const pollBridge = async () => {
    if (document.visibilityState === 'visible') bridgeUp = await checkBridge()
    setTimeout(pollBridge, bridgeUp ? 30000 : 3000)
  }
  pollBridge()
  // Hook for the (patched) ConnectivityDialog: show which bridge is in use and
  // open the edit dialog from inside the React app.
  ;(window as any).__slothfulchatBridge = {
    url: resolveBridgeUrl,
    openDialog: showBridgeDialog,
    reachable: () => bridgeReachable,
  }
}
