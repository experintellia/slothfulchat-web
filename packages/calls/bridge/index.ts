/**
 * bridge/ — thin glue connecting engine/ to the typed jsonrpc client
 * (rpc.placeOutgoingCall / acceptIncomingCall / endCall / iceServers /
 * callInfo) and the popup<->opener signaling relay (docs/calls.md).
 * Re-exported for packages/web-app/src/runtime.ts to consume.
 *
 * M0: package skeleton only — no feature logic yet. This placeholder exists
 * so the engine/ui/bridge split, the pnpm workspace wiring, and the web-app
 * build config are all exercised end to end before the real jsonrpc glue
 * lands in M1+.
 */
import type { CallSessionDescription } from '../engine/index.ts'

/** M0 scaffold placeholder — replaced by the real jsonrpc bridge (M1+). */
export function describeBridge(description?: CallSessionDescription): string {
  return description
    ? `calls-bridge skeleton (pending ${description.type})`
    : 'calls-bridge skeleton'
}
