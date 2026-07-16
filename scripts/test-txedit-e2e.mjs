// E2E for the in-app translation editor (packages/web-app/src/translation-editor.ts).
// Fully offline — boots the app to the onboarding screen (translated text, no
// account/network needed) and checks the two things most prone to silent
// regression:
//   (a) the editor opens in a SEPARATE popup window (so app modal dialogs can't
//       cover it), and
//   (c) editing a string LIVE-refreshes the app — the editor must use the
//       runtime handle captured at init, because the frontend deletes window.r
//       right after importing it, which would make the refresh a silent no-op.
//
// Modeled on scripts/test-web-app-e2e.mjs (serve.mjs, avoid-eval freeze,
// __coreSystemInfo boot gate).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const script = p => fileURLToPath(new URL(p, import.meta.url))
const APP_PORT = Number(process.env.APP_PORT ?? 8655)
const SENTINEL = 'SLOTHTX_SENTINEL_42'

const appServer = spawn('node', [script('../packages/web-app/serve.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
})
const cleanup = () => appServer.kill()
process.on('exit', cleanup)
const watchdog = setTimeout(() => {
  console.error('FAIL: watchdog (6 min) — test hung')
  cleanup()
  process.exit(1)
}, 360_000)
await new Promise(r => setTimeout(r, 600)) // let the server bind

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
page.on('pageerror', e => console.error('[pageerror]', e.message))
// upstream's avoid-eval.js breaks page.evaluate; freeze the real eval first.
await page.addInitScript(() => {
  Object.defineProperty(window, 'eval', { value: window.eval, writable: false })
})

let failed = false
try {
  await page.goto(`http://localhost:${APP_PORT}/main.html`)
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  console.log('OK: wasm core booted')

  // The onboarding screen renders translated text and populates the tx registry.
  const sel = '[data-testid=other-login-button],[data-testid=create-account-button]'
  await page.locator(sel).first().waitFor({ state: 'visible', timeout: 90_000 })

  // Resolve the tx key behind a visible string, from the editor's live registry.
  const picked = await page.evaluate(s => {
    const text = (document.querySelector(s)?.textContent || '').trim()
    const keys = window.__txRegistry && window.__txRegistry.get(text)
    return { text, key: keys ? [...keys][0] : null }
  }, sel)
  if (!picked.key) throw new Error(`no tx key for on-screen text ${JSON.stringify(picked.text)}`)
  console.log(`picked key=${picked.key} text=${JSON.stringify(picked.text)}`)

  // (a) Shortcut opens a real popup window hosting the editor panel.
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.keyboard.press('Control+Shift+L'),
  ])
  await popup.waitForLoadState('domcontentloaded')
  if ((await popup.title()) !== 'Translation editor')
    throw new Error(`popup title = ${await popup.title()}`)
  if ((await popup.locator('[role=dialog][aria-label="Translation editor"]').count()) !== 1)
    throw new Error('editor panel is not inside the popup window')
  console.log('OK (a): editor opened in a separate popup window')

  // (f) No close button — you close the popup window itself.
  if ((await popup.getByRole('button', { name: 'Close' }).count()) !== 0)
    throw new Error('editor still has a Close button')
  console.log('OK (f): no in-panel close button')

  // All editor dialogs are raised on the popup; fail if any hits the main window.
  let confirmOnPopup = false, confirmOnPage = false
  popup.on('dialog', async d => {
    if (d.type() === 'confirm') confirmOnPopup = true
    await d.accept(d.type() === 'prompt' ? 'xytest' : undefined)
  })
  page.on('dialog', async d => { confirmOnPage = true; await d.dismiss() })

  // (d) Nothing edited yet → every export/revert button is disabled.
  for (const name of ['Export XML', 'Export JSON', 'Export experimental', 'Revert all']) {
    if (!(await popup.getByRole('button', { name }).isDisabled()))
      throw new Error(`"${name}" should be disabled before any edit`)
  }
  console.log('OK (d): export/revert buttons disabled with no changes')

  // (c) Edit that key in the popup; the app must live-refresh.
  await popup.getByRole('searchbox').fill(picked.key)
  const input = popup.locator(`textarea[aria-label="${picked.key}"]`).first()
  await input.waitFor({ state: 'visible', timeout: 10_000 })
  await input.fill(SENTINEL)
  await input.press('Enter') // Enter saves (commits via blur -> onchange)

  await page.waitForFunction(
    ([k, s]) => window.static_translate(k) === s,
    [picked.key, SENTINEL],
    { timeout: 15_000 }
  )
  await page.locator(sel).filter({ hasText: SENTINEL }).first().waitFor({ state: 'visible', timeout: 15_000 })
  console.log('OK (c): Enter saves — live-applied to static_translate + on-screen text')

  // (2) Shift+Enter inserts a newline instead of saving.
  const ta = popup.locator(`textarea[aria-label="${picked.key}"]`).first()
  await ta.focus()
  await ta.press('End')
  await ta.press('Shift+Enter')
  if (!(await ta.inputValue()).includes('\n'))
    throw new Error('Shift+Enter did not insert a newline')
  console.log('OK (2): Shift+Enter inserts a newline')

  // (d) A normal (translatable) edit enables the normal exports + Revert all,
  // but not the experimental export.
  const enabled = async name => !(await popup.getByRole('button', { name }).isDisabled())
  if (!(await enabled('Export XML')) || !(await enabled('Export JSON')) || !(await enabled('Revert all')))
    throw new Error('translatable edit did not enable Export XML/JSON/Revert all')
  if (await enabled('Export experimental'))
    throw new Error('Export experimental should stay disabled for a translatable-only edit')
  console.log('OK (d): a translatable edit enables the normal exports, not experimental')

  // (e/f) Custom chooser: per-language counts, completion %, hidden-language
  // tag, and a "create language" row.
  await popup.getByRole('button', { name: 'Language' }).click()
  await popup.getByRole('listbox').waitFor({ state: 'visible', timeout: 5_000 })
  if ((await popup.getByRole('option').count()) < 10)
    throw new Error('language chooser has too few options (hidden locales missing?)')
  if ((await popup.locator('[role=option] span[title*="edited key"]').count()) < 1)
    throw new Error('chooser does not show a per-language change count')
  if ((await popup.locator('[role=option]').filter({ hasText: '%' }).count()) < 1)
    throw new Error('chooser does not show completion percentages')
  if ((await popup.getByText('hidden', { exact: true }).count()) < 1)
    throw new Error('chooser does not tag hidden (incomplete) languages')
  // Existing languages show their text direction; Arabic must read rtl (this is
  // the browser-independent RTL set, not Intl which isn't always available).
  const arRow = popup.getByRole('option').filter({ hasText: '(ar)' })
  if ((await arRow.count()) < 1) throw new Error('chooser is missing the Arabic row')
  if ((await arRow.filter({ hasText: 'rtl' }).count()) < 1)
    throw new Error('Arabic is not shown as rtl in the chooser')
  // Create form: code field + direction toggle + Add.
  if ((await popup.getByLabel('New language code').count()) !== 1)
    throw new Error('chooser is missing the create-language form')
  if ((await popup.getByRole('button', { name: 'Toggle text direction for the new language' }).count()) !== 1)
    throw new Error('create form is missing the direction toggle')
  await popup.keyboard.press('Escape') // close the menu
  console.log('OK (e/f): chooser shows counts, completion %, hidden tag, direction, create form')

  // (c) Experimental strings: badged, and edited ones export on their own button.
  const expKey = await page.evaluate(async () => {
    const r = await fetch('locales/_untranslated_en.json')
    return Object.keys(await r.json())[0]
  })
  await popup.getByRole('searchbox').fill(expKey)
  const expInput = popup.locator(`textarea[aria-label="${expKey}"]`).first()
  await expInput.waitFor({ state: 'visible', timeout: 10_000 })
  if ((await popup.getByText('experimental', { exact: true }).count()) < 1)
    throw new Error(`experimental key ${expKey} is not badged experimental`)
  await expInput.fill('SLOTHTX_EXP_1')
  await expInput.blur()
  await popup.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'Export experimental')
    return b && !b.disabled
  }, null, { timeout: 10_000 })
  console.log('OK (c): experimental key badged + Export experimental enabled')

  // (g) Category filters under the search bar. With the experimental filter on
  // (and no search term), every listed row must be an experimental key.
  const chip = name => popup.getByRole('button', { name, exact: true })
  await popup.getByRole('searchbox').fill('')
  await chip('experimental').click()
  await popup.locator('[role=dialog] code').first().waitFor({ state: 'visible', timeout: 5_000 })
  const expRows = await popup.locator('[role=dialog] code').count()
  // one "experimental" badge per row, plus the chip button's own label
  const expBadges = await popup.getByText('experimental', { exact: true }).count()
  if (expRows < 5 || expBadges < expRows)
    throw new Error(`experimental filter leaked non-experimental rows (${expBadges} badges / ${expRows} rows)`)
  // Switch to the stockstrings filter: a known core key must appear.
  await chip('experimental').click() // off
  await chip('stockstrings').click() // on
  await popup.getByRole('searchbox').fill('self')
  if ((await popup.locator('textarea[aria-label="self"]').count()) < 1)
    throw new Error('stockstrings filter hid the core key "self"')
  await chip('stockstrings').click() // off
  await popup.getByRole('searchbox').fill('')
  console.log('OK (g): untranslated/experimental/stockstrings filters work')

  // (a2) The inspect highlight must draw ABOVE the app's modal (top-layer)
  // dialogs — a plain high z-index can't, so it must join the top layer.
  await popup.getByRole('button', { name: 'Inspect element' }).click()
  const at = await page.evaluate(() => {
    const dlg = document.createElement('dialog')
    Object.assign(dlg.style, {
      margin: '0', padding: '0', border: '0',
      width: '100vw', height: '100vh', maxWidth: '100vw', maxHeight: '100vh',
      background: '#000',
    })
    const inner = document.createElement('div')
    Object.assign(inner.style, {
      position: 'absolute', left: '200px', top: '200px', width: '120px', height: '40px',
    })
    dlg.append(inner)
    document.body.append(dlg)
    dlg.showModal()
    const r = inner.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  await page.mouse.move(at.x, at.y)
  await page.mouse.move(at.x + 1, at.y) // nudge to fire a mousemove over the dialog
  await page.waitForFunction(() => {
    const hl = document.querySelector('[data-txedit=highlight]')
    if (!hl || !document.querySelector('dialog[open]')) return false
    if (getComputedStyle(hl).display === 'none') return false
    try { return hl.matches(':popover-open') } catch { return false }
  }, null, { timeout: 10_000 })
  console.log('OK (a2): inspect highlight is in the top layer, above a modal dialog')

  // (a) The "Revert all" confirm must appear in the editor's own popup window
  // (dialog handlers registered up top; the confirm/page flags are set there).
  await popup.getByRole('button', { name: 'Revert all' }).click()
  await page.waitForFunction(([k, s]) => window.static_translate(k) !== s, [picked.key, SENTINEL], { timeout: 15_000 })
  if (!confirmOnPopup) throw new Error('Revert-all confirm did not appear on the popup window')
  if (confirmOnPage) throw new Error('Revert-all confirm appeared on the main window, not the popup')
  console.log('OK (a): Revert-all confirm shown in the popup, not the main window')

  // (e) Create an RTL language on the fly via the form. Thanks to the
  // getLocaleData English-base fix the app actually switches to the created
  // locale (previously it fell back to English) and picks up the RTL direction.
  await popup.getByRole('button', { name: 'Language' }).click()
  await popup.getByLabel('New language code').fill('xytest')
  await popup.getByRole('button', { name: 'Toggle text direction for the new language' }).click() // ltr -> rtl
  await popup.getByRole('button', { name: '+ Add' }).click()
  await page.waitForFunction(
    () =>
      window.localeData &&
      window.localeData.locale === 'xytest' &&
      window.localeData.dir === 'rtl' &&
      document.documentElement.dir === 'rtl', // RTL reaches <html>, not just the wrapper div
    null,
    { timeout: 10_000 }
  )
  console.log('OK (e): created an RTL language on the fly — app renders it live (html dir=rtl)')

  // Created languages go at the END of the chooser (after the sorted shipped ones).
  await popup.getByRole('button', { name: 'Language' }).click()
  await popup.getByRole('listbox').waitFor({ state: 'visible', timeout: 5_000 })
  if (!/\(xytest\)/.test((await popup.getByRole('option').last().textContent()) || ''))
    throw new Error('created language is not at the end of the chooser')
  console.log('OK (e): created language appended at the end of the list')

  // ...and persist across a reload, like edits.
  await page.reload()
  await page.waitForFunction(() => window.__coreSystemInfo, null, { timeout: 120_000 })
  await page.locator(sel).first().waitFor({ state: 'visible', timeout: 90_000 })
  const [popup2] = await Promise.all([
    context.waitForEvent('page'),
    page.keyboard.press('Control+Shift+L'),
  ])
  await popup2.waitForLoadState('domcontentloaded')
  await popup2.getByRole('button', { name: 'Language' }).click()
  await popup2.getByRole('listbox').waitFor({ state: 'visible', timeout: 5_000 })
  if ((await popup2.getByRole('option').filter({ hasText: '(xytest)' }).count()) < 1)
    throw new Error('created language did not persist across reload')
  if (!/\(xytest\)/.test((await popup2.getByRole('option').last().textContent()) || ''))
    throw new Error('persisted created language is not at the end after reload')
  console.log('OK (e): created language persists across reload, still at the end')

  console.log('\nPASS: translation editor e2e')
} catch (e) {
  failed = true
  console.error('FAIL:', e.message)
} finally {
  clearTimeout(watchdog)
  await browser.close()
  cleanup()
  process.exit(failed ? 1 : 0)
}
