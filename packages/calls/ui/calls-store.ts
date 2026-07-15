/**
 * `CallsUiStore` — the observable snapshot the React components in this
 * folder render from. One instance lives for the lifetime of the page,
 * driven one call at a time by whatever owns the active
 * `CallBridge`/`AudioCallEngine` via the imperative setters below; it exists
 * so the React tree has something to `useSyncExternalStore` against.
 * No DOM here — trivially unit-testable, unlike `mount.tsx`.
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
  /** Hot-switch mic mid-call (`AudioCallEngine.switchMicrophone`). */
  onSelectMicrophone(deviceId: string): void
  /** Hot-switch camera mid-call (`AudioCallEngine.switchCamera`; only
   * records the preference while screen-sharing — see that method's doc). */
  onSelectCamera(deviceId: string): void
  /** Toggle screen sharing (`AudioCallEngine.startScreenShare`/
   * `stopScreenShare`). Available on any connected/connecting call — the
   * video sender is always negotiated. */
  onToggleScreenShare(): void
  /** Toggle the local camera mid-call (`AudioCallEngine.setCameraEnabled`).
   * Available on ANY call, not just ones started with the camera on. */
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
      /** Remote avatar URL, or `null` for the initial-letter fallback. */
      remoteAvatarUrl: string | null
      /** Local ("You") avatar URL, or `null` for the initial-letter fallback. */
      localAvatarUrl: string | null
      /** The chat's theme color (hex); `null` until resolved. */
      avatarColor: string | null
      muted: boolean
      /** Whether this call STARTED with the camera on. Only seeds the initial
       * camera state — does NOT gate the camera/screen-share controls (the
       * video sender is always negotiated). Use `localHasVideo`/
       * `remoteHasVideo` to decide whether to render video tiles. */
      hasVideo: boolean
      /** Whether the local camera is currently ON — camera button pressed
       * state. Starts equal to `hasVideo`. */
      cameraOn: boolean
      /** A local video track is flowing (camera OR screen share) — gates the
       * local video tile. */
      localHasVideo: boolean
      /** A remote video track is flowing — gates remote video tile vs. ring. */
      remoteHasVideo: boolean
      /** Peer reports its mic muted (`mutedState` data channel) — drives the
       * remote muted-mic badge. */
      remoteAudioMuted: boolean
      /** Set once the peer's stream arrives (`onRemoteStream`). */
      remoteStream: MediaStream | null
      /** Local mic/camera stream; `null` while an incoming call is still
       * ringing (nothing acquired yet). */
      localStream: MediaStream | null
      /** Whether the outgoing video is currently a screen capture. */
      screenSharing: boolean
      /** Non-fatal screen-share failure; the call keeps running on whatever
       * video was flowing before (contrast the call-ending `error` below). */
      screenShareError: string | null
      /** Set on a fatal error; the call is already torn down at the engine
       * level, but the UI stays up (with a Close button) so the message is
       * readable instead of just vanishing. */
      error: string | null
      /** Smoothed 0..1 local-mic level; 0 until the local stream exists. */
      localLevel: number
      /** Smoothed 0..1 remote-peer level; 0 until `remoteStream` arrives. */
      remoteLevel: number
      /** Device picker options — empty until enumeration resolves (real
       * labels need a `getUserMedia` grant first), which `DevicePicker`
       * treats the same as "nothing to pick from". */
      microphones: CallDeviceInfo[]
      cameras: CallDeviceInfo[]
      /** Currently-selected mic/camera `deviceId`, or `null` before any
       * explicit selection (browser default in use). */
      selectedMicrophoneId: string | null
      selectedCameraId: string | null
      /** Non-fatal `switchMicrophone` failure; the previous mic keeps
       * flowing (contrast the call-ending `error` above). */
      deviceSwitchError: string | null
      /** Direct-vs-relay indicator, from the bridge's
       * `onConnectionRouteChanged`. `'unknown'` until connected + first poll.
       * Purely informational — never gates any control (see #93). */
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
   * any previous snapshot outright (one call at a time). */
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

  /** Mirror of `engine.subscribe`/`CallState`. Like every setter here, a
   * no-op while inactive — a stray late callback after `clear()` (e.g. a
   * meter tick mid-teardown) must not resurrect a cleared snapshot. */
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

  /** Remote avatar URL + theme color, resolved from `getBasicChatInfo`. */
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

  /** Mirror of `engine.cameraEnabled` after a camera toggle. */
  setCameraOn(cameraOn: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, cameraOn }
    this.notify()
  }

  /** Whether a local video track is flowing (camera OR screen share). */
  setLocalHasVideo(localHasVideo: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, localHasVideo }
    this.notify()
  }

  /** Whether a remote video track is flowing. */
  setRemoteHasVideo(remoteHasVideo: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, remoteHasVideo }
    this.notify()
  }

  /** Mirror of the engine's `onRemoteAudioMutedChanged`. */
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

  /** The peer's stream arrived (`onRemoteStream`); the overlay attaches it
   * to its `<audio>`/`<video>` sink. */
  attachRemoteStream(stream: MediaStream): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, remoteStream: stream }
    this.notify()
  }

  /** Mirror of `bridge.localStream` — pushed whenever a local track
   * (re)establishes: the stream *reference* stays stable across a
   * hot-switch/screen-share swap, so React would never notice the *track*
   * underneath changed; callers push explicitly instead. */
  setLocalStream(stream: MediaStream | null): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, localStream: stream }
    this.notify()
  }

  /** Mirror of the engine's `onScreenShareChanged` — also clears any stale
   * `screenShareError` (a successful toggle supersedes it). */
  setScreenSharing(sharing: boolean): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, screenSharing: sharing, screenShareError: null }
    this.notify()
  }

  /** `AudioCallEngine`'s `onScreenShareError` — non-fatal; the call keeps
   * running on whatever video was flowing before (contrast `showError`). */
  showScreenShareError(message: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, screenShareError: message }
    this.notify()
  }

  /** Mirror of the bridge's `onConnectionRouteChanged` (already deduped by
   * `ConnectionRouteMonitor`). */
  setConnectionRoute(route: ConnectionRoute): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, connectionRoute: route }
    this.notify()
  }

  /** Mirror of the bridge's `onLocalLevel` — smoothed 0..1 local mic level,
   * ~10x/sec once the local stream exists. */
  setLocalLevel(level: number): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, localLevel: level }
    this.notify()
  }

  /** Mirror of the bridge's `onRemoteLevel` — smoothed 0..1 remote level. */
  setRemoteLevel(level: number): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, remoteLevel: level }
    this.notify()
  }

  /** Replace the enumerated mic/camera lists (initial enumeration or a
   * mid-call `devicechange`). */
  setDevices(devices: { microphones: CallDeviceInfo[]; cameras: CallDeviceInfo[] }): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, microphones: devices.microphones, cameras: devices.cameras }
    this.notify()
  }

  /** Mirror of `engine.audioInputDeviceId` after a successful
   * `switchMicrophone`. Also clears any stale `deviceSwitchError`. */
  setSelectedMicrophone(deviceId: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, selectedMicrophoneId: deviceId, deviceSwitchError: null }
    this.notify()
  }

  /** The user's camera preference (see `CallsUiCallbacks.onSelectCamera`). */
  setSelectedCamera(deviceId: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, selectedCameraId: deviceId }
    this.notify()
  }

  /** `AudioCallEngine`'s `onDeviceSwitchError` — non-fatal; the previous
   * mic keeps flowing (contrast `showError`). */
  showDeviceSwitchError(message: string): void {
    if (!this.snapshot.active) return
    this.snapshot = { ...this.snapshot, deviceSwitchError: message }
    this.notify()
  }

  /** A fatal error tore the call down at the engine level; keep the UI up
   * with the message + a Close button (Close calls `clear()`). */
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
