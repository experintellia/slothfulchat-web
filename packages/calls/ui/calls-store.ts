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
import type { CallDeviceInfo, CallDirection, CallState, ConnectionRoute } from '../engine/index.ts'

/** Callbacks the mounted UI invokes on user action; supplied by whatever owns
 * the active call (the runtime's call manager). */
export interface CallsUiCallbacks {
  /** Incoming ring only: the user accepted. */
  onAccept(): void
  /** Hang up / decline / dismiss-after-error. */
  onHangup(): void
  /** Toggle local mic mute. */
  onToggleMute(): void
  /** M2 device picker: the user picked a different mic — hot-switches
   * mid-call via `AudioCallEngine.switchMicrophone`/`replaceTrack`. */
  onSelectMicrophone(deviceId: string): void
  /** M2 device picker: the user picked a different camera — hot-switches
   * mid-call via `AudioCallEngine.switchCamera`/`replaceTrack` (M3; a no-op
   * beyond recording the preference while screen-sharing — see that
   * method's doc). */
  onSelectCamera(deviceId: string): void
  /** M3: toggle screen sharing on/off — `AudioCallEngine.startScreenShare`/
   * `stopScreenShare` via `RTCRtpSender.replaceTrack` on the outgoing video
   * sender. Available on any connected/connecting call (the video sender is
   * always negotiated — see `AudioCallEngine.addLocalTracks`). */
  onToggleScreenShare(): void
  /** M3 camera toggle: turn the local camera on/off mid-call via
   * `AudioCallEngine.setCameraEnabled` (`RTCRtpSender.replaceTrack` onto the
   * always-present video sender). Available on ANY call, not just ones started
   * with the camera on. */
  onToggleCamera(): void
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
      /** Remote participant's avatar image URL (resolved via the runtime's
       * blob path), or `null` for the initial-letter fallback (FIX 2). */
      remoteAvatarUrl: string | null
      /** Local ("You") avatar image URL — the self-account's profile image if
       * available, else `null` (initial-letter fallback). */
      localAvatarUrl: string | null
      /** The chat's theme color (hex), used as an accent where an avatar is
       * absent. `null` until resolved. */
      avatarColor: string | null
      muted: boolean
      /** Whether this call STARTED with the camera on (the caller's
       * audio-vs-video choice / the incoming offer's `has_video`). This only
       * seeds the initial camera state now — it does NOT gate the camera/
       * screen-share controls (both are available on any call, since the video
       * sender is always negotiated). Use `localHasVideo`/`remoteHasVideo` to
       * decide whether to render video tiles. */
      hasVideo: boolean
      /** Whether the local camera is currently ON (M3 camera toggle) — drives
       * the camera button's pressed state. Starts equal to `hasVideo`. */
      cameraOn: boolean
      /** Whether a local video track is actually flowing (camera on OR screen
       * sharing) — gates the local video tile. */
      localHasVideo: boolean
      /** Whether a remote video track is actually flowing — gates the remote
       * video tile (else the remote speaking ring). */
      remoteHasVideo: boolean
      /** Whether the peer reports its mic muted (the `mutedState` data
       * channel's `audioEnabled: false`) — drives the remote muted-mic badge. */
      remoteAudioMuted: boolean
      /** Set once the peer's audio (or audio+video, when `hasVideo`) track
       * arrives (`onRemoteStream`). */
      remoteStream: MediaStream | null
      /** The local mic/camera `MediaStream` (M3: local video preview tile).
       * `null` while an incoming call is still ringing (nothing acquired yet). */
      localStream: MediaStream | null
      /** Whether the outgoing video is currently a screen capture rather
       * than the camera (M3). Always `false` when `!hasVideo`. */
      screenSharing: boolean
      /** Set if the last screen-share start/stop failed
       * (`AudioCallEngine`'s `onScreenShareError`) — the call keeps running
       * on whatever video was flowing before; surfaced inline next to the
       * screen-share control, not as the call-ending `error` below. */
      screenShareError: string | null
      /** Set on a fatal error; the call is already torn down at the engine
       * level, but the UI stays up (with a Close button) so the message is
       * readable instead of just vanishing. */
      error: string | null
      /** Smoothed 0..1 voice level for the local mic (M2 speaking rings),
       * from the bridge's `onLocalLevel`. 0 until the local stream exists
       * (an incoming call still ringing has no mic yet). */
      localLevel: number
      /** Smoothed 0..1 voice level for the remote peer, from `onRemoteLevel`.
       * 0 until `remoteStream` arrives. */
      remoteLevel: number
      /** M2 device picker options — only populated once enumeration
       * resolves (needs a `getUserMedia` grant for real labels; the runtime
       * enumerates right after the local stream is acquired). Empty until
       * then, which `DevicePicker` treats the same as "nothing to pick from". */
      microphones: CallDeviceInfo[]
      cameras: CallDeviceInfo[]
      /** Currently-selected mic/camera `deviceId`, or `null` before any
       * explicit selection (browser default in use). */
      selectedMicrophoneId: string | null
      selectedCameraId: string | null
      /** Set if the last `switchMicrophone` hot-switch failed
       * (`AudioCallEngine`'s `onDeviceSwitchError`) — the call keeps running
       * on the previous mic; this is surfaced inline next to the picker, not
       * as the call-ending `error` above. */
      deviceSwitchError: string | null
      /** M5 direct-vs-relay indicator (docs/calls.md: "a non-blocking
       * direct-vs-relay connection indicator (active candidate pair is
       * 'relay')") — from the bridge's `onConnectionRouteChanged`.
       * `'unknown'` until the call is `connected` and the first poll
       * resolves. Purely informational — never gates any control, and
       * unrelated to any forced-relay setting (there is none; see #93). */
      connectionRoute: ConnectionRoute
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
   * any previous snapshot outright (one call at a time, M1). `hasVideo`
   * (M3) defaults to `false` — audio-only, matching the M1/M2 shape. */
  showCall(init: { direction: CallDirection; title: string; hasVideo?: boolean }): void {
    const hasVideo = init.hasVideo ?? false
    this.snapshot = {
      active: true,
      direction: init.direction,
      state: 'ringing',
      title: init.title,
      remoteAvatarUrl: null,
      localAvatarUrl: null,
      avatarColor: null,
      muted: false,
      hasVideo,
      cameraOn: hasVideo,
      localHasVideo: hasVideo,
      remoteHasVideo: false,
      remoteAudioMuted: false,
      remoteStream: null,
      localStream: null,
      screenSharing: false,
      screenShareError: null,
      error: null,
      localLevel: 0,
      remoteLevel: 0,
      microphones: [],
      cameras: [],
      selectedMicrophoneId: null,
      selectedCameraId: null,
      deviceSwitchError: null,
      connectionRoute: 'unknown',
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

  /** Remote participant's avatar URL + theme color, resolved from
   * `getBasicChatInfo` (FIX 2). Fresh-snapshot + notify, same pattern as the
   * others. */
  setRemoteAvatar(avatar: { url: string | null; color?: string | null }): void {
    if (!this.snapshot.active) return
    this.snapshot = {
      ...this.snapshot,
      remoteAvatarUrl: avatar.url,
      avatarColor: avatar.color ?? this.snapshot.avatarColor,
    }
    this.notify()
  }

  /** Local ("You") avatar URL — the self-account's profile image, if any. */
  setLocalAvatar(url: string | null): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, localAvatarUrl: url }
    this.notify()
  }

  /** Mirror of `engine.cameraEnabled` after a camera toggle (M3). */
  setCameraOn(cameraOn: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, cameraOn }
    this.notify()
  }

  /** Whether a local video track is actually flowing (camera on OR screen
   * sharing) — gates the local video tile. */
  setLocalHasVideo(localHasVideo: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, localHasVideo }
    this.notify()
  }

  /** Whether a remote video track is actually flowing — gates the remote
   * video tile vs. the remote speaking ring. */
  setRemoteHasVideo(remoteHasVideo: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, remoteHasVideo }
    this.notify()
  }

  /** Mirror of the engine's `onRemoteAudioMutedChanged` (the peer's
   * `mutedState` message) — drives the remote muted-mic badge. */
  setRemoteAudioMuted(remoteAudioMuted: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, remoteAudioMuted }
    this.notify()
  }

  /** Mirror of `bridge.muted`/`engine.muted` after a toggle. */
  setMuted(muted: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, muted }
    this.notify()
  }

  /** The peer's audio (or audio+video) stream arrived (`onRemoteStream`); the
   * overlay attaches it to its `<audio>`/`<video>` sink. */
  attachRemoteStream(stream: MediaStream): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, remoteStream: stream }
    this.notify()
  }

  /** Mirror of `bridge.localStream` (M3: local video preview) — pushed
   * whenever the local mic/camera track (re)establishes, since the stream
   * *reference* stays stable across a hot-switch/screen-share swap (see
   * `AudioCallEngine`'s `onLocalTrackChanged`/`onLocalVideoTrackChanged`) but
   * a plain reference-equality check wouldn't notice the *track* underneath
   * changed — so callers push explicitly rather than relying on React
   * re-rendering off an unchanged object identity. */
  setLocalStream(stream: MediaStream | null): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, localStream: stream }
    this.notify()
  }

  /** Mirror of `bridge.screenSharing`/`engine`'s `onScreenShareChanged` (M3) —
   * also clears any stale `screenShareError`, same pattern as
   * `setSelectedMicrophone` clearing `deviceSwitchError`. */
  setScreenSharing(sharing: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, screenSharing: sharing, screenShareError: null }
    this.notify()
  }

  /** `AudioCallEngine`'s `onScreenShareError` (M3) — a screen-share
   * start/stop failed; the call keeps running on whatever video was flowing
   * before (contrast `showError`, which is call-ending). */
  showScreenShareError(message: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, screenShareError: message }
    this.notify()
  }

  /** Mirror of `bridge`'s `onConnectionRouteChanged` (M5 direct-vs-relay
   * indicator) — pushed only when the route actually changes (the bridge's
   * `ConnectionRouteMonitor` already dedupes), same no-op-while-inactive guard
   * as every other setter here. */
  setConnectionRoute(route: ConnectionRoute): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, connectionRoute: route }
    this.notify()
  }

  /** Mirror of `bridge`'s `onLocalLevel` (M2 speaking rings) — smoothed 0..1
   * local mic level, ~10x/sec once the local stream exists. A no-op once the
   * call is no longer active, same guard as every other setter here (a stray
   * late tick from a meter mid-teardown must not resurrect a cleared snapshot). */
  setLocalLevel(level: number): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, localLevel: level }
    this.notify()
  }

  /** Mirror of `bridge`'s `onRemoteLevel` — smoothed 0..1 remote-peer level. */
  setRemoteLevel(level: number): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, remoteLevel: level }
    this.notify()
  }

  /** M2 device picker: replace the enumerated mic/camera lists (e.g. once
   * enumeration resolves, or on a `devicechange` event mid-call). */
  setDevices(devices: { microphones: CallDeviceInfo[]; cameras: CallDeviceInfo[] }): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, microphones: devices.microphones, cameras: devices.cameras }
    this.notify()
  }

  /** Mirror of `bridge.audioInputDeviceId`/`engine.audioInputDeviceId` after
   * a successful `switchMicrophone` (or the initial selection). Also clears
   * any stale `deviceSwitchError` — a successful switch supersedes it. */
  setSelectedMicrophone(deviceId: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, selectedMicrophoneId: deviceId, deviceSwitchError: null }
    this.notify()
  }

  /** The user's camera preference (M2 picker; no live track to switch until
   * M3's video calling lands — see `CallsUiCallbacks.onSelectCamera`). */
  setSelectedCamera(deviceId: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, selectedCameraId: deviceId }
    this.notify()
  }

  /** `AudioCallEngine`'s `onDeviceSwitchError` — a `switchMicrophone` call
   * failed; the previous mic keeps flowing untouched (contrast `showError`,
   * which is call-ending). */
  showDeviceSwitchError(message: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, deviceSwitchError: message }
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
