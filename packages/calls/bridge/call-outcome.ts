/**
 * bridge/call-outcome.ts — turns the core's `call_info(accountId, msgId)`
 * result into the fixed, content-free `CallResult` bucket the runtime reports
 * to `packages/web-app/src/analytics.ts` (docs/calls.md M5: "missed/busy/
 * timeout … via call_info").
 *
 * `busy`, `cancelled` and `error` are NOT derived here — they are known
 * locally the moment they happen (a second incoming call arriving while
 * already in one; the user hanging up before connecting; a local engine
 * failure) and the runtime's call manager reports them without ever calling
 * `call_info`. This module exists for the remaining, genuinely ambiguous
 * case: a call ended (or never connected) WITHOUT any local action we took,
 * so the only authority on *why* is the core's own call-state message.
 *
 * ── THE MAPPING (verified against `deltachat-jsonrpc/src/api/types/calls.rs`,
 *    vendored at `vendor/core`) ──────────────────────────────────────────────
 *
 * Core's `CallState` conflates directions asymmetrically — the SAME kind
 * means different things depending on who placed the call:
 *
 *   `Missed`   — INCOMING only: the caller canceled before we picked up, or
 *                we let it ring out. There is no outgoing `Missed`.
 *   `Declined` — INCOMING: we explicitly ended/declined before accepting.
 *              — OUTGOING: the call ended/went stale WITHOUT an explicit
 *                reject from the far end, i.e. it rang out unanswered — a
 *                real *timeout*, not a decline, despite the shared kind name.
 *   `Canceled` — OUTGOING only: the receiver explicitly rejected the call
 *                (core's naming, from the *placer's* point of view — nothing
 *                to do with a local ICE/network cancel). There is no incoming
 *                `Canceled` (an incoming call the caller cancels shows up as
 *                `Missed`, not `Canceled`).
 *   `Alerting`/`Active`/`Completed` — the call connected (or is still
 *                ringing) at core's own reckoning; the runtime only reaches
 *                for `call_info` after `CallEnded`/an unaccepted teardown, so
 *                seeing one of these here means our locally-tracked
 *                `connectedOnce` disagreed with core — defensively treated as
 *                the same "it rang out" default as the missing/malformed case.
 */

import type { CallDirection } from '../engine/index.ts'

/**
 * The fixed, content-free call-outcome bucket reported to
 * `packages/web-app/src/analytics.ts` (`trackCall`) — mirrored there as a
 * structural (not imported, to keep `packages/calls` free of a dependency on
 * `packages/web-app`) type, and enforced at runtime by that file's closed
 * `EVENTS` catalogue regardless of what TypeScript here allows through.
 */
export type CallResult =
  | 'connected'
  | 'missed'
  | 'busy'
  | 'declined'
  | 'timeout'
  | 'cancelled'
  | 'error'

/** The `kind` discriminator on `CallInfo.state` (core's `JsonrpcCallState`,
 * `#[serde(tag = "kind")]` — see `deltachat-jsonrpc/src/api/types/calls.rs`). */
export type CoreCallStateKind =
  | 'Alerting'
  | 'Active'
  | 'Completed'
  | 'Missed'
  | 'Declined'
  | 'Canceled'

export interface CallInfoState {
  kind: CoreCallStateKind
  /** Only present when `kind === 'Completed'`. Not used here (analytics never
   * reports duration) — kept for completeness/future use. */
  duration?: number
}

/** The shape `rpc.callInfo(accountId, msgId)` resolves to (core's `CallInfo`,
 * `#[serde(rename_all = "camelCase")]`). */
export interface CallInfoResult {
  sdpOffer: string
  hasVideo: boolean
  state: CallInfoState
}

/**
 * Map a `call_info` state to the analytics `CallResult` bucket, for a call
 * this device never locally observed reaching `connected` and never itself
 * declined/cancelled/errored. See the module doc for the per-direction
 * mapping table this implements.
 */
export function classifyCallOutcome(direction: CallDirection, state: CallInfoState): CallResult {
  if (direction === 'incoming') {
    switch (state.kind) {
      case 'Declined':
        return 'declined'
      case 'Missed':
      default:
        // Canceled/Alerting/Active/Completed are not expected on the incoming
        // side of an unconnected call — 'missed' is the safe, honest default
        // ("we don't actually know why, but we never picked up").
        return 'missed'
    }
  }
  // direction === 'outgoing'
  switch (state.kind) {
    case 'Canceled':
      return 'declined'
    case 'Declined':
    default:
      // Missed/Alerting/Active/Completed are not expected on the outgoing
      // side of an unconnected call — 'timeout' is the safe, honest default
      // ("it rang; nobody answered").
      return 'timeout'
  }
}
