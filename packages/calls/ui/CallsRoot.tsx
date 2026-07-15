/**
 * The single React tree mounted by the runtime. Renders nothing while no
 * call is active; switches between the incoming-ring dialog and the in-call
 * overlay purely off `CallsUiStore`'s snapshot — no local state, so it is
 * safe to mount once for the page's lifetime (`mount.tsx`).
 */
import { useSyncExternalStore } from 'react'
import { CallOverlay } from './CallOverlay.tsx'
import { IncomingCallRing } from './IncomingCallRing.tsx'
import type { CallsUiCallbacks, CallsUiStore } from './calls-store.ts'

export interface CallsRootProps {
  store: CallsUiStore
  callbacks: CallsUiCallbacks
}

export function CallsRoot({ store, callbacks }: CallsRootProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)

  if (!snapshot.active) return null

  // Only an *incoming, still-ringing* call gets the accept/decline ring;
  // everything else (including outgoing "calling…") renders the overlay.
  if (snapshot.direction === 'incoming' && snapshot.state === 'ringing') {
    return (
      <IncomingCallRing
        title={snapshot.title}
        error={snapshot.error}
        onAccept={callbacks.onAccept}
        onDecline={callbacks.onHangup}
      />
    )
  }

  return (
    <CallOverlay
      direction={snapshot.direction}
      state={snapshot.state}
      title={snapshot.title}
      remoteAvatarUrl={snapshot.remoteAvatarUrl}
      localAvatarUrl={snapshot.localAvatarUrl}
      muted={snapshot.muted}
      hasVideo={snapshot.hasVideo}
      cameraOn={snapshot.cameraOn}
      localHasVideo={snapshot.localHasVideo}
      remoteHasVideo={snapshot.remoteHasVideo}
      remoteAudioMuted={snapshot.remoteAudioMuted}
      remoteStream={snapshot.remoteStream}
      localStream={snapshot.localStream}
      screenSharing={snapshot.screenSharing}
      screenShareError={snapshot.screenShareError}
      error={snapshot.error}
      localLevel={snapshot.localLevel}
      remoteLevel={snapshot.remoteLevel}
      connectionRoute={snapshot.connectionRoute}
      microphones={snapshot.microphones}
      cameras={snapshot.cameras}
      selectedMicrophoneId={snapshot.selectedMicrophoneId}
      selectedCameraId={snapshot.selectedCameraId}
      deviceSwitchError={snapshot.deviceSwitchError}
      onHangup={callbacks.onHangup}
      onToggleMute={callbacks.onToggleMute}
      onSelectMicrophone={callbacks.onSelectMicrophone}
      onSelectCamera={callbacks.onSelectCamera}
      onToggleScreenShare={callbacks.onToggleScreenShare}
      onToggleCamera={callbacks.onToggleCamera}
    />
  )
}
