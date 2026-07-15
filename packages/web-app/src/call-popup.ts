/**
 * call-popup.ts — the entry bundle for the DETACHED call window (M4,
 * docs/calls.md §Windowing). Loaded by `dist/call-popup.html`, which the main
 * window opens with `window.open` (`CALL_POPUP_URL`). This window owns the
 * media + `RTCPeerConnection` + the call UI; it has NO access to the core
 * Worker (owned by the opener tab), so every SDP-bearing RPC travels to the
 * opener over the postMessage relay (`connectCallPopup` ⇄ `CallPopupHost`) and
 * the opener forwards it to the core.
 *
 * It is essentially the runtime's `CallManager`, but re-homed into the popup:
 * same `CallBridge`, same `CallsUiStore`/`mountCallsUi`, same device-picker and
 * speaking-ring wiring — only the `rpc` is the relayed `PopupRpcClient` instead
 * of `getCore().dc.rpc`, and core events arrive via `connection.onEvent`
 * instead of the in-page emitter. If `window.opener` is gone (opened directly,
 * or the opener navigated away) there is nothing to relay to, so the window
 * closes itself; the opener's overlay fallback covers the "popup never
 * handshaked" case from the other side.
 */
import {
  CallBridge,
  connectCallPopup,
  defaultMediaFactories,
  fetchIceServers,
  listInputDevices,
  windowSignalingPort,
  type CallBridgeCallbacks,
  type CallPopupInit,
  type CallState,
} from '@slothfulchat/calls/bridge'
import { CallsUiStore, mountCallsUi } from '@slothfulchat/calls/ui'

function main(): void {
  const opener = window.opener as Window | null
  if (opener == null || opener.closed) {
    // No opener to relay signaling to — this window can't run a call on its
    // own (the core Worker lives in the opener). Bail; the opener will have
    // fallen back to the in-page overlay.
    document.title = 'Call'
    window.close()
    return
  }

  const factories = defaultMediaFactories()
  const store = new CallsUiStore()
  const connection = connectCallPopup(windowSignalingPort(opener))

  let bridge: CallBridge | null = null
  let closing = false
  let devicesRefreshed = false
  let deviceChangeHandler: (() => void) | null = null
  // M5 (docs/calls.md: content-free call analytics): whether THIS popup's
  // engine ever reached `connected`. The popup has no analytics access of its
  // own (its CSP deliberately omits the analytics origin — see
  // `static/call-popup.html`), so this rides along on `reportEnded` and the
  // opener (`CallManager.reportCallOutcome`) does the actual classification.
  let reachedConnected = false

  const closeWindow = (): void => {
    if (closing) return
    closing = true
    connection.reportEnded(reachedConnected)
    if (deviceChangeHandler != null) deviceChangeHandler()
    connection.close()
    // Give the relayed endCall a beat to flush before the window tears down.
    setTimeout(() => window.close(), 150)
  }

  const hangup = (): void => {
    bridge?.hangup()
    closeWindow()
  }

  mountCallsUi(store, {
    // The popup never renders the incoming ring (ringing stays in the main
    // window per docs/calls.md); incoming calls are auto-accepted below. This
    // is only reachable if a stray click hits an accept control, and is a
    // no-op unless still ringing (`AudioCallEngine.accept` guards state).
    onAccept: () => {
      bridge?.accept().catch(err => console.error('popup accept failed', err))
    },
    onHangup: hangup,
    onToggleMute: () => {
      if (bridge != null) store.setMuted(bridge.toggleMuted())
    },
    onSelectMicrophone: deviceId => {
      const b = bridge
      if (b == null) return
      void b.switchMicrophone(deviceId).then(() => {
        if (b.audioInputDeviceId === deviceId) store.setSelectedMicrophone(deviceId)
      })
    },
    onSelectCamera: deviceId => {
      const b = bridge
      if (b == null) return
      void b.switchCamera(deviceId).then(() => {
        if (b.videoInputDeviceId === deviceId) store.setSelectedCamera(deviceId)
      })
    },
    onToggleScreenShare: () => {
      bridge?.toggleScreenShare().catch(err => console.error('popup screen share failed', err))
    },
    onToggleCamera: () => {
      const b = bridge
      if (b == null) return
      b.toggleCamera().then(
        () => syncLocalVideo(),
        err => console.error('popup camera toggle failed', err)
      )
    },
  })

  /** Re-sync the local-video-derived store fields from the bridge (M3, FIX 1). */
  const syncLocalVideo = (): void => {
    const stream = bridge?.localStream ?? null
    store.setLocalStream(stream)
    store.setLocalHasVideo((stream?.getVideoTracks().length ?? 0) > 0)
    store.setCameraOn(bridge?.cameraEnabled ?? false)
  }

  /** Track whether the remote peer is actually sending video (M3, FIX 1) — the
   * video m-line is always negotiated, so gate the remote tile on live flow. */
  const watchRemoteVideo = (stream: MediaStream): void => {
    const videoTrack = stream.getVideoTracks()[0] ?? null
    const apply = () => store.setRemoteHasVideo(videoTrack != null && !videoTrack.muted)
    apply()
    if (videoTrack != null) {
      videoTrack.addEventListener('mute', apply)
      videoTrack.addEventListener('unmute', apply)
      videoTrack.addEventListener('ended', apply)
    }
  }

  const refreshDevices = async (seedSelection: boolean): Promise<void> => {
    const devices = await listInputDevices()
    store.setDevices(devices)
    if (seedSelection) {
      const micId = bridge?.localStream?.getAudioTracks()[0]?.getSettings().deviceId
      if (micId) store.setSelectedMicrophone(micId)
      const camId = bridge?.localStream?.getVideoTracks()[0]?.getSettings().deviceId
      if (camId) store.setSelectedCamera(camId)
    }
  }

  let errored = false
  const onState = (state: CallState): void => {
    store.setState(state)
    if (state === 'connected') reachedConnected = true
    if (!devicesRefreshed && (state === 'connecting' || state === 'connected')) {
      devicesRefreshed = true
      void refreshDevices(true)
    }
    if (state === 'ended') {
      // Defer so a synchronous onError right after end() can keep the window up
      // with its error message; otherwise close the window.
      queueMicrotask(() => {
        if (!errored) closeWindow()
      })
    }
  }

  const onError = (message: string): void => {
    errored = true
    store.showError(message)
    // Window stays up with the error + a Close button (→ onHangup → closeWindow).
  }

  const callbacks = (init: CallPopupInit): CallBridgeCallbacks => ({
    onStateChange: state => onState(state),
    onRemoteStream: stream => {
      store.attachRemoteStream(stream)
      watchRemoteVideo(stream)
    },
    onError: err => onError(err.message || 'Call failed'),
    onLocalLevel: level => store.setLocalLevel(level),
    onRemoteLevel: level => store.setRemoteLevel(level),
    // M5: non-blocking direct-vs-relay indicator (docs/calls.md) — same
    // wiring as the main-window overlay path (runtime.ts).
    onConnectionRouteChanged: route => store.setConnectionRoute(route),
    onDeviceSwitchError: err => store.showDeviceSwitchError(err.message || 'Could not switch device'),
    onLocalVideoTrackChanged: () => syncLocalVideo(),
    onScreenShareChanged: sharing => {
      store.setScreenSharing(sharing)
      syncLocalVideo()
    },
    onScreenShareError: err => store.showScreenShareError(err.message || 'Could not share screen'),
    // For an outgoing call the opener already learns the message id from the
    // relayed placeOutgoingCall result; nothing extra to do popup-side.
    onCallMessageId: () => {
      void init
    },
  })

  connection.onEvent(event => {
    if (bridge == null) return
    if (event.type === 'answer') bridge.provideAnswer(event.acceptCallInfo)
    else if (event.type === 'remote-ended') bridge.remoteEnded()
    else if (event.type === 'accepted-elsewhere') bridge.acceptedElsewhere()
  })

  // Closing the window (X, Cmd-W) must hang up and notify the far end.
  window.addEventListener('pagehide', () => {
    bridge?.hangup()
    connection.reportEnded(reachedConnected)
  })

  void connection.init
    .then(async init => {
      document.title = init.title || 'Call'
      const iceServers = await fetchIceServers(connection.rpc, init.accountId)
      store.showCall({ direction: init.direction, title: init.title || 'Call', hasVideo: init.hasVideo })
      if (init.direction === 'outgoing') {
        bridge = CallBridge.outgoing(
          connection.rpc,
          { accountId: init.accountId, chatId: init.chatId, hasVideo: init.hasVideo, iceServers },
          factories,
          callbacks(init)
        )
        await bridge.start()
      } else {
        if (init.callMessageId == null || init.offerSdp == null) {
          onError('Malformed incoming call')
          return
        }
        const incoming = CallBridge.incoming(
          connection.rpc,
          {
            accountId: init.accountId,
            chatId: init.chatId,
            callMessageId: init.callMessageId,
            offerSdp: init.offerSdp,
            hasVideo: init.hasVideo,
            iceServers,
          },
          factories,
          callbacks(init)
        )
        bridge = incoming
        // The user already accepted in the main window's ring — go straight to
        // building the answer. start() (sync: register offer, ringing) and
        // accept() (sync: → connecting, then async mic) run back-to-back with no
        // await between them, so the store is past 'ringing' before the popup
        // paints: the accept/decline dialog never flashes here.
        void incoming.start()
        void incoming.accept().catch(err => onError(err instanceof Error ? err.message : String(err)))
      }
      // Re-enumerate on device hotplug for the life of the call.
      const handler = () => {
        void refreshDevices(false)
      }
      navigator.mediaDevices.addEventListener('devicechange', handler)
      deviceChangeHandler = () => navigator.mediaDevices.removeEventListener('devicechange', handler)
    })
    .catch(err => {
      console.error('call popup setup failed', err)
      onError(err instanceof Error ? err.message : String(err))
    })
}

main()
