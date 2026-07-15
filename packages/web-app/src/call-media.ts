// DOM-side call media helpers shared by the main window (runtime.ts) and the
// detached call popup (call-popup.ts). They live here — not in the calls
// bridge — because both need `document`/browser globals the bridge forbids.
import type { AudioCallMediaFactories } from '@slothfulchat/calls/bridge'

// Firefox negotiates H264 through the on-demand OpenH264 plugin and silently
// encodes nothing when it's unavailable — prefer codecs Firefox encodes
// natively (VP8/VP9/AV1). Chrome keeps hardware H264.
const caps = typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities?.('video')
const filtered = caps ? caps.codecs.filter(c => !/h264/i.test(c.mimeType)) : []
export const videoCodecPreferences: RTCRtpCodec[] | undefined =
  navigator.userAgent.includes('Firefox') && filtered.length > 0 ? filtered : undefined

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
