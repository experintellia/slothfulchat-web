/**
 * Observable call-state machine (framework-agnostic, pure TS — no DOM/React
 * imports). This is the single source of truth for "where is the call right
 * now", consumed by the engine (which drives it) and by the UI (which observes
 * it).
 *
 * ── THE FIVE STATES (docs/calls.md) ───────────────────────────────────────────
 *
 *   idle       no call in progress (initial and, per instance, only-once state)
 *   ringing    signaling in flight, no media path yet, waiting on a human/peer:
 *                • outgoing — offer being prepared / sent, awaiting the answer
 *                  ("calling…", ringback)
 *                • incoming — an offer arrived, awaiting the local accept
 *                  (ringtone). We deliberately do NOT touch the mic yet.
 *   connecting both descriptions are (about to be) exchanged; ICE/DTLS handshake
 *              underway; no media flowing yet.
 *   connected  the peer connection reached `connected`; media is flowing.
 *   ended      terminal. Reached from ANY non-ended state (hang up, peer
 *              `CallEnded`, or failure). Once here the machine never moves again.
 *
 * ── WHY THIS IS THE RACE-FREEDOM PRIMITIVE ────────────────────────────────────
 *
 * `ended` is reachable from every non-ended state and is terminal, and
 * {@link CallStateMachine.transition} *silently ignores* any transition that is
 * not allowed from the current state (returning `false` rather than throwing).
 * Together these two facts mean teardown always wins: a late, in-flight async
 * continuation — an ICE-gather promise or a `connectionstatechange` event that
 * resolves *after* the user hung up — can call `transition('connected')` and it
 * is a harmless no-op, because the machine is already `ended`. The engine builds
 * its epoch-guarded orchestration on top of exactly this guarantee.
 */

export type CallState = 'idle' | 'ringing' | 'connecting' | 'connected' | 'ended';

export type CallDirection = 'outgoing' | 'incoming';

export interface CallStateChange {
  readonly from: CallState;
  readonly to: CallState;
}

/** Notified on every *effective* state change (never for same-state no-ops). */
export type CallStateListener = (state: CallState, change: CallStateChange) => void;

/**
 * Allowed forward transitions. `ended` is in every non-terminal state's set
 * (teardown always wins) and is itself terminal (empty set). Everything not
 * listed here is rejected by {@link CallStateMachine.transition} — including the
 * dangerous "resurrect a torn-down call" edges like `ended → connected`.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<CallState, ReadonlySet<CallState>>> = {
  idle: new Set<CallState>(['ringing', 'ended']),
  ringing: new Set<CallState>(['connecting', 'ended']),
  connecting: new Set<CallState>(['connected', 'ended']),
  connected: new Set<CallState>(['ended']),
  ended: new Set<CallState>(),
};

export class CallStateMachine {
  private currentState: CallState = 'idle';
  private readonly listeners = new Set<CallStateListener>();

  /** The current state. */
  get state(): CallState {
    return this.currentState;
  }

  /** True once the call has ended and no further transition is possible. */
  get isTerminal(): boolean {
    return this.currentState === 'ended';
  }

  /** Whether {@link transition} to `to` would be applied right now. */
  canTransition(to: CallState): boolean {
    return ALLOWED_TRANSITIONS[this.currentState].has(to);
  }

  /**
   * Attempt to move to `to`. Returns `true` if the state actually changed (and
   * listeners were notified), `false` if the transition was a no-op — either
   * because `to` equals the current state, or because it is not an allowed edge
   * from the current state (notably: ANY transition out of `ended`). Never
   * throws: an unexpected/late transition is by-design a silent no-op, which is
   * what makes teardown race-free.
   */
  transition(to: CallState): boolean {
    const from = this.currentState;
    if (to === from) {
      return false;
    }
    if (!ALLOWED_TRANSITIONS[from].has(to)) {
      return false;
    }
    this.currentState = to;
    this.notify(from, to);
    return true;
  }

  /**
   * Observe state changes. Returns an unsubscribe function. Does NOT fire
   * synchronously with the current state — read {@link state} for that. Safe to
   * (un)subscribe from within a listener: notification iterates a snapshot.
   */
  subscribe(listener: CallStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(from: CallState, to: CallState): void {
    const change: CallStateChange = { from, to };
    // Snapshot so a listener may (un)subscribe during dispatch without
    // mutating the set we are iterating.
    for (const listener of [...this.listeners]) {
      listener(to, change);
    }
  }
}
