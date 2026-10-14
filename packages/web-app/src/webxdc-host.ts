/**
 * Bootstrap of a webxdc origin (static/webxdc-host.html, WEBXDC.md "Content
 * flow"). Knows nothing about webxdc: the app frames this page on
 * `<slug>.webxdc.<app-host>` and sends one command —
 *
 *   open {files, entry}  register the SW, put the files in the cache, then
 *                        navigate this frame to the app (served by the SW)
 *   wipe                 delete everything this origin stored, then 'wiped'
 *
 * Commands are taken only from the chat app this origin belongs to — its
 * page, or the app window it opened, which frames this one (webxdc.ts) — and
 * only while framed: framed by anyone else (frame-ancestors refuses that
 * anyway), or opened as a page of its own, it does nothing at all.
 */
import { XDC_CACHE, appOriginOf, cacheKey, xdcPath } from './webxdc-origin.ts'
import { webxdcGuard } from './webxdc-guard.ts'

// an app can show this page in a frame of its own: no WebRTC here either
webxdcGuard(window)

type Command =
  | { type: 'open'; files: [string, ArrayBuffer][]; entry: string }
  | { type: 'wipe' }

const appOrigin = appOriginOf(location)
const parent = window.parent

async function open(files: [string, ArrayBuffer][], entry: string): Promise<void> {
  await navigator.serviceWorker.register('/webxdc-sw.js', { scope: '/', updateViaCache: 'none' })
  await navigator.serviceWorker.ready
  // a reopen replaces the whole app: nothing of a previous copy survives
  await caches.delete(XDC_CACHE)
  const cache = await caches.open(XDC_CACHE)
  await Promise.all(
    files.map(([name, data]) => {
      const path = xdcPath(name, false)
      return path && cache.put(cacheKey(location.origin, path), new Response(data))
    })
  )
  const target = new URL(entry, location.origin)
  if (target.origin !== location.origin) throw new Error('entry leaves the origin')
  location.replace(target.href)
}

/** Each step on its own: a browser lacking one store must not keep the
 * others alive. */
const step = (f: () => unknown) => Promise.resolve().then(f).catch(() => {})

async function wipe(): Promise<void> {
  await step(() => localStorage.clear())
  await step(() => sessionStorage.clear())
  await step(() => {
    // host-only, Domain=<this host> and Domain=webxdc.<app host> — never the
    // app host's own domain, whose cookies may be someone else's login.
    // ponytail: path=/ only; a cookie the app set on a deeper path survives
    const domains = ['', `; domain=${location.hostname}`, `; domain=${location.hostname.replace(/^[^.]+\./, '')}`]
    for (const c of document.cookie.split(';')) {
      for (const d of domains) document.cookie = `${c.split('=')[0].trim()}=; max-age=0; path=/${d}`
    }
  })
  await step(async () => {
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue
      await new Promise(done => {
        const req = indexedDB.deleteDatabase(name)
        req.onsuccess = req.onerror = req.onblocked = done
      })
    }
  })
  await step(async () => {
    for (const key of await caches.keys()) await caches.delete(key)
  })
  await step(async () => {
    // Chromium's storage buckets each hold their own IndexedDB, caches and
    // OPFS, out of sight of the three sweeps around this one
    const buckets = (navigator as any).storageBuckets
    for (const name of await buckets.keys()) await buckets.delete(name)
  })
  await step(async () => {
    const root: any = await navigator.storage.getDirectory()
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true })
  })
  await step(async () => {
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister()
  })
}

if (appOrigin && parent !== window) {
  addEventListener('message', (e: MessageEvent<Command>) => {
    if (e.origin !== appOrigin) return
    const cmd = e.data
    const done =
      cmd?.type === 'open'
        ? open(cmd.files, cmd.entry)
        : cmd?.type === 'wipe'
          ? wipe().then(() => parent.postMessage({ type: 'wiped' }, appOrigin))
          : null
    done?.catch(err => parent.postMessage({ type: 'error', message: String(err) }, appOrigin))
  })
  parent.postMessage({ type: 'hello' }, appOrigin)
}
