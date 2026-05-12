# OpenAI Realtime Low-Latency Translator Research

Verified: 2026-05-11

## Goal

Build the lowest-latency translator that runs as a local desktop app on macOS and Windows, with no application server and no database. OpenAI Realtime inference still runs in OpenAI's cloud; "local-only" here means local capture, local UI, local API-key storage in Electron main, and a direct client-to-OpenAI connection.

## Official Realtime API Facts

OpenAI's live translation guide says translation sessions are different from voice-agent sessions:

- Translation connects to `/v1/realtime/translations`, not `/v1/realtime`.
- The model acts as an interpreter, not an assistant.
- Translation streams continuously from incoming audio.
- The app should not call `response.create`.
- Configure only the target output language. Source language is inferred from the incoming audio stream.
- For WebSockets, send base64-encoded 24 kHz PCM16 audio and play returned audio deltas yourself.

The WebSocket path follows that shape in `src/main/main.ts`: it opens `wss://api.openai.com/v1/realtime/translations?model=...`, sends `session.update` with `audio.output.language`, sends `session.input_audio_buffer.append` chunks, and renders translated text in the UI. The same PCM chunks are fanned out to a parallel Realtime transcription WebSocket using `gpt-realtime-whisper`, which emits `conversation.item.input_audio_transcription.*` events for the User text editor. The app connects that socket with `intent=transcription` and manually commits after local silence because the live handshake rejects a transcription session update on a normal realtime socket. The separate `WebRTC` preset uses `/v1/realtime/translations/client_secrets` and `/v1/realtime/translations/calls`.

## Model Selection

| Model | Best use here | Latency posture | Input | Output | Endpoint fit | Pricing basis |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-realtime-translate` | Primary translator model | Very fast | Audio | Audio, text | Dedicated `/v1/realtime/translations` | Audio duration, listed at `$0.034` per minute |
| `gpt-realtime-whisper` | Optional live source captions only | Very fast | Audio, text | Text | `/v1/realtime/transcription_sessions` | Audio duration, listed at `$0.017` per minute |
| `gpt-realtime-mini` | Lower-cost voice assistant or fallback experiments | Very fast | Text, image, audio | Text, audio | `/v1/realtime`; docs also list translation and transcription endpoints | Token pricing |
| `gpt-realtime-2` | Complex voice-agent workflows, not the fastest pure translator | Fast | Text, audio, image | Text, audio | `/v1/realtime`; docs also list translation and transcription endpoints | Token pricing |

Recommendation: keep `OPENAI_REALTIME_MODEL=gpt-realtime-translate` for this product. It is purpose-built for continuous speech-to-speech translation and avoids the extra response lifecycle used by voice-agent sessions. Use `gpt-realtime-whisper` only if the product needs a separate source-caption path without translated audio.

## Transport Decision

| Transport | Where OpenAI recommends it | Fit for this app | Latency notes |
| --- | --- | --- | --- |
| WebRTC | Browser/client media capture and playback | Available as a comparison preset | Avoids manual PCM resampling and playback; Electron main mints the short-lived client secret locally |
| WebSocket | Server-side or raw-audio pipelines | Current `Fastest` path after raw-audio tests showed earlier target output | Raced direct connections from Electron main; manual 24 kHz PCM16 chunks; explicit logs and backpressure |
| SIP | Telephony | Not needed | Useful for phone networks, not desktop microphone translation |

Because the requirement excludes an application server, Electron main acts as the local trusted credential boundary. It can keep the WebSocket raw-audio path warm without exposing the standard API key, and it can mint WebRTC translation client secrets for comparison testing.

## Local Runtime Architecture

Current WebSocket fallback path:

1. Renderer requests microphone with `getUserMedia`.
2. Renderer `AudioContext` uses `latencyHint: "interactive"` and `sampleRate: 24000`.
3. `public/audio-worklet.js` downsamples to PCM16 chunks.
4. Renderer sends chunks to Electron main over IPC.
5. Main process sends JSON WebSocket events to OpenAI.
6. Main receives target translation deltas from the translation session and source transcription deltas from the parallel transcription session.
7. UI updates source and target text.

Current lowest-latency app path:

1. Warm a Realtime translation WebSocket before opening microphone.
2. Wait for `session.updated` after sending only `audio.output.language`.
3. On Play, open microphone after the warmed session is ready.
4. Race three warmed translation sockets by default in `Fastest`; set `OPENAI_REALTIME_RACE_SOCKETS=1` to disable the extra cost.
5. Send 10 ms 24 kHz PCM16 chunks with no VAD in `Fastest`; browser echo cancellation, noise suppression, and auto gain are disabled in this preset to reduce capture latency.
6. Stream a 1.5 s priming lead-in before marking `Fastest` live.
7. Ignore returned translated audio in the renderer; translated output is text-only.
8. Measure first local speech, first source transcript delta, first target transcript delta, and optional speculative target preview latency.

WebRTC comparison path:

1. Warm a short-lived translation client secret before opening microphone.
2. On Play, start microphone acquisition in parallel with client-secret retrieval.
3. Start a WebRTC translation call from the renderer using `/v1/realtime/translations/calls`.
4. Send microphone audio as a WebRTC media track.
5. Ignore the remote audio track and consume transcript deltas over the data channel.
6. Measure first local speech, first source transcript delta, and first target transcript delta.

The app keeps VAD-enabled WebSocket PCM paths for `balanced` and `stable` modes. Previous WebSocket development logs showed first target transcript latency from local speech at roughly `718 ms`, `881 ms`, and `853 ms` on the best recorded fast sessions, with slower outliers above 2 seconds. WebSocket connection setup in those logs ranged from roughly `551 ms` to `1549 ms`, which is why warming matters.

Current WebRTC smoke tests show that target text can start while the speaker is still talking on longer utterances; a 3-run English-to-Korean smoke passed `LATENCY_GATE_METRIC=text` with `speechEndToTargetMs` below zero in all runs. Treat sub-500 text-after-speech-end as a subtitle responsiveness outcome, not proof of reliable sub-500 onset-based target text.

Because the translation endpoint accepts the target output language but rejects Realtime voice-agent tuning fields such as `audio.input.turn_detection`, `output_modalities`, and `audio.output.speed`, API-side latency tuning is limited. The app therefore adds a narrow speculative local phrase text preview for common Korean/English phrases while keeping `/v1/realtime/translations` as the authoritative translation stream. This preview starts as soon as local speech recognition produces a supported phrase and is measured separately from server output.

Go is now used as a router prototype for raw-audio or multi-language routing paths, not as the browser microphone path. The `router-go/` package defines a portable NDJSON frame schema, parse/format helpers, default target-language routing, bounded queues, drop reporting, and route-latency metrics. Its benchmark routes 10,000 frames and keeps p95 route overhead below 1 ms, comfortably inside the 700 ms budget, so any remaining latency belongs to capture, network, or model output rather than routing.

The Go realtime smoke uses the same `/v1/realtime/translations` WebSocket contract as the TypeScript fallback: it sends `session.update` with only `audio.output.language`, waits for `session.updated`, streams 10 ms `session.input_audio_buffer.append` chunks, detects speech onset from the generated PCM with RMS, and never sends `response.create`. The current app acceptance gate is target text, not translated-audio playback. Without the priming lead-in, normal-speed runs still showed higher tail latency, so the app marks `Fastest` as priming before it is live. This reinforces treating primed, raced raw WebSocket text output as the current fastest authoritative lane while keeping WebRTC as a comparison path.

The smoke harness pads the fake microphone file with post-utterance silence to avoid Chromium's fake-audio capture looping the same utterance during the latency window.

`gpt-realtime-mini` was also tested on the same translation endpoint. It produced occasional faster one-off target transcripts in earlier testing, but the corrected 3-run onset verifier still failed. On the longer English-to-Korean utterance, `gpt-realtime-mini` produced p50 `1102 ms` and p95 `1447 ms` from speech onset against a 700 ms target. Do not switch the default model for latency until a multi-run gate passes.

## CPU And Memory Targets

OpenAI does not publish desktop CPU or memory requirements for this API because inference runs remotely. The local workload is Electron, microphone capture, AudioWorklet PCM conversion, base64 encoding, IPC, WebSocket IO, and React rendering.

Minimum practical target:

| OS | CPU | Memory | Notes |
| --- | --- | --- | --- |
| macOS | Apple Silicon M1 or Intel quad-core laptop CPU | 8 GB RAM | M1 or newer should be comfortable. Intel Macs may run warmer because Electron and audio processing share fewer efficiency cores. |
| Windows | Modern x64 or ARM64 quad-core CPU | 8 GB RAM | Windows audio drivers vary more; keep chunking and backpressure configurable. |

Recommended target:

| OS | CPU | Memory | Notes |
| --- | --- | --- | --- |
| macOS | Apple Silicon M2/M3/M4 or newer | 16 GB RAM | Best target for stable low jitter while other apps are open. |
| Windows | Intel Core i5/i7 12th gen+, AMD Ryzen 5/7 5000+, or Snapdragon X-class ARM64 | 16 GB RAM | Best target for meetings, screen sharing, and Bluetooth audio devices. |

Expected local resource budget:

| Component | CPU expectation | Memory expectation |
| --- | --- | --- |
| Electron main + WebSocket | Low, usually network-bound | Tens of MB |
| Renderer + React UI | Low to moderate | 100 to 300 MB typical Electron renderer range |
| AudioWorklet resampling and RMS VAD | Low but latency-sensitive | Small buffers only |
| Base64 and IPC per 10 ms chunk | Low but frequent | Avoid large queues |

The app should remain usable on 8 GB systems, but 16 GB is the right recommendation for reliable latency under real desktop load.

## Lowest-Latency Implementation Plan

1. Use warmed WebSocket PCM for `Fastest`.
   - Electron main keeps the API key outside the renderer.
   - The renderer sends microphone chunks through IPC.
   - Main streams `session.input_audio_buffer.append` to three raced sockets by default.
   - The renderer ignores translated audio and shows target text only.

2. Keep `gpt-realtime-translate` as the default model.
   - It uses the dedicated translation endpoint.
   - It streams transcript deltas while source audio is still arriving; the app ignores translated audio.

3. Default to the current `fast` mode for latency testing.
   - Warm WebSocket translation session.
   - 10 ms PCM chunks.
   - Text-only translated output.

4. Keep `balanced` and `stable` WebSocket modes for fallback and network resilience.
   - Local VAD reduces uploaded silence.
   - Pre-roll preserves beginning of speech.
   - Stable mode raises the socket buffer threshold for bad networks.

5. Keep WebRTC as a selectable comparison path.
   - WebRTC returns transcript deltas over the data channel.
   - The app ignores WebRTC translated audio and uses the path only for text latency comparison.
   - Prefer WebRTC only if multi-run measurements beat the warmed WebSocket lane.

6. Use OS-specific native capture only if Electron media jitter becomes the bottleneck.
   - Current Electron `getUserMedia` is simpler and already cross-platform.
   - Native capture can reduce jitter but raises maintenance cost and installer complexity.

7. Use a fixed latency test harness before changing models or chunking.
   - Use the existing `logs/latency.ndjson`.
   - Compare p50/p95 for `translation_client_secret_ready`, `webrtc_remote_description_set`, and `first_target_transcript_delta`.
   - Use the text gate when intentionally validating speech-end-to-target subtitle latency.
   - Start with Korean and English in both target directions, then add more target languages only after the warm-start and first-target-latency path is stable.

## Current Gaps

| Gap | Impact | Proposed next step |
| --- | --- | --- |
| WebRTC reconnect handling is minimal | A failed peer connection ends the session | Keep it in the comparison preset and discard stale peer/data-channel output safely |
| Strict target-text latency still needs repeatable validation | Server output alone has not proven reliable under 500 ms from speech onset | Use the smoke harness as the gate and test only target-language directions until p50/p95 improve |
| Sub-500 target text requires speculation | Realtime translation output alone has not proven reliable under 500 ms | Keep speculative Korean/English phrase preview clearly provisional and replace it with server output |
| Source-language setting is local-only | The OpenAI translation session infers source language, so source-language UI should not create API test matrix growth | Keep API tests target-language focused and use the source setting only for local preview behavior |

## Sources

- OpenAI Realtime translation guide: https://developers.openai.com/api/docs/guides/realtime-translation
- OpenAI Realtime WebSocket guide: https://developers.openai.com/api/docs/guides/realtime-websocket
- OpenAI Realtime transcription guide: https://developers.openai.com/api/docs/guides/realtime-transcription
- OpenAI model catalog: https://developers.openai.com/api/docs/models
- `gpt-realtime-translate` model page: https://developers.openai.com/api/docs/models/gpt-realtime-translate
- `gpt-realtime-whisper` model page: https://developers.openai.com/api/docs/models/gpt-realtime-whisper
- `gpt-realtime-mini` model page: https://developers.openai.com/api/docs/models/gpt-realtime-mini
- `gpt-realtime-2` model page: https://developers.openai.com/api/docs/models/gpt-realtime-2
