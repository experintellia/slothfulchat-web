/**
 * `CallsUiStore` — the tiny observable snapshot the React components in this
 * folder render from (docs/calls.md: ui/ "consumes the engine's observable
 * call state"). It is NOT the engine's `CallStateMachine` itself — one
 * `CallsUiStore` instance lives for the lifetime of the page (mounted once,
 * "always mounted in the main window" per docs/calls.md §Windowing) and is
 * driven, one call at a time, by whichever object owns the active
 * `CallBridge`/`AudioCallEngine` (the runtime's call manager): it forwards
 * `engine.subscribe(...)`/`onRemoteStream`/mute changes into this store via
 * the imperative setters below, and the store exists purely so the React tree
 * has something to `useSyncExternalStore` against without re-rendering the
 * whole app on every engine tick.
 *
 * No DOM manipulation here — that is what makes this file (unlike
 * `mount.tsx`) trivially unit-testable and reusable from a future popup
 * window (M4) with no changes.
 */
import type { CallDirection, CallState } from '../engine/index.ts'

/** Callbacks the mounted UI invokes on user action; supplied by whatever owns
 * the active call (the runtime's call manager). */
export interface CallsUiCallbacks {
  /** Incoming ring only: the user accepted. */
  onAccept(): void
  /** Hang up / decline / dismiss-after-error. */
  onHangup(): void
  /** Toggle local mic mute. */
  onToggleMute(): void
}

/** What the UI renders. `active: false` means nothing is mounted-visible
 * (the root component returns `null`, but the mount point itself stays in
 * the DOM — see `mount.tsx`). */
export type CallUiSnapshot =
  | { active: false }
  | {
      active: true
      direction: CallDirection
      state: CallState
      /** Chat/contact name, best-effort ("Call" until resolved). */
      title: string
      muted: boolean
      /** Set once the peer's audio track arrives (`onRemoteStream`). */
      remoteStream: MediaStream | null
      /** Set on a fatal error; the call is already torn down at the engine
       * level, but the UI stays up (with a Close button) so the message is
       * readable instead of just vanishing. */
      error: string | null
    }

const INACTIVE_SNAPSHOT: CallUiSnapshot = { active: false }

export class CallsUiStore {
  private snapshot: CallUiSnapshot = INACTIVE_SNAPSHOT
  private readonly listeners = new Set<() => void>()

  /** `useSyncExternalStore` subscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** `useSyncExternalStore` snapshot getter — must return the same reference
   * until the next `notify()`, which every setter below guarantees by always
   * producing a fresh object rather than mutating in place. */
  getSnapshot = (): CallUiSnapshot => this.snapshot

  /** Begin rendering a call: incoming ring or outgoing "calling…". Replaces
   * any previous snapshot outright (one call at a time, M1). */
  showCall(init: { direction: CallDirection; title: string }): void {
    this.snapshot = {
      active: true,
      direction: init.direction,
      state: 'ringing',
      title: init.title,
      muted: false,
      remoteStream: null,
      error: null,
    }
    this.notify()
  }

  /** Mirror of `engine.subscribe`/`CallState` — call from the state-change
   * callback. A no-op if no call is showing (e.g. a stray late callback after
   * `clear()`). */
  setState(state: CallState): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, state }
    this.notify()
  }

  /** Best-effort chat/contact name once resolved. */
  setTitle(title: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, title }
    this.notify()
  }

  /** Mirror of `bridge.muted`/`engine.muted` after a toggle. */
  setMuted(muted: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, muted }
    this.notify()
  }

  /** The peer's audio stream arrived (`onRemoteStream`); the overlay attaches
   * it to its `<audio>` sink. */
  attachRemoteStream(stream: MediaStream): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, remoteStream: stream }
    this.notify()
  }

  /** A fatal error tore the call down at the engine level; keep the UI up
   * with the message + a Close button (call `clear()` from the Close
   * handler, same as a normal hangup). */
  showError(message: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, error: message }
    this.notify()
  }

  /** Dismiss the UI (call ended/torn down and the owner is done with it). */
  clear(): void {
    if (!this.snapshot.active) return
    this.snapshot = INACTIVE_SNAPSHOT
    this.notify()
  }

  private notify(): void {
    // Snapshot so a listener may (un)subscribe during dispatch.
    for (const listener of [...this.listeners]) listener()
  }
}
