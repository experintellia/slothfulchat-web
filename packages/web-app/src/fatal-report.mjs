/**
 * The copyable technical block on the fatal-start dialog (runtime.ts's
 * showFatalDialog). Kept as plain .mjs beside the TS so it can be unit-tested
 * without a build, same as blob-response.mjs.
 *
 * When the core fails to start there is no app left to report from, and the
 * anonymous usage statistics deliberately cannot carry an arbitrary error
 * string (src/events.mjs is a closed catalogue). So the only route from "it
 * broke for me" to "we can see why" is the user copying this and pasting it
 * somewhere — which means it has to be complete enough to act on and short
 * enough that pasting it is not a chore. See issue #176.
 */

/** Compose the report. Every field is optional: a caller that has no version
 * (dev build) or no error text still gets a usable block rather than the
 * string "undefined". */
export function fatalReportText({
  kind = '',
  details = '',
  version = '',
  commitHash = '',
  userAgent = '',
  displayMode = '',
} = {}) {
  const build = [version, commitHash && commitHash.slice(0, 8)].filter(Boolean).join(' ')
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

// Error strings can carry newlines (a Rust panic with a backtrace, a stack).
// One line per field keeps the block scannable in a paste, and stops a
// multi-line error from being mistaken for extra fields.
const collapse = value => String(value).replace(/\s+/g, ' ').trim()
