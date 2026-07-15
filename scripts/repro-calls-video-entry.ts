/**
 * Page-side entry for scripts/repro-calls-video.mjs — dev repro harness for
 * "mid-call camera enable arrives black on the peer" (web <-> DC iOS report).
 *
 * Creates two real AudioCallEngine instances back-to-back in ONE page (real
 * RTCPeerConnection + fake-device getUserMedia) and exposes `window.repro`
 * for the Node driver to poke via page.evaluate. Dev tooling only.
 */

import {
  AudioCallEngine,
  type AudioCallMediaFactories,
  type PeerConnectionLike,
} from '../packages/calls/engine/index.ts';

type Side = 'A' | 'B';

interface SideState {
  engine: AudioCallEngine;
  pc: RTCPeerConnection | null;
  errors: string[];
}

const sides: Partial<Record<Side, SideState>> = {};
const sdps: { offer?: string; answer?: string } = {};

function makeFactories(side: Side): AudioCallMediaFactories {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createPeerConnection: (config) => {
      const pc = new RTCPeerConnection(config);
      const s = sides[side];
      if (s) s.pc = pc;
      // late-bound: engine constructor runs before pc creation, so stash on
      // a pending slot too
      pending[side] = pc;
      return pc as unknown as PeerConnectionLike;
    },
    getDisplayMedia: (c) => navigator.mediaDevices.getDisplayMedia(c),
    // Disabled 2x2 black placeholder so the video m-line carries a real a=ssrc
    // (iOS/ssrc — matches the web-app factories).
    createPlaceholderVideoTrack: () => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      canvas.getContext('2d')?.fillRect(0, 0, 2, 2);
      const track = canvas.captureStream(1).getVideoTracks()[0]!;
      track.enabled = false;
      return track;
    },
  };
}

const pending: Partial<Record<Side, RTCPeerConnection>> = {};

function collectError(side: Side, label: string, e: unknown): void {
  const msg = `${side} ${label}: ${
    e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)
  }`;
  console.error('[repro]', msg);
  sides[side]?.errors.push(msg);
}

async function setupCall(opts: { aHasVideo?: boolean; bHasVideo?: boolean }): Promise<void> {
  // tear down any previous case
  sides.A?.engine.end();
  sides.B?.engine.end();
  delete sdps.offer;
  delete sdps.answer;

  const mk = (side: Side, hasVideo: boolean, cbs: object) => {
    const st: SideState = { engine: null as unknown as AudioCallEngine, pc: null, errors: [] };
    sides[side] = st;
    st.engine = new AudioCallEngine({
      iceServers: [],
      factories: makeFactories(side),
      hasVideo,
      gatherOptions: { overallTimeoutMs: 3000 },
      callbacks: {
        onError: (e) => collectError(side, 'onError', e),
        onDeviceSwitchError: (e) => collectError(side, 'onDeviceSwitchError', e),
        onScreenShareError: (e) => collectError(side, 'onScreenShareError', e),
        ...cbs,
      },
    });
    st.pc = pending[side] ?? null;
    return st;
  };

  const b = mk('B', opts.bHasVideo ?? false, {
    onLocalAnswer: (sdp: string) => {
      sdps.answer = sdp;
      void sides.A!.engine.provideAnswer(sdp).catch((e) => collectError('A', 'provideAnswer', e));
    },
  });
  const a = mk('A', opts.aHasVideo ?? false, {
    onLocalOffer: (sdp: string) => {
      sdps.offer = sdp;
      try {
        b.engine.receiveCall(sdp);
      } catch (e) {
        collectError('B', 'receiveCall', e);
        return;
      }
      void b.engine.accept().catch((e) => collectError('B', 'accept', e));
    },
  });

  void a.engine.placeCall().catch((e) => collectError('A', 'placeCall', e));
  // pc objects are created inside placeCall/accept; refresh refs lazily
  const refresh = () => {
    if (sides.A) sides.A.pc = pending.A ?? sides.A.pc;
    if (sides.B) sides.B.pc = pending.B ?? sides.B.pc;
  };
  setInterval(refresh, 100);
}

function states(): { a: string; b: string; errors: string[] } {
  if (sides.A) sides.A.pc = pending.A ?? sides.A.pc;
  if (sides.B) sides.B.pc = pending.B ?? sides.B.pc;
  return {
    a: sides.A?.engine.state ?? 'none',
    b: sides.B?.engine.state ?? 'none',
    errors: [...(sides.A?.errors ?? []), ...(sides.B?.errors ?? [])],
  };
}

async function setCameraEnabled(side: Side, enabled: boolean): Promise<void> {
  await sides[side]!.engine.setCameraEnabled(enabled);
}

/** The direct-vs-relay classifier (Firefox stats-shape check). */
async function route(side: Side): Promise<string> {
  return sides[side]!.engine.getConnectionRoute();
}

async function videoStats(side: Side): Promise<{
  out: Record<string, unknown> | null;
  inn: Record<string, unknown> | null;
}> {
  const pc = sides[side]!.pc!;
  const report = await pc.getStats();
  let out: Record<string, unknown> | null = null;
  let inn: Record<string, unknown> | null = null;
  report.forEach((s: any) => {
    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      out = {
        bytesSent: s.bytesSent,
        framesEncoded: s.framesEncoded,
        framesSent: s.framesSent,
        framesPerSecond: s.framesPerSecond ?? null,
        active: s.active,
      };
    }
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      inn = {
        bytesReceived: s.bytesReceived,
        framesDecoded: s.framesDecoded,
        framesReceived: s.framesReceived,
        framesPerSecond: s.framesPerSecond ?? null,
      };
    }
  });
  return { out, inn };
}

/** Grab a frame from `side`'s REMOTE (received) video track and measure luminance. */
async function grabRemoteFrame(side: Side): Promise<Record<string, unknown>> {
  const pc = sides[side]!.pc!;
  const recv = pc.getReceivers().find((r) => r.track && r.track.kind === 'video');
  if (!recv) return { error: 'no video receiver' };
  const stream = new MediaStream([recv.track]);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  document.body.appendChild(video);
  try {
    await video.play();
    await new Promise((r) => setTimeout(r, 700));
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return { error: 'no video dimensions', trackMuted: recv.track.muted };
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = data[i] + data[i + 1] + data[i + 2];
      sum += lum;
      if (lum > max) max = lum;
    }
    return {
      w,
      h,
      maxLum: max, // 0..765; uniformly black => ~0
      avgLum: Math.round(sum / (data.length / 4)),
      trackMuted: recv.track.muted,
    };
  } finally {
    video.remove();
  }
}

/** What a calls-webapp-style consumer would see: the ontrack streams[0]
 * association. Black-video theory: a trackless video transceiver offers no
 * a=msid, so the peer's video receiver track never joins the remote stream. */
function streamAssociation(side: Side): Record<string, unknown> {
  const s = sides[side]!;
  const remote = s.engine.state === 'none' ? null : (s.engine as any).remoteStream ?? null;
  const engineRemote: MediaStream | null = remote;
  const pc = s.pc!;
  const recvVideo = pc.getReceivers().find((r) => r.track?.kind === 'video')?.track ?? null;
  return {
    engineRemoteStreamTracks: engineRemote
      ? engineRemote.getTracks().map((t) => t.kind)
      : null,
    videoReceiverTrackInEngineStream:
      engineRemote != null && recvVideo != null ? engineRemote.getTracks().includes(recvVideo) : null,
  };
}

/** Transceiver/sender/track diagnostics for one side. */
function diag(side: Side): Record<string, unknown> {
  const pc = sides[side]!.pc!;
  return {
    connectionState: pc.connectionState,
    transceivers: pc.getTransceivers().map((t) => ({
      mid: t.mid,
      kind: t.receiver.track?.kind ?? null,
      direction: t.direction,
      currentDirection: t.currentDirection,
      senderTrack: t.sender.track
        ? {
            id: t.sender.track.id,
            kind: t.sender.track.kind,
            readyState: t.sender.track.readyState,
            enabled: t.sender.track.enabled,
            muted: t.sender.track.muted,
          }
        : null,
      encodings: t.sender.getParameters().encodings,
    })),
  };
}

/** The m=video section of a captured SDP, key lines only unless full=true. */
function videoSection(which: 'offer' | 'answer', full = false): string {
  const sdp = sdps[which];
  if (!sdp) return '(none)';
  const sections = sdp.split(/\r?\n(?=m=)/);
  const video = sections.find((s) => s.startsWith('m=video'));
  if (!video) return '(no m=video)';
  if (full) return video;
  return video
    .split(/\r?\n/)
    .filter((l) =>
      /^(m=video|a=mid|a=msid|a=sendrecv|a=recvonly|a=sendonly|a=inactive|a=ssrc|a=ssrc-group)/.test(l)
    )
    .join('\n');
}

(window as any).repro = {
  setupCall,
  states,
  setCameraEnabled,
  route,
  videoStats,
  grabRemoteFrame,
  diag,
  streamAssociation,
  videoSection,
  end: () => {
    sides.A?.engine.end();
    sides.B?.engine.end();
  },
};
console.log('[repro] ready');
