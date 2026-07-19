# Better voice/audio messages — waveform, speed, mini-player, recording polish

Status: **planned** — nothing implemented yet. This doc is the phased plan,
grounded in the actual vendored desktop code (paths below are relative to
`vendor/deltachat-desktop/`, frontend root `packages/frontend/src/`).

## What & why

Voice-message UX is the strongest not-yet-built community wish that fits this
fork: waveform + seek ([forum 2726](https://support.delta.chat/t/prettier-voice-messages-visualize-waveform/2726),
[4223](https://support.delta.chat/t/improving-voice-message-listening-experience-global-player-and-waveform-display/4223)),
playback speed, resume-where-you-left-off ([4928](https://support.delta.chat/t/voice-messages-can-only-be-listened-to-in-their-entirety/4928)),
and recording polish ([1654](https://support.delta.chat/t/improvement-for-using-voice-messages/1654),
[352](https://support.delta.chat/t/add-option-to-record-messaging-without-holding-on-to-the-audio-recording-option/352)).
Everything is client-side — no core patch expected for any phase.

## What upstream already has (don't rebuild it)

Investigated 2026-07 in the pinned tree. More is there than the bare UI suggests:

- **Playback UI is a bare `<audio controls>`** — `components/AudioPlayer/index.tsx`
  (133 lines) + `ForceMutedAudioPlayer.tsx` (117 lines). Upstream's own comment in
  `AudioPlayer/styles.module.scss` says a fully custom audio element is the intent.
  Only two consumers: `attachment/messageAttachment.tsx` and
  `attachment/galleryAttachment.tsx`. **Small and cleanly swappable.**
- **Global player / mutex already exists.** `contexts/MediaPlayerMutexContext.tsx`
  holds a module-level singleton `<audio>` created *outside* React, so playback
  survives chat switches; each message bubble renders a *force-muted* mirror
  element (zero-gain `AudioContext`) synced to it. One-at-a-time playback and a
  persistent widget (`GlobalVoiceMessagePlayer`, mounted in `MainScreen.tsx`,
  which re-parents the singleton's native controls) are already there.
- **Auto-advance already exists.** `contexts/NextVoiceMessagePlayerContext.tsx`
  plays the next voice message in the chat on `ended` (via `getChatMedia`).
- **Recording already exists** (`components/AudioRecorder/`): `getUserMedia` +
  `ScriptProcessorNode` → real-time LAME MP3 encode (`@breezystack/lamejs`,
  already a dependency; 32 kbps `audio/mp3` — deliberately *not* `MediaRecorder`,
  whose Opus/WebM output iOS Safari can't play). Shows a timer and a 10-step RMS
  level meter. **No pause/resume, no preview-before-send.** Blob →
  `saveVoiceAsDraft` → temp file → `addFileToDraft(…, 'Voice')` → normal send.
- **No waveform anywhere, no Media Session usage, no speed/position persistence**
  (`AudioPlayer/index.tsx` explicitly syncs "with no regard for currentTime,
  playbackRate").

So the plan is: **replace the transport UI, extend the existing contexts** —
not build a player architecture.

## Constraints found (the honest part)

- **No metadata seam for sender-shipped waveform peaks.** `sendMsg`'s
  `MessageData` (`hooks/chat/useMessage.ts`) has no free-form field, and core's
  MIME layer isn't exposed through jsonrpc. Smuggling peaks into `text`/`html`
  would pollute vanilla clients. ⇒ **Peaks are computed receiver-side** from the
  decoded blob and **cached locally** (keyed by message id) so each message is
  decoded once. Sender-shipped peaks stay blocked until a core seam exists.
- **The dual-`<audio>` force-mute mirroring is load-bearing.** A custom transport
  must keep driving the mutex context's handlers (`onPlay/onPause/onSeeking/…`)
  and keep real `ended` events firing on the singleton, or one-at-a-time playback
  and auto-advance break.
- `runtime.transformBlobURL()` yields a URL, not bytes — waveform decode fetches
  it into an `ArrayBuffer` first.
- `ScriptProcessorNode` in the recorder is deprecated (works everywhere today).
  <!-- ponytail: keep it; upgrade path is AudioWorklet, only worth it if a browser actually removes it -->

## Phases

Each phase is independently shippable and gated behind an experimental setting
using the established mechanism (see `patches/desktop/0050`: key in
`shared-types.d.ts` + default in `state.ts` + `DesktopSettingsSwitch` row).
One toggle for the custom player (A1–A3), one for recording polish (B),
one for transcription (C).

### A1 — custom transport element (speed + seek + time)

Replace the `<audio controls>` body of `AudioPlayer`/`ForceMutedAudioPlayer`
with our own transport: play/pause button, plain seek bar (waveform comes in
A2), elapsed/total time, and a speed pill cycling 1× → 1.5× → 2×
(`audio.playbackRate`; pitch is preserved by default). Persist the chosen rate
globally in the mutex provider. Keep the exact context wiring and the
`<AudioPlayer src … onPlayNonProgrammatic>` prop shape so both consumers and
the mutex/auto-advance machinery are untouched.

*Why first:* smallest diff that creates the component every later phase renders
into; speed control alone is the highest value-to-effort item in the space.

### A2 — waveform + remembered position

- Peaks: fetch blob URL → `decodeAudioData` in a Web Worker
  (`OfflineAudioContext`), downsample to ~100 peak buckets, render as bars on a
  `<canvas>` that *is* the seek bar (click/drag = `currentTime`). Compute
  lazily on first render, cache the tiny peak array in IndexedDB keyed by
  message id.
- Position: persist `{messageId → currentTime}` (throttled) in the same store;
  restore on mount; clear on `ended`. This is the [4928] resume ask.
- Record-time waveform: reuse the same bar renderer fed by the recorder's
  existing RMS frames (upgrade of the current `VolumeMeter`).

### A3 — mini-player upgrade + Media Session

- Replace `GlobalVoiceMessagePlayer`'s re-parented native controls with the A1
  transport plus sender name/avatar and a jump-to-message click.
- Wire the Media Session API in `MediaPlayerMutexProvider`: metadata (sender,
  avatar as artwork) + `setActionHandler` for play/pause/seek/next — lock-screen
  and hardware media keys for free; "next" hooks the existing auto-advance.
- Ceiling (document in-app, not fixable): a closed tab/PWA cannot *start*
  playback in the background; and per
  [forum 5423](https://support.delta.chat/t/possible-privacy-flaw-audio-message-can-be-played-on-lock-screen/5423)
  the lock-screen metadata surface should be suppressible (setting).

### B — recording polish

- **Pause/resume**: small `MicRecorder` change — stop/resume feeding frames to
  the LAME encoder (start/stop exists today).
- **Preview-before-send**: on stop, play the draft blob in the A1 transport with
  send / re-record / discard, before `saveVoiceAsDraft`. Answers the oldest
  recording thread ([1654]).
- **Lock-to-record + slide-to-cancel**: pointer-gesture UI over the existing
  record button (parity with DC Android's swipe-up lock).
- **"Original audio" toggle** (from
  [forum 5411](https://support.delta.chat/t/add-a-toggle-for-original-audio-disable-webrtc-noise-suppression-during-calls/5411)):
  `getUserMedia({audio: {noiseSuppression: false, echoCancellation: false,
  autoGainControl: false}})`; constraints are advisory, so confirm via
  `track.getSettings()` and reflect the real state in the UI.

### C — on-device transcription (experimental, opt-in download)

See the Whisper appendix below for the numbers behind these choices.

- Runtime: **transformers.js (onnxruntime-web)** in a Web Worker. **WASM-SIMD is
  the default**; WebGPU only opportunistically (feature-detect + fall back —
  for tiny/base models WASM often beats WebGPU, and Android WebGPU is crashy).
- Models: **Whisper `base` multilingual** (~76–80 MB, hybrid fp32-encoder +
  q4-decoder) on desktop; **`tiny`** (~40 MB) on mobile. Never `small`+ on
  iOS (tab OOM ceiling ~300–500 MB).
- UX: a per-message "Transcribe" action; first use asks "Download voice
  transcription (~40/80 MB, one-time, stays on device)". Model fetched from our
  own origin, cached via the Cache API — **zero bytes added to the app bundle**.
  Transcripts cached per message id and used as the message's accessible label.
- Preprocessing: `decodeAudioData` → downmix mono → resample to 16 kHz via
  `OfflineAudioContext({sampleRate: 16000})` → `Float32Array`. (Our own voice
  messages are MP3, which decodes everywhere; incoming Opus from other clients
  needs an iOS `decodeAudioData` container check.)
- Honest expectations: desktop = a 30 s message in a few seconds; modern
  Android ≈ realtime with tiny/base but catch OOM and fail soft; tiny/base
  quality is decent for English, usable-but-rough for German/Spanish, poor for
  e.g. Russian/Arabic — say so in the setting's description.

### Explicitly not planned

- **Sender-shipped waveform/transcript metadata** — blocked, no jsonrpc/MIME
  seam (see Constraints). Revisit only if core grows one.
- **Web Speech API** for transcription — mic-only (can't take a blob),
  cloud-backed in Chrome/Safari, absent in Firefox.
- **Chrome's built-in Prompt API** audio transcription — attractive (no model
  download) but Chrome-desktop-only and still origin-trial; possible later as an
  optional fast path inside C.
- **Round/instant video messages** ([forum 5338](https://support.delta.chat/t/round-video-messages/5338)) —
  interesting, but a separate feature (plain video attachment + circular
  capture/playback UI), not part of the audio player work.

## Verification

Per phase, in the existing Playwright harness: A1 — speed pill changes
`playbackRate` and persists across messages; A2 — peaks cache hit on second
render (no re-decode), position restored after chat switch; A3 — audio keeps
playing across a chat switch, `navigator.mediaSession.metadata` populated;
B — pause/resume produces one contiguous MP3, preview plays before any draft
is added; C — a fixture WAV transcribes to expected text with the tiny model
(desktop CI only).

---

## Appendix: Whisper-in-the-browser numbers (researched 2026-07)

**Mobile performance.** Quantitative benchmarks are all desktop; mobile evidence
is qualitative but consistent: Chrome on a Pixel 6A (6 GB) has crashed loading
Whisper ([transformers.js #740](https://github.com/huggingface/transformers.js/issues/740));
iOS Safari's per-tab memory ceiling (~300–500 MB wasm heap, no shared-memory
threads) limits it to tiny/base. iOS 26 / Safari 26 does ship WebGPU, but
WebGPU ≠ automatically faster: on small models, well-optimized WASM-SIMD has
beaten WebGPU in maintainer benchmarks ([transformers.js #894](https://github.com/huggingface/transformers.js/issues/894):
whisper-base on 60 s audio, M2 — WASM 4.9–5.9 s vs WebGPU 9.5–27 s). The
oft-quoted "5–10× WebGPU speedup, 5–8× realtime for base" numbers are
desktop-class hardware.

**Bundle/model size.** Models (one-time download, Cache API — not in the JS
bundle): tiny ≈ 40 MB q8 / ~54 MB q4-split; base ≈ 76 MB hybrid / 80 MB q8;
small ≈ 120–240 MB (desktop-only territory); large-v3-turbo ≈ 800 MB+ (not
browser-viable on mobile). Runtime cost: onnxruntime-web's wasm artifact is
~19.5 MB default, reducible to ~8 MB (optimized) or ~3 MB (minimal build,
some CPU fallbacks) — also lazily fetched. whisper.cpp-wasm has a smaller
runtime (~1–2 MB, estimate) but no WebGPU and a 256 MB single-file limit on
Firefox.

**Languages.** Whisper nominally covers ~99 languages, but the good WER numbers
(3–6 % for ES/DE/FR/IT/PT) are **large-v3** figures. tiny/base degrade hard
outside English (~10–15 % English WER on tiny; German/Spanish usable-but-rough,
Russian/Arabic poor on tiny; base is the realistic multilingual floor). No
clean per-size × per-language WER table exists. distil-whisper is
**English-only**. Alternatives: Moonshine (27M, excellent English + streaming,
only ~8 languages), Vosk (~50 MB *per-language* models, real wasm build, lower
accuracy — viable if we ever want per-language packs).

**Built-in browser APIs.** Web Speech `SpeechRecognition` cannot transcribe a
recorded blob (mic-only), defaults to cloud processing in Chrome/Safari, and
doesn't exist in Firefox — disqualified. Chrome's on-device story
(`processLocally`, ~17 languages) and the multimodal Prompt API (Gemini Nano;
its documented example is literally "transcribe audio messages in a chat app")
are Chrome-desktop-only and pre-stable — optional fast path someday, not a
baseline.
