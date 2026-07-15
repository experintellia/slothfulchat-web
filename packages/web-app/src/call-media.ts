// DOM-side call media helpers shared by the main window (runtime.ts) and the
// detached call popup (call-popup.ts). They live here — not in the calls
// bridge — because both need `document`/browser globals the bridge forbids.
import type { AudioCallMediaFactories } from '@slothfulchat/calls/bridge'

/** A disabled 2x2 black track for the always-negotiated video sender so our
 * SDP carries a real a=ssrc — iOS WebKit can't demux RTP on an SSRC it never
 * saw signaled, so a mid-call camera on an audio-started call would otherwise
 * render black there. calls-webapp equivalently sends a disabled camera. */
export const createPlaceholderVideoTrack: NonNullable<
  AudioCallMediaFactories['createPlaceholderVideoTrack']
> = () => {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  canvas.getContext('2d')?.fillRect(0, 0, 2, 2)
  const track = canvas.captureStream(1).getVideoTracks()[0]!
  track.enabled = false // encoder sends black keepalive frames, like calls-webapp's disabled camera
  return track
}
