/**
 * ui/ — the React call surface (docs/calls.md): ring/incoming dialog, in-call
 * window (video tiles, avatar speaking-rings, mute/camera/screen controls,
 * device pickers, hangup, relay-connection indicator). Consumes engine/'s
 * observable call state; mounted by packages/web-app/src/runtime.ts.
 *
 * M0: package skeleton only — no feature UI yet. This placeholder exists so
 * the engine/ui/bridge split, the pnpm workspace wiring, and the web-app
 * build config (JSX + React resolution) are all exercised end to end before
 * the real components land in M1+.
 */
import type { CallSessionDescription } from '../engine/index.ts'

export interface CallsPlaceholderProps {
  /** Unused for now — threading an engine/ type through a prop here proves
   * ui/ can depend on engine/ (the direction docs/calls.md allows: "ui/
   * ...consumes the engine's observable call state"). */
  description?: CallSessionDescription
}

/** M0 scaffold placeholder — replaced by the ring overlay + in-call window
 * (M1+). Renders nothing. */
export function CallsPlaceholder(_props: CallsPlaceholderProps) {
  return null
}
