/**
 * Chat export — the zip half of the three-dot menu's "Export Chat".
 *
 * The desktop patch keeps only the menu entry, the confirm dialog (exclusions,
 * date range) and a progress dialog that calls
 * window.__slothfulExportChat(chatId, options). Everything else lives here,
 * outside the patch stack, because none of it touches React: fetching the
 * messages, collecting media, inlining the app css, and building the zip.
 *
 * The zip is a Telegram-style export: a standalone `index.html` viewer that
 * renders the chat exactly like the desktop message list (the app's own
 * stylesheets and markup, media referenced from the bundled `media/`
 * directory), the raw message data as `messages.json`, a plain-text
 * transcript `messages.txt`, and a `manifest.toml` so the archive doubles as a
 * webxdc app (rename to `.xdc` and send it into a chat to view an export
 * in-app). The viewer's toolbar can save a plain-text transcript and — behind
 * an explainer dialog — a single-file HTML snapshot of the rendered DOM with
 * media inlined as data: URIs.
 */
import { zipSync } from 'fflate'
import type { BaseDeltaChat, T } from '@slothfulchat/core-wasm'
import * as analytics from './analytics'

/** media larger than this stays out of the zip (a file tile is shown instead) */
const MAX_MEDIA_FILE_BYTES = 50 * 1024 * 1024
/** overall media budget for one export (the zip is assembled in memory) */
const MAX_TOTAL_MEDIA_BYTES = 300 * 1024 * 1024
/** css url() assets (icons, default background) above this are left as-is */
const MAX_CSS_ASSET_BYTES = 5 * 1024 * 1024
/** getMessages batch size */
const CHUNK_SIZE = 100

type Rpc = BaseDeltaChat<any>['rpc']

export type ExportChatOptions = {
  accountId: number
  /** inclusive unix-seconds range; null side = unbounded */
  startTs: number | null
  endTs: number | null
  /** hashed css-module class names the viewer needs (message, messageFooter,
   * onlyMedia, reactions, emoji, emojiCount, isFromSelf) — only the frontend
   * bundle knows them */
  styles: Record<string, string>
  /** the frontend's moment, in the user's locale:
   * `(ts, format) => moment.unix(ts).format(format)`.
   * ponytail: borrowed rather than bundled — a second moment would need every
   * locale shipped twice to print the same dates */
  formatDate: (unixSeconds: number, format: string) => string
  /** 0..1000 */
  onProgress?: (progress: number) => void
  /** aborting rejects the export with the signal's reason */
  signal?: AbortSignal
}

/** Register window.__slothfulExportChat for the desktop patch's export
 * dialog. Resolves to the zip's filename once the download was handed to the
 * browser. */
export function initChatExport(
  rpc: () => Rpc,
  blobUrl: (path: string) => string,
  save: (data: Uint8Array, name: string) => Promise<unknown>
): void {
  // async, so a throw from rpc() (getCore can refuse) rejects instead of
  // escaping before the dialog has attached its .finally(onClose)
  ;(window as any).__slothfulExportChat = async (
    chatId: number,
    options: ExportChatOptions
  ) => exportChatToZip(rpc(), blobUrl, save, chatId, options)
}

// Shared HTML-escape map, hoisted so it isn't rebuilt for every replaced char.
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"']/g, char => HTML_ESCAPES[char])
}

/** collects referenced blobdir files (attachments, avatars, quote images)
 * once each for the zip's media/ directory */
class MediaCollector {
  /** memfs path -> zip entry name (without the media/ prefix) */
  entries = new Map<string, { name: string; data: Uint8Array }>()
  /** paths that failed or exceeded the budget — don't re-fetch per message */
  private rejected = new Set<string>()
  private usedNames = new Set<string>()
  private totalBytes = 0

  private blobUrl: (path: string) => string

  constructor(blobUrl: (path: string) => string) {
    this.blobUrl = blobUrl
  }

  /** returns the zip-relative path ('media/<name>') or null (missing/too big) */
  async add(path: string | null | undefined): Promise<string | null> {
    if (!path) {
      return null
    }
    const existing = this.entries.get(path)
    if (existing) {
      return 'media/' + existing.name
    }
    if (this.rejected.has(path)) {
      return null
    }
    try {
      const response = await fetch(this.blobUrl(path))
      if (!response.ok) {
        return null
      }
      const data = new Uint8Array(await response.arrayBuffer())
      if (
        data.byteLength > MAX_MEDIA_FILE_BYTES ||
        this.totalBytes + data.byteLength > MAX_TOTAL_MEDIA_BYTES
      ) {
        console.warn(`chat export: not bundling ${path}: too large (${data.byteLength} bytes)`)
        this.rejected.add(path)
        return null
      }
      this.totalBytes += data.byteLength
      const name = this.uniqueName(path)
      this.entries.set(path, { name, data })
      return 'media/' + name
    } catch (error) {
      console.warn(`chat export: failed to bundle ${path}:`, error)
      this.rejected.add(path)
      return null
    }
  }

  private uniqueName(path: string): string {
    const base =
      (path.split('/').pop() || 'file').replace(/[^\w.-]+/g, '_').slice(-80) ||
      'file'
    let name = base
    for (let i = 1; this.usedNames.has(name); i++) {
      name = `${i}-${base}`
    }
    this.usedNames.add(name)
    return name
  }
}

/** the app's stylesheets, in the order main.html loads them; the theme-vars
 * block is deliberately not included — exports use the default (fallback)
 * theme */
const STYLESHEETS = ['./main.css', './bundle.css', './fallback-theme.css']

async function fetchAsDataUrl(href: string): Promise<string | null> {
  try {
    const response = await fetch(new URL(href, document.baseURI))
    if (!response.ok) {
      return null
    }
    const blob = await response.blob()
    if (blob.size > MAX_CSS_ASSET_BYTES) {
      return null
    }
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch (error) {
    console.warn(`chat export: failed to inline css asset ${href}:`, error)
    return null
  }
}

/** inline `url(...)` references (icons, default chat background) so the css
 * works in a standalone file; unresolvable ones are left untouched */
async function inlineCssUrls(css: string): Promise<string> {
  const urlRegex = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g
  const refs = new Set<string>()
  for (const match of css.matchAll(urlRegex)) {
    const ref = match[2]
    if (!/^(data:|https?:|#)/.test(ref)) {
      refs.add(ref)
    }
  }
  const resolved = new Map<string, string>()
  await Promise.all(
    [...refs].map(async ref => {
      const dataUrl = await fetchAsDataUrl(ref)
      if (dataUrl) {
        resolved.set(ref, dataUrl)
      }
    })
  )
  return css.replace(urlRegex, (original, _quote, ref) => {
    const dataUrl = resolved.get(ref)
    return dataUrl ? `url(${dataUrl})` : original
  })
}

async function collectCss(): Promise<string> {
  const parts: string[] = []
  for (const href of STYLESHEETS) {
    try {
      const response = await fetch(new URL(href, document.baseURI))
      if (!response.ok) {
        throw new Error(`http ${response.status}`)
      }
      parts.push(
        (await response.text()).replace(
          /\/\*#\s*sourceMappingURL=[^*]*\*\//g,
          ''
        )
      )
    } catch (error) {
      console.warn(`chat export: could not fetch stylesheet ${href}:`, error)
    }
  }
  return inlineCssUrls(parts.join('\n'))
}

/** export-only layout: undo the app's fixed/scrolling message list so the
 * document is one long scrollable page with a sticky chat header */
const EXPORT_CSS = `
body { margin: 0; }
/* the app paints the chat background on .message-list-and-composer, which is
 * viewport-sized there — in the export that element grows with the whole
 * chat, so background-size: cover would blow the pattern up to the full
 * document height. Paint it on a fixed viewport-sized layer instead (a
 * position:fixed pseudo-element; background-attachment: fixed is unreliable
 * on mobile), so it stays put while scrolling. */
body.html-export::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  background-color: var(--chatViewBg);
  background-image: var(--chatViewBgImgPath);
  background-size: cover;
}
.html-export .message-list-and-composer {
  min-height: 100vh;
  box-sizing: border-box;
  background-color: transparent;
  background-image: none;
}
.html-export #message-list {
  position: static;
  overflow-y: visible;
  max-height: none;
  max-width: 850px;
  margin: 0 auto;
}
.html-export-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background-color: var(--navBarBackground);
  color: var(--navBarText);
}
.html-export-header .author-avatar { display: inline-block; flex-shrink: 0; }
.html-export-header .author-avatar img,
.html-export-header .author-avatar .label {
  display: block;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}
.html-export-header .author-avatar .label {
  color: var(--avatarLabelColor, white);
  background-color: var(--local-avatar-color);
  font-size: 22px;
  line-height: 40px;
  text-align: center;
  user-select: none;
}
.html-export-header-name {
  font-size: 18px;
  font-weight: bold;
  margin: 0;
}
.html-export-header-subtitle {
  font-size: 12px;
  opacity: 0.8;
}
.html-export-buttons {
  margin-inline-start: auto;
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.html-export-save-button {
  background-color: var(--colorPrimary);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
}
.html-export-save-button:disabled { opacity: 0.5; }
.html-export-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}
.html-export-dialog {
  background: var(--bgPrimary, white);
  color: var(--textPrimary, black);
  border-radius: 8px;
  max-width: 420px;
  max-height: 80vh;
  overflow-y: auto;
  padding: 20px;
  font-size: 14px;
  line-height: 1.45;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
}
.html-export-dialog h2 { margin: 0 0 8px; font-size: 16px; }
.html-export-dialog p { margin: 8px 0; }
.html-export-dialog-status { opacity: 0.85; }
.html-export-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
[data-reactions-msg] { cursor: pointer; }
.html-export-reactions-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  min-width: 240px;
}
.html-export-reactions-row .author-avatar img,
.html-export-reactions-row .author-avatar .label {
  display: block;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}
.html-export-reactions-row .author-avatar .label {
  color: var(--avatarLabelColor, white);
  background-color: var(--local-avatar-color);
  font-size: 18px;
  line-height: 32px;
  text-align: center;
  user-select: none;
}
.html-export-reactions-name { flex-grow: 1; }
.html-export-reactions-emoji { font-size: 20px; }
.html-export-media-link { display: inline-block; font-size: 0; }
a.message-attachment-generic {
  display: block;
  color: inherit;
  text-decoration: none;
}
a.html-export-quote-jump {
  display: block;
  text-decoration: none;
}
.html-export-note {
  font-style: italic;
  font-size: 12px;
  opacity: 0.75;
  margin: 4px 0;
}
.html-export-vcard {
  display: flex;
  align-items: center;
  gap: 10px;
  background-color: rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  padding: 9px 15px 9px 9px;
  min-width: 200px;
  max-width: 260px;
  margin: 4px 0;
}
.html-export-vcard-avatar {
  display: block;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.html-export-vcard-initial {
  color: var(--avatarLabelColor, white);
  font-size: 20px;
  line-height: 36px;
  text-align: center;
  user-select: none;
}
.html-export-vcard-name { font-weight: bold; }
.html-export-vcard-addr { font-size: 12px; opacity: 0.8; }
`

/**
 * The whole viewer, embedded into the exported index.html as
 * `(chatExportViewer.toString())()`. It must stay fully self-contained
 * (browser globals only, no imports, no outer-scope references) — it runs in
 * the exported file, not in the app. It renders the embedded `#chat-data`
 * JSON (chat + message list items + raw jsonrpc messages + file map) into
 * the same DOM the desktop message list produces, and wires the
 * "save single-file HTML" button, which snapshots the rendered DOM with
 * media inlined as data: URIs (where fetchable — file:// blocks fetch, then
 * the relative media/ references are kept).
 */
function chatExportViewer() {
  const dataEl = document.getElementById('chat-data')
  if (!dataEl) {
    return
  }
  const data = JSON.parse(dataEl.textContent || '{}') as any
  const s = data.styles || {}
  // This function ships as Function.toString() into the exported file, so it
  // must not reference module scope — after minification an outer const like
  // HTML_ESCAPES becomes a mangled name that doesn't exist in the export
  // (ReferenceError). Keep this map local; don't dedupe it with escapeHtml's.
  const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  const esc = (raw: any) =>
    String(raw ?? '').replace(/[&<>"']/g, c => ESCAPES[c])
  const cls = (arr: any[]) => arr.filter(Boolean).join(' ')
  const fileHref = (path: any) => {
    const rel = path && data.files[path]
    return rel ? encodeURI(rel) : null
  }
  const fmtTime = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
  const fmtFull = (ts: number) => new Date(ts * 1000).toLocaleString()
  const fmtDay = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString([], {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  const fmtSize = (bytes: number) => {
    let n = bytes || 0
    const units = ['B', 'kB', 'MB', 'GB']
    let i = 0
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024
      i++
    }
    return (i ? n.toFixed(1) : String(n)) + ' ' + units[i]
  }
  // DC_STATE_* -> status class (see MapMsgStatus.ts)
  const STATUS: any = {
    24: 'error',
    20: 'sending',
    19: 'draft',
    26: 'delivered',
    28: 'read',
  }
  const authorName = (displayName: string, overrideSenderName: any) =>
    overrideSenderName ? `~${overrideSenderName}` : displayName
  const renderText = (text: string) =>
    text
      .split(/(https?:\/\/[^\s<>"']+)/g)
      .map((part, i) =>
        i % 2
          ? `<a href="${esc(part)}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>`
          : esc(part).replace(/\n/g, '<br>')
      )
      .join('')
  const isImageLike = (viewType: string) =>
    viewType === 'Image' || viewType === 'Gif' || viewType === 'Video'
  // same numbers as upstream messageAttachment.tsx calculateHeight() — the
  // app sizes images via an explicit height attribute, not css
  const maxStickerSize = 200
  const displayHeight = (msg: any) => {
    if (msg.viewType === 'Sticker') {
      return maxStickerSize
    }
    const height = msg.dimensionsHeight
    const width = msg.dimensionsWidth
    if (!height || !width) {
      return null
    }
    const minWidth = 200
    const minHeight = 50
    const maxSize = 450 // maxLandscapeWidth / maxPortraitHeight
    let finalHeight
    if (height > width) {
      finalHeight = Math.min(height, maxSize)
      if (height < maxSize && (finalHeight / height) * width < minWidth) {
        finalHeight = (height / width) * minWidth
      }
    } else {
      finalHeight = Math.min(height, (maxSize / width) * height)
      if ((finalHeight / height) * width < minWidth) {
        finalHeight = (height / width) * minWidth
      }
      if (finalHeight < minHeight) {
        finalHeight = minHeight
      }
    }
    return Math.round(finalHeight)
  }

  const avatarHtml = (contact: any, extra: boolean) => {
    const src = fileHref(contact.profileImage)
    if (src) {
      return `<span class="${cls(['author-avatar', extra && 'extra'])}"><img alt="${esc(contact.displayName)}" src="${src}"></span>`
    }
    const initial = (
      Array.from(String(contact.displayName || contact.address || '#'))[0] ||
      '#'
    ).toUpperCase()
    return (
      `<span class="${cls(['author-avatar', 'default', extra && 'extra'])}" aria-label="${esc(contact.displayName)}">` +
      `<div class="label" style="--local-avatar-color: ${esc(contact.color)};">${esc(initial)}</div></span>`
    )
  }

  const attachmentHtml = (msg: any, withCaption: boolean) => {
    if (!msg.file || msg.viewType === 'Webxdc' || msg.viewType === 'Vcard') {
      return ''
    }
    const src = fileHref(msg.file)
    const isImage = msg.viewType === 'Image' || msg.viewType === 'Gif'
    // gzipped-Lottie stickers can't render in an <img>; show the file tile
    const isLottieSticker =
      (msg.fileName || '').toLowerCase().endsWith('.tgs') ||
      (msg.fileMime || '').toLowerCase() === 'application/x-tgsticker'
    if (src && !isLottieSticker && (isImage || msg.viewType === 'Sticker')) {
      const imgClass = cls([
        'attachment-content',
        msg.dimensionsHeight > msg.dimensionsWidth && 'portrait',
        msg.viewType === 'Sticker' && 'sticker',
      ])
      const height = displayHeight(msg)
      const sizeAttrs =
        (height ? ` height="${height}"` : '') +
        (msg.viewType === 'Sticker' ? ` width="${maxStickerSize}"` : '')
      // link to the bundled original for a full-size view
      return (
        `<figure class="${cls(['message-attachment-media', withCaption && 'content-below'])}">` +
        `<a class="html-export-media-link" href="${src}" target="_blank" rel="noopener noreferrer">` +
        `<img class="${imgClass}" src="${src}"${sizeAttrs}></a></figure>`
      )
    }
    if (src && msg.viewType === 'Video') {
      return (
        `<div class="${cls(['message-attachment-media', 'video', withCaption && 'content-below'])}">` +
        `<video class="attachment-content video-content" src="${src}" controls></video></div>`
      )
    }
    if (src && (msg.viewType === 'Audio' || msg.viewType === 'Voice')) {
      return (
        `<div class="${cls(['message-attachment-audio', withCaption && 'content-below'])}">` +
        `<audio src="${src}" controls></audio></div>`
      )
    }
    // everything else (and media over the size cap): the generic file tile —
    // a download link when the file made it into the zip
    const name = msg.fileName || ''
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
    const tileClass = cls([
      'message-attachment-generic',
      withCaption && 'content-below',
    ])
    const inner =
      `<div class="file-icon" title="${esc(msg.fileMime || '')}">` +
      (ext ? `<div class="file-extension">${esc(ext)}</div>` : '') +
      `</div><div class="text-part">` +
      `<div class="name">${esc(name)}</div>` +
      `<div class="size">${esc(fmtSize(msg.fileBytes))}${src ? '' : ' — not included in the export'}</div>` +
      `</div>`
    return src
      ? `<a class="${tileClass}" href="${src}" download="${esc(name)}">${inner}</a>`
      : `<div class="${tileClass}">${inner}</div>`
  }

  // Vcard messages: msg.vcardContact is fully embedded (name, address,
  // color, base64 avatar) — render a contact tile like the app does
  const vcardHtml = (msg: any) => {
    const contact = msg.vcardContact
    if (!contact) {
      return ''
    }
    const initial = (
      Array.from(String(contact.displayName || contact.addr || '#'))[0] || '#'
    ).toUpperCase()
    const avatar = contact.profileImage
      ? `<img class="html-export-vcard-avatar" src="data:image/jpeg;base64,${esc(contact.profileImage)}">`
      : `<span class="html-export-vcard-avatar html-export-vcard-initial" style="background-color: ${esc(contact.color || '#888888')};">${esc(initial)}</span>`
    return (
      `<div class="html-export-vcard">${avatar}<div>` +
      `<div class="html-export-vcard-name">${esc(contact.displayName)}</div>` +
      `<div class="html-export-vcard-addr">${esc(contact.addr)}</div>` +
      `</div></div>`
    )
  }

  const quoteHtml = (quote: any) => {
    const hasMessage = quote.kind === 'WithMessage'
    const borderStyle =
      hasMessage && !quote.isForwarded
        ? ` style="border-left-color: ${esc(quote.authorDisplayColor)};"`
        : ''
    // jump to the quoted message when it is part of the export; the anchor
    // wraps only the (plain-text) author line — the quoted text itself may
    // contain links, and nested <a> elements get fragmented by the parser
    const jump = hasMessage && data.messages[quote.messageId]
    const authorTag = jump
      ? [
          `<a class="quote-author html-export-quote-jump" href="#${quote.messageId}"`,
          'a',
        ]
      : ['<div class="quote-author"', 'div']
    const author = hasMessage
      ? `${authorTag[0]} style="color: ${esc(quote.authorDisplayColor)};">${esc(
          authorName(quote.authorDisplayName, quote.overrideSenderName)
        )}</${authorTag[1]}>`
      : ''
    const text = quote.text
      ? `<div class="quoted-text">${renderText(String(quote.text).slice(0, 3000))}</div>`
      : ''
    const imgSrc = hasMessage ? fileHref(quote.image) : null
    const image = imgSrc ? `<img class="quoted-image" src="${imgSrc}">` : ''
    return (
      `<div class="quote-background"><div class="${cls(['quote', hasMessage && 'has-message'])}"${borderStyle}>` +
      `<div class="quote-text">${author}${text}</div>${image}</div></div>`
    )
  }

  const reactionContact = (contactId: any) =>
    (data.reactionContacts || {})[contactId] || {
      displayName: '#' + contactId,
      address: '',
      color: '#888888',
    }
  /** "name: emojis" per reactor — the no-JS affordance (title attribute) and
   * the source for the click dialog */
  const reactorLines = (reactions: any) =>
    Object.entries(reactions.reactionsByContact || {}).map(
      ([contactId, emojis]) =>
        `${reactionContact(contactId).displayName}: ${(emojis as string[]).join(' ')}`
    )
  const reactionsHtml = (msg: any) => {
    const reactions = msg.reactions
    if (!reactions || !reactions.reactions.length) {
      return ''
    }
    const spans = reactions.reactions
      .map((r: any) => {
        const count =
          r.count > 1 ? `<span class="${s.emojiCount}">${r.count}</span>` : ''
        return `<span class="${cls([s.emoji, r.isFromSelf && s.isFromSelf])}">${esc(r.emoji)}${count}</span>`
      })
      .join('')
    return `<div><div class="${s.reactions}" data-reactions-msg="${msg.id}" title="${esc(reactorLines(reactions).join('\n'))}">${spans}</div></div>`
  }

  const metadataHtml = (msg: any, direction: string) => {
    const hasText = msg.text !== null && msg.text !== ''
    const withImageNoCaption =
      (!hasText && isImageLike(msg.viewType)) || msg.viewType === 'Sticker'
    const status = STATUS[msg.state] || ''
    const parts = []
    if (!msg.showPadlock && msg.downloadState === 'Done') {
      parts.push('<div class="email-icon"></div>')
    }
    if (msg.savedMessageId || msg.originalMsgId) {
      parts.push('<div class="saved-message-icon"></div>')
    }
    if (msg.isEdited) {
      parts.push('<span class="edited">edited</span>')
    }
    if (msg.hasLocation) {
      parts.push('<span class="location-icon"></span>')
    }
    const dateTitle =
      fmtFull(msg.timestamp) +
      (msg.hasDeviatingTimestamp && msg.receivedTimestamp
        ? ` · received ${fmtFull(msg.receivedTimestamp)}`
        : '')
    parts.push(
      `<span class="date date--${direction}" title="${esc(dateTitle)}">${esc(fmtTime(msg.timestamp))}</span>`
    )
    parts.push('<span class="spacer"></span>')
    const hideStatus =
      data.chat.chatType === 'OutBroadcast' &&
      (status === 'delivered' || status === 'read')
    if (msg.error != null) {
      // like the app, failed messages surface independently of state; the
      // error text lives in the icon's tooltip
      parts.push(
        `<div class="delivery-status-wrapper" title="${esc(msg.error)}"><div class="status-icon error"></div></div>`
      )
    } else if (direction === 'outgoing' && status && !hideStatus) {
      parts.push(
        `<div class="delivery-status-wrapper"><div class="status-icon ${esc(status)}"></div></div>`
      )
    }
    return `<div class="${cls(['metadata', withImageNoCaption && 'with-image-no-caption'])}">${parts.join('')}</div>`
  }

  const messageHtml = (msg: any) => {
    const direction = msg.fromId === 1 ? 'outgoing' : 'incoming'
    if (msg.isInfo) {
      return (
        `<li class="message-wrapper"><div class="info-message" id="${msg.id}">` +
        `<div class="bubble">${esc(msg.text || '')}</div></div></li>`
      )
    }
    const showAuthor = Boolean(
      data.chat.chatType !== 'Single' ||
      msg.overrideSenderName ||
      msg.originalMsgId ||
      data.chat.isSelfTalk
    )
    const hasText = msg.text !== null && msg.text !== ''
    const avatar = avatarHtml(
      msg.sender,
      // same rule as upstream <Message />: visible only for incoming messages
      // with an author; otherwise a hidden `.extra` avatar themes can opt into
      !(showAuthor && direction === 'incoming')
    )
    let authorOrForwarded
    if (msg.isForwarded) {
      // like upstream: name the forwarder for incoming group messages
      const label =
        data.chat.chatType !== 'Single' && direction !== 'outgoing'
          ? `Forwarded by ${esc(authorName(msg.sender.displayName, msg.overrideSenderName))}`
          : 'Forwarded Message'
      authorOrForwarded = `<div class="forwarded-indicator"><span class="forwarded-indicator-button">${label}</span></div>`
    } else {
      const canHide =
        (!msg.overrideSenderName && direction === 'outgoing') || !showAuthor
      authorOrForwarded =
        `<div class="${cls(['author-wrapper', canHide && 'can-hide'])}">` +
        `<span class="author" style="color: ${esc(msg.sender.color)};" title="${esc(msg.sender.address || '')}">${esc(
          authorName(msg.sender.displayName, msg.overrideSenderName)
        )}</span></div>`
    }
    const isWithoutText =
      (!hasText && isImageLike(msg.viewType)) || msg.viewType === 'Sticker'
    const footer =
      `<footer class="${cls([s.messageFooter, isWithoutText && s.onlyMedia])}">` +
      metadataHtml(msg, direction) +
      reactionsHtml(msg) +
      `</footer>`
    const messageClass = cls([
      'message',
      direction,
      s.message,
      msg.viewType === 'Sticker' && 'type-sticker',
      (STATUS[msg.state] === 'error' || msg.error != null) && 'error',
      msg.isForwarded && 'forwarded',
    ])
    // not-fully-downloaded messages get the app's placeholder, not the stub
    // text pretending to be the message
    const DOWNLOAD_LABEL: any = {
      Available: 'not downloaded',
      InProgress: 'downloading…',
      Failure: 'download failed',
      Undecipherable: 'cannot decrypt',
    }
    const body =
      msg.downloadState && msg.downloadState !== 'Done'
        ? `<div class="download">${esc(msg.text || '')} — ${DOWNLOAD_LABEL[msg.downloadState] || esc(msg.downloadState)}</div>`
        : (msg.quote ? quoteHtml(msg.quote) : '') +
          attachmentHtml(msg, hasText) +
          (msg.viewType === 'Vcard' ? vcardHtml(msg) : '') +
          (msg.viewType === 'Webxdc'
            ? `<div class="html-export-note">webxdc app${msg.fileName ? ` “${esc(msg.fileName)}”` : ''} — app content is not part of the export</div>`
            : '') +
          (hasText
            ? `<div dir="auto" class="text">${renderText(msg.text)}</div>`
            : '') +
          (msg.hasHtml
            ? '<div class="html-export-note">full HTML message — not part of the export</div>'
            : '')
    return (
      `<li class="message-wrapper"><div class="${messageClass}" id="${msg.id}">` +
      avatar +
      `<div class="msg-container" style="border-color: ${esc(msg.sender.color)};">` +
      authorOrForwarded +
      `<div class="msg-body">` +
      body +
      footer +
      `</div></div></li>`
    )
  }

  const dayMarkerHtml = (ts: number) =>
    `<li class="info-message daymarker"><div class="bubble" style="text-transform: capitalize;">${esc(fmtDay(ts))}</div></li>`

  // --- render ---
  document.title = data.chat.name
  const headerAvatar = document.getElementById('header-avatar')
  if (headerAvatar) {
    headerAvatar.outerHTML = avatarHtml(
      {
        profileImage: data.chat.profileImage,
        color: data.chat.color,
        displayName: data.chat.name,
        address: '',
      },
      false
    )
  }
  const nameEl = document.getElementById('header-name')
  if (nameEl) {
    nameEl.textContent = data.chat.name
  }
  const subtitleEl = document.getElementById('header-subtitle')
  const messageCount = data.items.filter(
    (item: any) => item.kind === 'message'
  ).length
  if (subtitleEl) {
    subtitleEl.textContent = `${messageCount} messages · exported ${new Date(data.exportedAt).toLocaleString()}`
  }
  const list = document.getElementById('export-message-list')
  if (list) {
    list.innerHTML = data.items
      .map((item: any) => {
        if (item.kind === 'dayMarker') {
          return dayMarkerHtml(item.timestamp)
        }
        const msg = data.messages[item.msg_id]
        return msg ? messageHtml(msg) : ''
      })
      .join('\n')
  }

  // --- click on a reactions cluster: who reacted with what (like the app's
  // reactions dialog); the title attribute above covers the static snapshot ---
  if (list) {
    list.addEventListener('click', event => {
      const cluster = (event.target as Element).closest?.(
        '[data-reactions-msg]'
      )
      if (!cluster) {
        return
      }
      const msg =
        data.messages[cluster.getAttribute('data-reactions-msg') as any]
      if (!msg || !msg.reactions) {
        return
      }
      const rows = Object.entries(msg.reactions.reactionsByContact || {})
        .map(([contactId, emojis]) => {
          const contact = reactionContact(contactId)
          return (
            `<div class="html-export-reactions-row">` +
            avatarHtml(contact, false) +
            `<span class="html-export-reactions-name">${esc(contact.displayName)}</span>` +
            `<span class="html-export-reactions-emoji">${esc((emojis as string[]).join(' '))}</span></div>`
          )
        })
        .join('')
      const backdrop = document.createElement('div')
      backdrop.className = 'html-export-dialog-backdrop html-export-ui'
      backdrop.innerHTML =
        '<div class="html-export-dialog" role="dialog" aria-modal="true">' +
        '<h2>Reactions</h2>' +
        rows +
        '<div class="html-export-dialog-actions">' +
        '<button type="button" class="html-export-save-button" data-action="close">Close</button>' +
        '</div></div>'
      document.body.appendChild(backdrop)
      const close = () => backdrop.remove()
      ;(
        backdrop.querySelector('[data-action="close"]') as HTMLButtonElement
      ).addEventListener('click', close)
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) {
          close()
        }
      })
    })
  }

  // --- toolbar: transcript download + single-file snapshot with dialog ---
  const deliverFile = (name: string, contents: BlobPart, type: string) => {
    const file = new File([contents], name, { type })
    const webxdc = (window as any).webxdc
    if (webxdc && webxdc.sendToChat) {
      // inside a webxdc viewer: hand the file back into a chat
      return Promise.resolve(
        webxdc.sendToChat({ file: { name, blob: file } })
      ).catch(() => {})
    }
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return Promise.resolve()
  }

  // plain-text transcript regenerated from the embedded data (same shape as
  // the zip's messages.txt)
  const buildTranscript = () => {
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = (ts: number) => {
      const d = new Date(ts * 1000)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    const lines = [
      data.chat.name,
      `exported ${new Date(data.exportedAt).toLocaleString()}`,
    ]
    for (const item of data.items) {
      if (item.kind === 'dayMarker') {
        lines.push('', `── ${fmtDay(item.timestamp)} ──`, '')
        continue
      }
      const msg = data.messages[item.msg_id]
      if (!msg) {
        continue
      }
      if (msg.isInfo) {
        lines.push(`* ${msg.text || ''}`)
        continue
      }
      const filePart =
      msg.file && msg.downloadState === 'Done'
        ? `[${msg.fileName || 'attachment'}] `
        : ''
      lines.push(
        `[${stamp(msg.timestamp)}] ${authorName(msg.sender.displayName, msg.overrideSenderName)}: ${filePart}${msg.text || ''}`
      )
    }
    return lines.join('\n') + '\n'
  }
  const txtButton = document.getElementById(
    'save-txt-button'
  ) as HTMLButtonElement | null
  if (txtButton) {
    txtButton.addEventListener('click', () => {
      txtButton.disabled = true
      deliverFile(
        (document.title || 'chat') + '.txt',
        buildTranscript(),
        'text/plain'
      ).then(() => {
        txtButton.disabled = false
      })
    })
  }

  const inlineMedia = (el: Element) => {
    const src = el.getAttribute('src')
    if (!src || /^(data:|https?:)/.test(src)) {
      return Promise.resolve(true)
    }
    return (
      fetch(src)
        .then(r =>
          r.ok ? r.blob() : Promise.reject(new Error('http ' + r.status))
        )
        .then(
          blob =>
            new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(reader.result)
              reader.onerror = () => reject(reader.error)
              reader.readAsDataURL(blob)
            })
        )
        .then(dataUrl => {
          el.setAttribute('src', dataUrl as string)
          return true
        })
        // keep the relative media/ reference (e.g. on file://, where fetch is
        // blocked — the snapshot then still works next to the media directory)
        .catch(() => false)
    )
  }

  const snapshot = (statusEl: HTMLElement) =>
    new Promise<void>(resolve => {
      const root = document.documentElement.cloneNode(true) as HTMLElement
      // strip everything that only exists for the interactive viewer: the
      // scripts (incl. the data island) and the toolbar/dialog ui
      root
        .querySelectorAll('script, .html-export-ui')
        .forEach(el => el.remove())
      Promise.all(
        Array.from(
          root.querySelectorAll('img[src], audio[src], video[src]')
        ).map(inlineMedia)
      )
        .then(results => {
          const failed = results.filter(ok => !ok).length
          const html = '<!doctype html>\n' + root.outerHTML
          return deliverFile(
            (document.title || 'chat') + '.html',
            html,
            'text/html'
          ).then(() => {
            statusEl.textContent =
              failed > 0
                ? `Saved — but ${failed} media file(s) could not be embedded ` +
                  '(the browser blocks reading them when this page is opened ' +
                  'from disk). Keep the media folder next to the saved file, ' +
                  'or save again with the viewer served over HTTP or running ' +
                  'as a webxdc app.'
                : 'Saved. The file is fully self-contained.'
          })
        })
        .catch(error => {
          statusEl.textContent = 'Saving failed: ' + (error?.message || error)
        })
        // always settle, so the dialog buttons never get stuck on "Saving…"
        .then(resolve)
    })

  const staticButton = document.getElementById(
    'save-static-button'
  ) as HTMLButtonElement | null
  if (staticButton) {
    staticButton.addEventListener('click', () => {
      if (document.querySelector('.html-export-dialog-backdrop')) {
        return
      }
      staticButton.disabled = true
      const backdrop = document.createElement('div')
      backdrop.className = 'html-export-dialog-backdrop html-export-ui'
      backdrop.innerHTML =
        '<div class="html-export-dialog" role="dialog" aria-modal="true">' +
        '<h2>Save single-file HTML</h2>' +
        '<p>Bakes the whole chat — styles and media included — into one ' +
        'static HTML file that can be viewed anywhere, without JavaScript ' +
        'and without the media folder.</p>' +
        '<p class="html-export-dialog-status"></p>' +
        '<div class="html-export-dialog-actions">' +
        '<button type="button" class="html-export-save-button" data-action="cancel">Cancel</button>' +
        '<button type="button" class="html-export-save-button" data-action="save">Save</button>' +
        '</div></div>'
      document.body.appendChild(backdrop)
      const statusEl = backdrop.querySelector(
        '.html-export-dialog-status'
      ) as HTMLElement
      const cancelButton = backdrop.querySelector(
        '[data-action="cancel"]'
      ) as HTMLButtonElement
      const saveButton = backdrop.querySelector(
        '[data-action="save"]'
      ) as HTMLButtonElement
      const close = () => {
        backdrop.remove()
        staticButton.disabled = false
      }
      cancelButton.addEventListener('click', close)
      backdrop.addEventListener('click', event => {
        if (event.target === backdrop) {
          close()
        }
      })
      saveButton.addEventListener('click', () => {
        saveButton.disabled = true
        statusEl.textContent = 'Saving…'
        snapshot(statusEl).then(() => {
          saveButton.remove()
          cancelButton.textContent = 'Close'
        })
      })
    })
  }
}

function buildIndexHtml(
  chatName: string,
  css: string,
  dataJson: string,
  viewerSource: string
): string {
  return (
    `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(chatName)}</title>\n` +
    `<style>\n${css}\n</style>\n<style>\n${EXPORT_CSS}\n</style>\n</head>\n` +
    `<body class="html-export">\n` +
    `<header class="html-export-header"><span id="header-avatar"></span><div>` +
    `<h1 class="html-export-header-name" id="header-name"></h1>` +
    `<div class="html-export-header-subtitle" id="header-subtitle"></div>` +
    `</div><div class="html-export-buttons html-export-ui">` +
    `<button type="button" id="save-txt-button" class="html-export-save-button">Save transcript (.txt)</button>` +
    `<button type="button" id="save-static-button" class="html-export-save-button">Save single-file HTML</button>` +
    `</div></header>\n` +
    `<div class="message-list-and-composer"><div class="message-list-and-composer__message-list">` +
    `<div id="message-list"><ol id="export-message-list" aria-label="Messages"></ol></div>` +
    `</div></div>\n` +
    `<script id="chat-data" type="application/json">${dataJson}</script>\n` +
    `<script>\n;(${viewerSource})()\n</script>\n` +
    `</body>\n</html>\n`
  )
}

function buildMessagesTxt(
  chat: T.FullChat,
  items: T.MessageListItem[],
  messages: { [id: number]: T.Message },
  exportedAt: number,
  formatDate: ExportChatOptions['formatDate']
): string {
  const lines: string[] = [chat.name, `exported ${formatDate(exportedAt, 'llll')}`]
  for (const item of items) {
    if (item.kind === 'dayMarker') {
      lines.push('', `── ${formatDate(item.timestamp, 'LL')} ──`, '')
      continue
    }
    const msg = messages[item.msg_id]
    if (!msg) {
      continue
    }
    if (msg.isInfo) {
      lines.push(`* ${msg.text || ''}`)
      continue
    }
    const time = formatDate(msg.timestamp, 'YYYY-MM-DD HH:mm')
    const author = msg.overrideSenderName
      ? `~${msg.overrideSenderName}`
      : msg.sender.displayName
    const filePart =
      msg.file && msg.downloadState === 'Done'
        ? `[${msg.fileName || 'attachment'}] `
        : ''
    lines.push(`[${time}] ${author}: ${filePart}${msg.text || ''}`)
  }
  return lines.join('\n') + '\n'
}

function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .trim()
      .slice(0, 100) || 'chat'
  )
}

/**
 * Exports the chat as a zip download (viewer html + txt + json + media,
 * webxdc-compatible). Returns the filename.
 */
async function exportChatToZip(
  rpc: Rpc,
  blobUrl: (path: string) => string,
  save: (data: Uint8Array, name: string) => Promise<unknown>,
  chatId: number,
  options: ExportChatOptions
): Promise<string> {
  const { accountId, formatDate, signal } = options
  const range = { startTs: options.startTs, endTs: options.endTs }
  const onProgress = options.onProgress ?? (() => {})
  const checkCancelled = () => signal?.throwIfAborted()

  const chat = await rpc.getFullChatById(accountId, chatId)
  const items = await rpc.getMessageListItems(accountId, chat.id, false, true)
  onProgress(50)
  checkCancelled()

  const msgIds = items
    .filter(item => item.kind === 'message')
    .map(item => (item as { kind: 'message'; msg_id: number }).msg_id)

  const messages: { [id: number]: T.Message } = {}
  for (let i = 0; i < msgIds.length; i += CHUNK_SIZE) {
    const batch = await rpc.getMessages(accountId, msgIds.slice(i, i + CHUNK_SIZE))
    for (const [id, result] of Object.entries(batch)) {
      if (result.kind === 'message') {
        messages[Number(id)] = result
      }
    }
    onProgress(50 + Math.round((250 * i) / Math.max(msgIds.length, 1)))
    checkCancelled()
  }
  onProgress(300)

  // date-range filter (inclusive, unix seconds, user-local interpretation
  // done by the caller); day markers survive only when they still have a
  // kept message following them
  const inRange = (msg: T.Message) =>
    (range.startTs === null || msg.timestamp >= range.startTs) &&
    (range.endTs === null || msg.timestamp <= range.endTs)
  const keptIds = msgIds.filter(id => messages[id] && inRange(messages[id]))
  const keptIdSet = new Set(keptIds)
  const keptMessages: { [id: number]: T.Message } = {}
  for (const id of keptIds) {
    keptMessages[id] = messages[id]
  }
  const filteredItems = items.filter(
    item => item.kind !== 'message' || keptIdSet.has(item.msg_id)
  )
  for (let i = filteredItems.length - 1; i >= 0; i--) {
    if (
      filteredItems[i].kind === 'dayMarker' &&
      (i === filteredItems.length - 1 ||
        filteredItems[i + 1].kind === 'dayMarker')
    ) {
      filteredItems.splice(i, 1)
    }
  }

  // contacts behind reactions (reactionsByContact only carries ids) — the
  // viewer's who-reacted dialog needs their names/avatars
  const reactionContactIds = new Set<number>()
  for (const id of keptIds) {
    const reactions = messages[id]?.reactions
    if (reactions) {
      for (const contactId of Object.keys(reactions.reactionsByContact)) {
        reactionContactIds.add(Number(contactId))
      }
    }
  }
  let reactionContacts: { [id: number]: T.Contact } = {}
  if (reactionContactIds.size) {
    try {
      reactionContacts = await rpc.getContactsByIds(accountId, [
        ...reactionContactIds,
      ])
    } catch (error) {
      // degrade gracefully — the viewer falls back to '#<contactId>' labels
      console.warn('chat export: could not resolve reaction contacts:', error)
    }
  }

  // collect all referenced media into the zip's media/ directory
  const media = new MediaCollector(blobUrl)
  const files: { [memfsPath: string]: string } = {}
  const collect = async (path: string | null | undefined) => {
    if (path && !(path in files)) {
      const rel = await media.add(path)
      if (rel) {
        files[path] = rel
      }
    }
  }
  await collect(chat.profileImage)
  for (const contact of Object.values(reactionContacts)) {
    await collect(contact.profileImage)
  }
  let processed = 0
  for (const id of keptIds) {
    const msg = messages[id]
    if (msg) {
      if (msg.downloadState === 'Done') {
        await collect(msg.file)
      }
      await collect(msg.sender.profileImage)
      if (msg.quote?.kind === 'WithMessage') {
        await collect(msg.quote.image)
      }
    }
    processed++
    if (processed % 10 === 0) {
      onProgress(300 + Math.round((450 * processed) / keptIds.length))
      checkCancelled()
    }
  }
  onProgress(750)

  const css = await collectCss()
  checkCancelled()
  onProgress(850)

  const exportedAt = Date.now() / 1000
  const data = {
    exportedAt: new Date(exportedAt * 1000).toISOString(),
    chat,
    items: filteredItems,
    messages: keptMessages,
    files,
    reactionContacts,
    styles: options.styles,
  }
  // <-escape so no string inside the JSON can terminate the script tag
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c')
  const viewerSource = chatExportViewer
    .toString()
    .replace(/<\/script/gi, '<\\/script')
  const indexHtml = buildIndexHtml(chat.name, css, dataJson, viewerSource)
  const messagesTxt = buildMessagesTxt(
    chat,
    filteredItems,
    keptMessages,
    exportedAt,
    formatDate
  )

  const encoder = new TextEncoder()
  const zipEntries: Record<string, Uint8Array> = {
    'index.html': encoder.encode(indexHtml),
    'messages.txt': encoder.encode(messagesTxt),
    'messages.json': encoder.encode(JSON.stringify(data, null, 1)),
    // webxdc manifest: rename the zip to .xdc and it becomes a viewer app
    // that can be sent into a chat
    'manifest.toml': encoder.encode(
      // strip control chars (raw newlines would break the TOML string),
      // then escape backslash + quote
      `name = "${Array.from(chat.name)
        .filter(c => c.charCodeAt(0) >= 0x20)
        .join('')
        .replace(/[\\"]/g, '\\$&')}"\n`
    ),
  }
  // the chat avatar doubles as the webxdc icon (spec wants icon.png/icon.jpg)
  const avatarEntry = chat.profileImage
    ? media.entries.get(chat.profileImage)
    : undefined
  if (avatarEntry) {
    // the webxdc spec only knows icon.png / icon.jpg — skip other formats
    const lower = avatarEntry.name.toLowerCase()
    const ext = lower.endsWith('.png')
      ? 'png'
      : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
        ? 'jpg'
        : null
    if (ext) {
      zipEntries[`icon.${ext}`] = avatarEntry.data
    }
  }
  for (const { name, data: bytes } of media.entries.values()) {
    zipEntries[`media/${name}`] = bytes
  }

  // store-only: the bulk of the content is media that is already compressed
  const zip = zipSync(zipEntries, { level: 0 })
  onProgress(950)
  checkCancelled()

  const filename = `${sanitizeFilename(chat.name)} - ${formatDate(exportedAt, 'YYYY-MM-DD')}.zip`
  await save(zip, filename)
  onProgress(1000)
  // anonymous analytics — the user exported a chat, with or without a custom
  // date range (yes = at least one date was filled); no-op when analytics is off
  // guarded like __slothfulTrack: the file is already saved, so analytics must
  // never turn this into "export failed"
  try {
    analytics.event('chat_export', {
      custom_range:
        range.startTs !== null || range.endTs !== null ? 'yes' : 'no',
    })
  } catch {
    /* best-effort */
  }
  return filename
}
