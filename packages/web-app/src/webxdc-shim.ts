/**
 * `webxdc.js` — the API object a webxdc app talks to, served from the app's
 * own origin (webxdc.ts puts it in the file map, overriding any webxdc.js the
 * archive ships). Adapted from upstream's Electron preload
 * (target-electron/static/webxdc-preload.js): `ipcRenderer.invoke` becomes a
 * postMessage request/reply with the chat app. Requests go to this frame's
 * parent — the chat app, or the app window it opened (webxdc.ts) — and
 * anything from the chat app's origin is the chat app: every document there
 * is ours, and in an app window the replies come from its opener.
 *
 * webxdcShim runs INSIDE the app frame, so it must be self-contained — it is
 * shipped as source text (shimSource) with its config baked in, and closes
 * over nothing from this module. Self-check: webxdc-shim.test.ts.
 */

export type ShimConfig = {
  /** the chat app's origin: the only one requests go to and replies come from */
  parentOrigin: string
  selfAddr: string
  selfName: string
  sendUpdateInterval: number
  sendUpdateMaxSize: number
  isAppSender: boolean
  isBroadcast: boolean
}

export function webxdcShim(cfg: ShimConfig, w: any = window): void {
  const parent = w.parent
  const post = (op: string, data: object = {}) => parent.postMessage({ webxdc: op, ...data }, cfg.parentOrigin)
  // per document: a reply still in flight from before a reload must not
  // settle the new page's request of the same number
  const tag = Math.random().toString(36).slice(2)
  let seq = 0
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  const call = (op: string, data: object = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = `${tag}.${++seq}`
      pending.set(id, { resolve, reject })
      post(op, { id, ...data })
    })

  let callback: ((update: any) => void) | null = null
  let lastSerial = 0
  let listenerReady: (() => void) | null = null
  let running = false
  let again = false
  // Upstream's version re-entered itself while still marked running, so an
  // update announced mid-fetch was only picked up on the NEXT announcement.
  // A loop has no such gap: whatever arrives while fetching is fetched next.
  const onStatusUpdate = async () => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        if (!callback) break
        const updates = JSON.parse(await call('getUpdates', { serial: lastSerial }))
        for (const update of updates) {
          lastSerial = update.max_serial
          callback(update)
        }
        listenerReady?.()
        listenerReady = null
      } while (again)
    } catch (err) {
      console.error('webxdc: fetching updates failed', err)
    } finally {
      running = false
    }
  }

  type Realtime = { listener: ((data: Uint8Array) => void) | null; trashed: boolean }
  let realtime: Realtime | null = null

  w.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== cfg.parentOrigin) return
    const d = e.data
    if (d?.webxdc === 'reply') {
      const p = pending.get(d.id)
      pending.delete(d.id)
      if (d.error != null) p?.reject(new Error(d.error))
      else p?.resolve(d.result)
    } else if (d?.webxdc === 'statusUpdate') {
      onStatusUpdate()
    } else if (d?.webxdc === 'realtime' && realtime && !realtime.trashed) {
      realtime.listener?.(new Uint8Array(d.data))
    }
  })
  // a click into this frame never reaches the chat app's document: say so,
  // so it can bring this window to the front
  w.addEventListener('pointerdown', () => post('focus'), true)
  // A link off the app's own origin can't be followed in here (the frame may
  // only show this origin; mailto: and friends would replace the app with an
  // error page): hand it to the chat app, which knows what to do with it.
  // Bubble phase, so an app that handles its own clicks keeps them.
  w.addEventListener('click', (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    // downloads (data:, blob:) and javascript: run here as they are
    if (!a || e.defaultPrevented || a.hasAttribute('download')) return
    const url = new URL(a.href, w.location.href)
    if (url.origin === w.location.origin || url.protocol === 'javascript:') return
    e.preventDefault()
    post('openLink', { url: url.href })
  })

  const blobToBase64 = (file: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const url = reader.result as string
        resolve(url.slice(url.indexOf(';base64,') + 8))
      }
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })

  w.webxdc = {
    selfAddr: cfg.selfAddr,
    selfName: cfg.selfName,
    sendUpdateInterval: cfg.sendUpdateInterval,
    sendUpdateMaxSize: cfg.sendUpdateMaxSize,
    isAppSender: cfg.isAppSender,
    isBroadcast: cfg.isBroadcast,
    setUpdateListener(cb: (update: any) => void, startSerial = 0) {
      lastSerial = startSerial
      callback = cb
      const ready = new Promise<void>(resolve => (listenerReady = resolve))
      onStatusUpdate()
      return ready
    },
    // Fork-only, experimental (WEBXDC.md): [userId, displayName][] of the chat
    // members, self included; a member's avatar is /__webxdc__/avatar/<userId>.jpg
    getMemberList: () => call('getMemberList'),
    getAllUpdates() {
      console.error(
        'getAllUpdates is deprecated and will be removed in the future, it also returns an empty array now, so you really should use setUpdateListener instead.'
      )
      return Promise.resolve([])
    },
    sendUpdate(update: unknown, description?: string) {
      if (description) {
        console.error('parameter description in sendUpdate is deprecated and will be removed in the future')
      }
      call('sendUpdate', { update: JSON.stringify(update) }).catch(err =>
        console.error('webxdc.sendUpdate failed', err)
      )
    },
    joinRealtimeChannel() {
      if (realtime && !realtime.trashed) throw new Error('realtime listener already exists')
      const rt: Realtime = { listener: null, trashed: false }
      realtime = rt
      call('realtimeAdvertise').catch(err => console.error('webxdc: joining the realtime channel failed', err))
      return {
        setListener(listener: (data: Uint8Array) => void) {
          rt.listener = listener
        },
        send(data: Uint8Array) {
          if (!(data instanceof Uint8Array)) throw new Error('realtime listener data must be a Uint8Array')
          if (rt.trashed) throw new Error('realtime listener is trashed and can no longer be used')
          call('realtimeSend', { data }).catch(err => console.error('webxdc: realtime send failed', err))
        },
        leave() {
          rt.trashed = true
          call('realtimeLeave').catch(() => {})
        },
        is_trashed: () => rt.trashed,
      }
    },
    async sendToChat(content: { file?: any; text?: string }) {
      if (!content.file && !content.text) {
        throw 'Error from sendToChat: Invalid empty message, at least one of text or file should be provided'
      }
      let file: { file_name: string; file_content: string } | null = null
      if (content.file) {
        const f = content.file
        if (!f.name) throw 'file name is missing'
        if (['blob', 'base64', 'plainText'].filter(k => k in f).length > 1) {
          throw 'you can only set one of `blob`, `base64` or `plainText`, not multiple ones'
        }
        let data: string
        if (f.blob instanceof Blob) data = await blobToBase64(f.blob)
        else if (typeof f.base64 === 'string') data = f.base64
        else if (typeof f.plainText === 'string') data = await blobToBase64(new Blob([f.plainText]))
        else {
          throw 'data is not set or wrong format, set one of `blob`, `base64` or `plainText`, see webxdc documentation for sendToChat'
        }
        file = { file_name: f.name, file_content: data }
      }
      await call('sendToChat', { file, text: content.text ?? null })
    },
    importFiles(filters: { extensions?: string[]; mimeTypes?: string[]; multiple?: boolean }) {
      const input = w.document.createElement('input')
      input.type = 'file'
      input.accept = [...(filters.extensions || []), ...(filters.mimeTypes || [])].join(',')
      input.multiple = filters.multiple || false
      input.style.display = 'none'
      const picked = new Promise(resolve => {
        input.onchange = () => {
          input.remove()
          resolve(Array.from(input.files || []))
        }
      })
      w.document.body.appendChild(input)
      input.click()
      return picked
    },
  }
}

/** The served webxdc.js. JSON.stringify keeps every string a string: the
 * values come from the chat (selfName) and must never become code. */
export const shimSource = (cfg: ShimConfig) =>
  `;(${webxdcShim.toString()})(${JSON.stringify(cfg)});\n`
