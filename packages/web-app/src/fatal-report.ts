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
  origin?: string
  userAgent?: string
  displayMode?: string
}

export function fatalReportText({
  kind = '',
  details = '',
  version = '',
  commitHash = '',
  origin = '',
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
    // WHICH deployment, which the version alone does not answer: prod, next
    // and every PR preview can carry the same version, and a preview's origin
    // (pr-<n>.…) is the only thing that names the branch a report came from.
    // It has to be in the report body — a report may arrive from an origin
    // that isn't the one collecting it, and neither a Referer nor a CORS
    // Origin header survives the trip (the link is rel="noreferrer", and the
    // sink in SELFHOSTING.md drops request headers from its log on purpose).
    ['origin', origin],
    ['display', displayMode],
    ['browser', collapse(userAgent)],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
}

/** The worker's error text and its stack, joined without doubling the message.
 *
 * The stack is the evidence: "NotFoundError" alone has several plausible
 * origins (the sahpool install, the wasm fetch, a self-heal that failed) and
 * the frames say which. Engines disagree on what `stack` contains, which is
 * the whole reason this is a function and not a template string — V8 prefixes
 * the message to it, Firefox and Safari give frames only, so `stack` alone
 * loses the message on two of the three and `message + stack` repeats it on
 * the third. Anything that isn't an Error (a thrown string, a DOMException
 * without frames) still yields its message. */
export function fatalDetails(message = '', stack = ''): string {
  if (!stack) return message || 'unknown error'
  return stack.includes(message) ? stack : `${message}\n${stack}`
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
    url.searchParams.set('body', report)
    // Clipped, not whole: an init-error can carry a Rust panic with a
    // backtrace, and a URL that long is refused outright (GitHub answers 414
    // somewhere past 8000 characters). A clipped report that arrives beats a
    // complete one that doesn't — the full text stays on screen above the
    // button, copyable.
    //
    // Measured on the ENCODED url, never on the string's length: percent-
    // encoding inflates by up to 9x (one CJK character is "%E9%94%99"), so
    // clipping the report to n characters bounds nothing — a non-ASCII error
    // message still built a URL well past the limit. Shrink in proportion to
    // the overshoot, always by at least one character so this terminates.
    for (let body = report; body && url.href.length > MAX_URL; ) {
      const room = Math.floor(body.length * (MAX_URL / url.href.length))
      body = body.slice(0, Math.min(room, body.length - 1))
      url.searchParams.set('body', body)
    }
    return url.href
  } catch {
    return ''
  }
}

// Well under the ~8000 where GitHub starts answering 414, with room for an
// operator's own sink being stricter than that.
const MAX_URL = 6000

// Error strings can carry newlines (a Rust panic with a backtrace, a stack).
// One line per field keeps the block scannable in a paste, and stops a
// multi-line error from being mistaken for extra fields.
const collapse = (value: string) => String(value).replace(/\s+/g, ' ').trim()
