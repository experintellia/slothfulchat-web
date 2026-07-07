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

let core: Core | null = null
function getCore(): Core {
  if (!core) {
    const params = new URLSearchParams(location.search)
    // priority: ?proxy= > saved > per-instance default (assemble.mjs) > localhost
    const wsProxyUrl =
      params.get('proxy') ||
      localStorage.getItem(PROXY_KEY) ||
      (window as any).__slothfulConfig?.defaultProxyUrl ||
      'ws://localhost:8641'
    // OPFS persistence is on by default; ?persist=0 opts out (fresh-core tests)
    const persist = params.get('persist') !== '0'
    core = startCore({ wsProxyUrl, persist }, new URL(BASE + 'core/worker.js', location.href))
    // The frontend passes the magic destination '<BROWSER>' to exportBackup on
    // the browser target (upstream's node server rewrites it to a tmp dir).
    // There is no server here, so rewrite it to a memfs dir before it reaches
    // the core. bundle.js stays untouched.
    const originalSend = core.transport._send.bind(core.transport)
    core.transport._send = (message: any) => {
      if (
        message?.method === 'export_backup' &&
        message.params?.[1] === '<BROWSER>'
      ) {
        message.params[1] = EXPORTS_DIR
      }
      originalSend(message)
    }
    // debug/smoke marker: proves the wasm core booted and answers rpc
    core.transport
      .request('get_system_info', [])
      .then(info => ((window as any).__coreSystemInfo = info))
      .catch(err => console.error('wasm core get_system_info failed', err))
  }
  return core
}

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
      // msg.path = absolute memfs path (backup downloads), otherwise a blob
      const data = await getCore().fsRead(
        msg.path ?? `/accounts/${msg.accountId}/dc.db-blobs/${msg.filename}`
      )
      reply(
        {
          type: 'blob-response',
          id: msg.id,
          data,
          mime: mimeFromName(msg.filename),
        },
        [data.buffer as ArrayBuffer]
      )
    } catch (error) {
      log.warn('blob-request failed', msg.accountId, msg.filename, error)
      reply({ type: 'blob-response', id: msg.id })
    }
  })
  navigator.serviceWorker
    .register(BASE + 'blobs-sw.js', { scope: BASE })
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
  onWebxdcSendToChat: Function | undefined
  onThemeUpdate: (() => void) | undefined
  onChooseLanguage: ((locale: string) => Promise<void>) | undefined
  onShowDialog: Function | undefined
  onResumeFromSleep: (() => void) | undefined
  onOpenQrUrl: ((url: string) => void) | undefined
  onToggleNotifications: (() => void) | undefined
  // #endregion

  openMapsWebxdc(_accountId: number, _chatId?: number): void {
    throw new Error('Method not implemented.')
  }

  emitUIFullyReady(): void {
    console.log('emitUIFullyReady') // no backend to notify
  }
  emitUIReady(): void {
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
    return getCore().dc
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
  startOutgoingVideoCall(): void {
    this.log.critical('Method not implemented.')
  }
  async openIncomingVideoCallWindow() {
    throw new Error('Method not implemented.')
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

    let icon = new URL(BASE + 'images/deltachat.png', location.origin).toString()
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
    document.title = `SlothfulChat${value ? `(${value})` : ''}`
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
  getWebxdcIconURL(_accountId: number, _msgId: number): string {
    this.log.critical('getWebxdcIconURL Method not implemented.')
    return 'not-implemented'
  }
  openWebxdc(): void {
    throw new Error('Method not implemented.')
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
    this.log.critical('Method not implemented.')
    return 'not-implemented'
  }
  async downloadFile(pathToSource: string, filename: string): Promise<void> {
    if (pathToSource.includes('dc.db-blobs')) {
      window
        .open(
          this.transformBlobURL(pathToSource) +
            '?download_with_filename=' +
            encodeURIComponent(filename),
          '_blank'
        )
        ?.focus()
    } else {
      throw new Error(
        'Browser does not support opening urls outside of blob directory'
      )
    }
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
    if (blob_path !== '') {
      this.log.error('transformBlobURL wrong url format', blob_path)
    }
    return ''
  }
  transformStickerURL(_sticker_path: string): string {
    throw new Error('sticker picker is not implemented yet for browser')
  }
  async deleteSticker(_stickerPath: string): Promise<void> {
    throw new Error('sticker picker is not implemented yet for browser')
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
      input.onchange = async () => {
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
    // mirroring target-browser/src/rc-config.ts and backendApi.ts
    const config = (this.rc_config = {
      'log-debug': true,
      'log-to-console': true,
      'machine-readable-stacktrace': false,
      devmode: true,
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
    } else if (mediaType === 'microphone') {
      return navigator.mediaDevices.getUserMedia({ audio: true }).then(
        stream => {
          stream.getTracks().forEach(track => track.stop())
          return true
        },
        err => {
          this.log.error('askForMediaAccess "microphone" failed', err)
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

function resolveBridgeUrl(): string {
  const params = new URLSearchParams(location.search)
  return (
    params.get('proxy') ??
    localStorage.getItem(PROXY_KEY) ??
    'ws://localhost:8641'
  )
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

function hideBridgeToast() {
  document.getElementById('sc-bridge-toast')?.remove()
}

function showBridgeToast() {
  if (document.getElementById('sc-bridge-toast')) return
  const toast = el(
    'div',
    {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
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
}

function showBridgeDialog() {
  if (document.getElementById('sc-bridge-dialog')) return
  const overlay = el('div', {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,.5)',
  })
  overlay.id = 'sc-bridge-dialog'

  const panel = el('div', {
    width: 'min(440px, 92vw)',
    padding: '20px',
    borderRadius: '10px',
    background: '#1e1e1e',
    color: '#eee',
    font: '14px/1.5 system-ui, sans-serif',
    boxShadow: '0 8px 40px rgba(0,0,0,.5)',
  })

  const title = el('h2', { margin: '0 0 8px', fontSize: '17px' }, 'Bridge not reachable')
  const body = el(
    'p',
    { margin: '0 0 12px', color: '#bbb' },
    'This app needs a WS→TCP bridge to send and receive (browsers can’t open ' +
      'raw TCP). Start it locally, then reload — or point at another bridge below.'
  )

  const startCmd = el(
    'pre',
    {
      margin: '0 0 6px',
      padding: '8px 10px',
      borderRadius: '6px',
      background: '#111',
      color: '#9cdcfe',
      whiteSpace: 'pre-wrap',
      fontSize: '12px',
    },
    'npx @slothfulchat/ws-tcp-proxy'
  )
  const help = el('a', { color: '#4ea1ff', fontSize: '12px' }, 'Bridge setup & source →')
  ;(help as HTMLAnchorElement).href = BRIDGE_HELP_URL
  ;(help as HTMLAnchorElement).target = '_blank'
  ;(help as HTMLAnchorElement).rel = 'noopener noreferrer'

  const label = el(
    'label',
    { display: 'block', margin: '16px 0 6px', fontSize: '12px', color: '#bbb' },
    'Alternative bridge URL'
  )
  const input = el('input', {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid #444',
    background: '#111',
    color: '#eee',
    fontSize: '13px',
  }) as HTMLInputElement
  input.type = 'text'
  input.value = resolveBridgeUrl()
  input.placeholder = 'wss://your-host'

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

  const retryBtn = mkBtn('Retry current', false)
  retryBtn.onclick = async () => {
    retryBtn.textContent = 'Checking…'
    const ok = await probeBridge(resolveBridgeUrl())
    if (ok) {
      hideBridgeToast()
      close()
    } else {
      retryBtn.textContent = 'Still down — retry'
    }
  }

  const useBtn = mkBtn('Use this bridge', true)
  useBtn.onclick = () => {
    const value = input.value.trim()
    // Persist in localStorage (survives an installed-PWA launch, where a
    // ?proxy= query param would not); empty input resets to the default.
    // A ?proxy= param still takes precedence, so strip it before reloading.
    if (value && value !== 'ws://localhost:8641') {
      localStorage.setItem(PROXY_KEY, value)
    } else {
      localStorage.removeItem(PROXY_KEY)
    }
    const u = new URL(location.href)
    u.searchParams.delete('proxy')
    if (u.toString() !== location.href) location.href = u.toString()
    else location.reload()
  }

  row.append(closeBtn, retryBtn, useBtn)
  panel.append(title, body, startCmd, help, label, input, row)
  overlay.append(panel)
  overlay.onclick = e => {
    if (e.target === overlay) close()
  }
  document.body.appendChild(overlay)
}

async function checkBridge() {
  const ok = await probeBridge(resolveBridgeUrl())
  if (ok) hideBridgeToast()
  else showBridgeToast()
}

// Probe on load, then re-probe periodically so a bridge that goes down mid-use
// also surfaces the toast. ponytail: a 30s poll instead of wiring core
// connectivity events — cheap (one WS open/close) and works before any account
// exists (when no IO events fire yet); hook events later if the poll is noisy.
if (typeof window !== 'undefined') {
  checkBridge()
  setInterval(() => {
    if (document.visibilityState === 'visible') checkBridge()
  }, 30000)
  // Hook for the (patched) ConnectivityDialog: show which bridge is in use and
  // open the edit dialog from inside the React app.
  ;(window as any).__slothfulchatBridge = {
    url: resolveBridgeUrl,
    openDialog: showBridgeDialog,
  }
}
