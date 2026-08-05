// Generates dist/api-docs/index.html: reference for the JSON-RPC API of the
// core THIS build ships, read straight out of build/core (the pinned submodule
// with patches/core applied) — so it describes our actual runtime, not whatever
// version the published `@deltachat/jsonrpc-client` on npm happens to describe.
// Those two differ twice over: the pinned core is 2.54.0-dev (npm has no such
// release — it jumps 2.53.0 → 2.55.0), and patches/core adds methods and events
// on top of it. Self-hosters get the docs with the bundle; no network, no CDN.
//
// ponytail: this parses api.rs / events.rs with regexes instead of running the
// real generator (`cargo test -p deltachat-jsonrpc`, which emits the TS
// bindings). Ceiling: it knows nothing about the type *definitions* behind a
// name like `FullChat`, and its Rust→TS rendering is display-only. Upgrade
// path if that ceiling is ever hit: run the generator in CI (it already runs
// there — see the "ORDER TRAP #1" step) and feed typedoc the .d.ts instead.
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
// doc comments are plain prose + `code` spans + [`Type`] rustdoc links
const md = s =>
  esc(s)
    .replace(/\[`([^`]+)`\](?!\()/g, '`$1`')
    .replace(/`([^`]+)`/g, '<code>$1</code>')

const camel = s => s.replace(/_(\w)/g, (_, c) => c.toUpperCase())

/** Splits `a: u32, b: Vec<(u32, u32)>` on the commas that are at depth 0. */
function splitTop(s) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if ('<([{'.includes(c)) depth++
    else if ('>)]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out.map(p => p.trim()).filter(Boolean)
}

const PRIMITIVE = {
  u8: 'number', u16: 'number', u32: 'number', u64: 'number', usize: 'number',
  i8: 'number', i16: 'number', i32: 'number', i64: 'number', isize: 'number',
  f32: 'number', f64: 'number', bool: 'boolean', String: 'string', str: 'string',
  Value: 'any', '()': 'void',
}

/** Display-only Rust→TS rendering. Named types keep their Rust name, which is
 * also the generated TypeScript name (typescript-type-def keeps them). */
function tsType(rust) {
  let t = rust.trim().replace(/^&(mut )?/, '').replace(/^'\w+ /, '')
  if (PRIMITIVE[t]) return PRIMITIVE[t]
  const m = /^(\w+)<([\s\S]+)>$/.exec(t)
  if (m) {
    const [, outer, inner] = m
    const args = splitTop(inner)
    if (outer === 'Result' || outer === 'Arc' || outer === 'Box') return tsType(args[0] ?? '()')
    if (outer === 'Option') return `${tsType(args[0])} | null`
    if (outer === 'Vec') return `${tsType(args[0])}[]`
    if (['HashMap', 'BTreeMap'].includes(outer)) return `Record<${tsType(args[0])}, ${tsType(args[1])}>`
    if (['HashSet', 'BTreeSet'].includes(outer)) return `${tsType(args[0])}[]`
  }
  if (t.startsWith('(') && t.endsWith(')')) {
    const args = splitTop(t.slice(1, -1))
    return args.length ? `[${args.map(tsType).join(', ')}]` : 'void'
  }
  return t.replace(/^.*::/, '')
}

/** Body of the block that starts on the line matching `open`, up to the next
 * closing brace in column 0 (both files put every top-level item there). */
function block(src, open) {
  const lines = src.split('\n')
  const start = lines.findIndex(l => open.test(l))
  if (start < 0) throw new Error(`api-docs: no ${open} in source`)
  const end = lines.indexOf('}', start)
  return lines.slice(start + 1, end < 0 ? undefined : end)
}

/** RPC methods of `#[rpc] impl CommandApi`, grouped by the `// ---- Title ----`
 * banner comments the impl is already divided into. */
export function parseMethods(src) {
  const groups = []
  let group = { title: 'General', methods: [] }
  let doc = []
  let expectTitle = false
  const lines = block(src, /^#\[rpc\(/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*\/\/\s*-{5,}\s*$/.test(line)) {
      expectTitle = true
      continue
    }
    const docLine = /^\s*\/\/\/ ?(.*)$/.exec(line)
    if (docLine) {
      doc.push(docLine[1])
      expectTitle = false
      continue
    }
    const comment = /^\s*\/\/\s*(.+?)\s*$/.exec(line)
    if (comment) {
      if (expectTitle) {
        if (group.methods.length) groups.push(group)
        group = { title: comment[1], methods: [] }
        expectTitle = false
      }
      continue
    }
    if (/^\s*#\[/.test(line)) continue // attributes don't break a doc block
    if (!/^\s*(?:pub\s+)?async\s+fn\s/.test(line)) {
      if (line.trim()) doc = []
      expectTitle = false
      continue
    }

    // signature may wrap over several lines; it ends at the opening brace
    let sig = line
    while (!sig.trimEnd().endsWith('{') && i + 1 < lines.length) sig += ' ' + lines[++i].trim()
    const name = /async\s+fn\s+(\w+)/.exec(sig)[1]
    const open = sig.indexOf('(')
    let depth = 0
    let close = open
    for (; close < sig.length; close++) {
      if (sig[close] === '(') depth++
      else if (sig[close] === ')' && --depth === 0) break
    }
    const params = splitTop(sig.slice(open + 1, close))
      .filter(p => !/^&?(mut )?self$/.test(p))
      .map(p => {
        const [, pname, ptype] = /^(\w+)\s*:\s*([\s\S]+)$/.exec(p) ?? [, p, 'unknown']
        return { name: camel(pname), type: tsType(ptype) }
      })
    const ret = /->\s*([\s\S]+?)\s*\{$/.exec(sig.slice(close).trimEnd())
    group.methods.push({ name: camel(name), rustName: name, params, returns: tsType(ret?.[1] ?? '()'), doc })
    doc = []
  }
  if (group.methods.length) groups.push(group)
  return groups
}

/** Variants of the `EventType` enum (the `kind`-tagged union the client emits). */
export function parseEvents(src) {
  const events = []
  let doc = []
  let fieldDoc = []
  let current = null
  for (const line of block(src, /^pub enum EventType\s*\{/)) {
    if (/^\s*#\[/.test(line)) continue
    const docLine = /^\s*\/\/\/ ?(.*)$/.exec(line)
    if (docLine) {
      ;(current ? fieldDoc : doc).push(docLine[1])
      continue
    }
    if (current) {
      if (/^\s{4}\},?\s*$/.test(line)) {
        current = null
        fieldDoc = []
        continue
      }
      const field = /^\s*(\w+)\s*:\s*(.+?),?\s*$/.exec(line)
      if (field) current.fields.push({ name: camel(field[1]), type: tsType(field[2]), doc: fieldDoc })
      fieldDoc = []
      continue
    }
    // `Unit,` / `Inline { msg: String },` / `Multiline {` (fields follow)
    const variant = /^\s{4}(\w+)\s*(?:\{(.+)\}\s*,?|(\{)|,)\s*$/.exec(line)
    if (variant) {
      const [, name, inline, multiline] = variant
      const event = { name, fields: [], doc }
      events.push(event)
      doc = []
      if (inline) {
        for (const f of splitTop(inline)) {
          const field = /^(\w+)\s*:\s*(.+)$/.exec(f)
          if (field) event.fields.push({ name: camel(field[1]), type: tsType(field[2]), doc: [] })
        }
      } else if (multiline) current = event
      continue
    }
    if (line.trim()) doc = []
  }
  return events
}

const docHtml = doc =>
  doc.join('\n').trim()
    ? `<div class="doc">${doc
        .join('\n')
        .trim()
        .split(/\n\s*\n/)
        .map(p => `<p>${md(p).replace(/\n/g, ' ')}</p>`)
        .join('')}</div>`
    : ''

const signature = m =>
  `<code class="sig"><b>${esc(m.name)}</b>(${m.params
    .map(p => `${esc(p.name)}: <i>${esc(p.type)}</i>`)
    .join(', ')}): <i>${esc(m.returns)}</i></code>`

function render({ version, commit, patches, groups, events }) {
  const methodCount = groups.reduce((n, g) => n + g.methods.length, 0)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SlothfulChat core JSON-RPC API</title>
<style>
  :root { --bg:#15171b; --panel:#1d2026; --line:#2c313a; --fg:#e6e8eb; --muted:#9aa3af; --accent:#3793ff; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.55 system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 16px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:1; }
  h1 { margin:0 0 4px; font-size:16px; font-weight:600; }
  header p { margin:0 0 8px; max-width:860px; color:var(--muted); font-size:12.5px; }
  header a { color:var(--accent); }
  input { width:100%; max-width:420px; padding:6px 10px; border-radius:8px; border:1px solid var(--line);
          background:var(--panel); color:var(--fg); font:inherit; font-size:13px; }
  main { padding:0 16px 60px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
       margin:26px 0 8px; padding-top:8px; border-top:1px solid var(--line); }
  article { padding:10px 12px; margin:6px 0; background:var(--panel); border:1px solid var(--line); border-radius:9px; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  .sig { display:block; overflow-x:auto; white-space:pre; }
  .sig b { color:var(--accent); font-weight:600; }
  .sig i { color:var(--muted); font-style:normal; }
  .doc { color:var(--fg); font-size:13.5px; }
  .doc p { margin:6px 0 0; }
  .doc code { background:#0f1114; padding:1px 4px; border-radius:4px; }
  ul.fields { margin:6px 0 0; padding-left:18px; color:var(--muted); font-size:13px; }
  ul.fields b { color:var(--fg); font-weight:500; }
  .empty { color:var(--muted); padding:20px 0; display:none; }
  :root:has(#q:not(:placeholder-shown)) h2 { display:none; }
</style>
</head>
<body>
<header>
  <h1>core JSON-RPC API <span style="color:var(--muted);font-weight:400">— ${esc(version)}${commit ? ` (${esc(commit)})` : ''}${patches ? ` + ${patches} patches` : ''}</span></h1>
  <p>Generated at build time from the core this bundle actually ships
  (<code>deltachat-jsonrpc</code> at the pinned commit, with our patch stack applied),
  so it describes the running API rather than the nearest published
  <code>@deltachat/jsonrpc-client</code> release. ${methodCount} methods, ${events.length} events.
  Reached from JS as <code>dc.rpc.&lt;method&gt;(…)</code>. See the
  <a href="../changelog/">changelog</a>.</p>
  <input id="q" type="search" placeholder="Filter methods and events…" autocomplete="off" aria-label="Filter">
</header>
<main>
${groups
  .map(
    g => `<h2>${esc(g.title)}</h2>
${g.methods.map(m => `<article data-k="${esc(m.name.toLowerCase() + ' ' + m.rustName)}">${signature(m)}${docHtml(m.doc)}</article>`).join('\n')}`
  )
  .join('\n')}
<h2>Events</h2>
${events
  .map(
    e => `<article data-k="${esc(e.name.toLowerCase())}"><code class="sig"><b>${esc(e.name)}</b></code>${docHtml(e.doc)}${
      e.fields.length
        ? `<ul class="fields">${e.fields
            .map(f => `<li><b>${esc(f.name)}</b>: <code>${esc(f.type)}</code>${f.doc.join(' ').trim() ? ' — ' + md(f.doc.join(' ').trim()) : ''}</li>`)
            .join('')}</ul>`
        : ''
    }</article>`
  )
  .join('\n')}
<p class="empty">No match.</p>
</main>
<script>
const q = document.getElementById('q')
const items = [...document.querySelectorAll('article')]
const empty = document.querySelector('.empty')
q.addEventListener('input', () => {
  const needle = q.value.trim().toLowerCase()
  let hits = 0
  for (const el of items) {
    const show = !needle || el.dataset.k.includes(needle)
    el.hidden = !show
    if (show) hits++
  }
  empty.style.display = hits ? 'none' : 'block'
})
</script>
</body>
</html>
`
}

/** Builds the page from a `build/core` worktree. */
export async function apiDocsHtml(coreDir, patches = 0) {
  const read = p => readFile(join(coreDir, p), 'utf-8')
  const version = /^version = "(.+)"$/m.exec(await read('Cargo.toml'))?.[1] ?? 'unknown'
  let commit = ''
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: coreDir, encoding: 'utf-8' }).trim()
  } catch {
    // worktree without git history — the version line alone still identifies it
  }
  return render({
    version,
    commit,
    patches,
    groups: parseMethods(await read('deltachat-jsonrpc/src/api.rs')),
    events: parseEvents(await read('deltachat-jsonrpc/src/api/types/events.rs')),
  })
}
