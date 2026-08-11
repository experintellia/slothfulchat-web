/**
 * The copyable technical block on the fatal-start dialog (runtime.ts's
 * showFatalDialog). Kept free of DOM globals so it can be unit-tested without
 * a browser, same as blob-response.ts.
 *
 * When the core fails to start there is no app left to report from, and the
 * anonymous usage statistics deliberately cannot carry an arbitrary error
 * string (src/events.ts is a closed catalogue). So the only route from "it
 * broke for me" to "we can see why" is the user copying this and pasting it
 * somewhere — which means it has to be complete enough to act on and short
 * enough that pasting it is not a chore. See issue #176.
 */

/** Compose the report. Every field is optional: a caller that has no version
 * (dev build) or no error text still gets a usable block rather than the
 * string "undefined". */
export type FatalReportFields = {
  kind?: string
  details?: string
  version?: string
  commitHash?: string
  userAgent?: string
  displayMode?: string
}

export function fatalReportText({
  kind = '',
  details = '',
  version = '',
  commitHash = '',
  userAgent = '',
  displayMode = '',
}: FatalReportFields = {}): string {
  // leading hex run only: a dirty build's hash carries a suffix ('abc1234-dirty'),
  // and a blind slice(0, 8) would render it as 'abc1234-'
  const short = String(commitHash).match(/^[0-9a-f]+/)?.[0].slice(0, 8) ?? ''
  const build = [version, short].filter(Boolean).join(' ')
  return [
    ['failure', kind],
    ['details', collapse(details)],
    ['build', build],
    ['display', displayMode],
    ['browser', collapse(userAgent)],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
}

/** Where the dialog's "Report this" button goes: the instance's configured
 * support URL with the report prefilled as `?title=` / `?body=`. Those are
 * GitHub's own new-issue parameters, so a tracker URL needs no extra config —
 * and they are a plain query, so an operator with no tracker can point this at
 * a webserver route that just logs the request (see SELFHOSTING.md). Any
 * query the destination already carries (`?labels=bug`) is kept.
 *
 * Returns '' when there is no destination or nothing to report — the caller
 * then shows no button at all, rather than one that goes nowhere. `new URL`
 * inside a try: `supportUrl` is validated at build time, but config.js is a
 * plain file a self-hoster can edit, and a throw here would take down the one
 * dialog that has to render when everything else is broken. */
export function fatalReportUrl(supportUrl = '', report = '', kind = ''): string {
  if (!supportUrl || !report) return ''
  try {
    const url = new URL(supportUrl)
    url.searchParams.set('title', kind ? `Could not start: ${kind}` : 'Could not start')
    // Clipped, not whole: an init-error can carry a Rust panic with a
    // backtrace, and a URL that long is refused outright (GitHub answers 414).
    // A clipped report that arrives beats a complete one that doesn't — the
    // full text stays on screen above the button, copyable.
    url.searchParams.set('body', report.slice(0, 1500))
    return url.href
  } catch {
    return ''
  }
}

// Error strings can carry newlines (a Rust panic with a backtrace, a stack).
// One line per field keeps the block scannable in a paste, and stops a
// multi-line error from being mistaken for extra fields.
const collapse = (value: string) => String(value).replace(/\s+/g, ' ').trim()
