# Lowest-Latency Translator Architecture Decision

Verified: 2026-05-11

## Decision

For the lowest measured target text path, keep the warmed WebSocket raw-audio stream as `Fastest`, race three translation sockets by default, stream a 1.5 s priming lead-in before marking the session live, render translated output as text only, and keep WebRTC as a selectable comparison path.

For the best combined latency, file size, and memory profile, run any Tauri 2 spike only after the transport winner is clear. The spike should compare warmed WebSocket text output and WebRTC translation calls because the latest latency evidence no longer supports assuming WebRTC is fastest.

Keep:

- Electron for macOS and Windows packaging.
- React renderer UI.
- OpenAI API key only in Electron main.
- `gpt-realtime-translate` as the default model.
- No external application server.
- No database.

Current low-latency shape:

- Main process warms translation WebSockets to `/v1/realtime/translations`.
- Main process sends `session.update` with only `audio.output.language`.
- Renderer streams 10 ms 24 kHz PCM16 chunks in `Fastest`.
- Renderer marks `Fastest` as live after a 1.5 s priming lead-in.
- Renderer ignores translated audio and shows translated text only.
- WebRTC translation calls remain available in the `WebRTC` preset for comparison and network fallback.

This still satisfies the local-device architecture: Electron main acts as the trusted local credential boundary. There is no deployed server and no persistence layer.

## Size And Memory Decision

Current measured local artifacts:

| Artifact | Size |
| --- | ---: |
| `release/` | 830 MB |
| `release/mac-arm64` | 273 MB |
| `release/win-arm64-unpacked` | 346 MB |
| `node_modules` | 835 MB |
| `node_modules/electron` | 274 MB |
| `dist` | 240 KB |

The app code is small; the footprint is from Electron/Chromium packaging. Tauri's official positioning is "small, fast, secure" apps and says Tauri can be as small as 600 KB because it uses the OS native web renderer. Tauri uses WebView2 on Windows and WKWebView/WebKit on macOS, so the browser engine is mostly supplied by the OS instead of bundled with the app.

Recommended footprint sequence:

1. First keep Electron + warmed WebSocket PCM streaming.
   - Lowest implementation risk.
   - Current raw-audio smoke supports keeping WebSocket as the `Fastest` lane for target text.

2. Then prototype Tauri + WebRTC with the same UI.
   - Best chance to reduce app size and memory while preserving the WebRTC media path.
   - Windows is likely strong because WebView2 is Chromium-based.
   - macOS must be validated carefully because WKWebView behavior and media permissions can differ from Chromium.

3. Do not jump directly to full native Swift plus Windows native unless Tauri fails.
   - Native would minimize memory and install size further.
   - But it duplicates platform work and makes WebRTC/audio implementation much more expensive.

## Combined Architecture Ranking

| Option | Latency | File size | Memory | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Electron + WebSocket | Best measured target-text path so far | Poor | Poor | Low | Current `Fastest` path |
| Electron + WebRTC | Cleanest browser media path | Poor | Poor | Medium | Comparison preset |
| Tauri + WebRTC | Potentially best combined score | Good | Good | Medium-high | Best product target if spike passes |
| Tauri + WebSocket | Good | Good | Good | Medium | Size-first fallback, but not lowest latency |
| Full native WebRTC per OS | Potentially best | Best | Best | High | Only after proving shell overhead is the bottleneck |

## Why This Beats The Current WebSocket Path

The current WebSocket path has more local plumbing, but it produced the best measured target-text path in the latest app work.

Current path:

```text
mic -> Chromium getUserMedia -> AudioContext -> AudioWorklet downsample
    -> base64 encode -> renderer-to-main IPC -> JSON WebSocket
    -> OpenAI translation session -> JSON deltas -> renderer UI
```

WebRTC still removes per-audio-chunk IPC, base64 encoding, JSON framing, manual 24 kHz chunk sizing, and manual backpressure. OpenAI's docs specifically recommend WebRTC when the browser captures or plays audio. The empirical issue is that WebRTC has not clearly beaten the warmed WebSocket target-text path, so the app should let measurements, not transport preference, choose `Fastest`.

## Official OpenAI Constraints

OpenAI's Realtime translation docs say:

- Use `gpt-realtime-translate` for translating human speech.
- Translation sessions connect to `/v1/realtime/translations`.
- Translation acts as an interpreter, not an assistant.
- Translation streams continuously from incoming audio.
- The app should not call `response.create`.
- Translation sessions select the target output language; source language is inferred from incoming audio.
- WebRTC is preferred when the browser captures or plays audio.
- WebSockets are for raw-audio pipelines and require base64 24 kHz PCM16 chunks.

The current app follows the WebSocket version correctly and keeps WebRTC available. The best latency path is whichever one wins p50/p95 target-text latency in the local smoke and app logs.

## Model Choice

| Model | Decision |
| --- | --- |
| `gpt-realtime-translate` | Use as default. It is the dedicated streaming speech-to-speech translation model. |
| `gpt-realtime-2` | Do not use for pure translation latency. It is for reasoning voice-agent workflows and tool use. |
| `gpt-realtime-mini` | Do not use as default. Consider only for low-cost assistant experiments, not the dedicated translator path. |
| `gpt-realtime-whisper` | Use only for optional live source transcription, not translation. |

## Implemented Shape

1. Main process exposes a local translation-call start method.
   - Calls `https://api.openai.com/v1/realtime/translations/client_secrets`.
   - Uses the standard API key in Electron main.
   - Returns only the short-lived secret to the renderer.

2. `Fastest` uses raced warmed WebSocket streams with 10 ms chunks.
   - Renderer calls `getUserMedia`.
   - Renderer sends audio chunks through the preload API to Electron main.
   - Main streams `session.input_audio_buffer.append` to three sockets by default.
   - Main also streams the same PCM chunks to a parallel Realtime transcription socket for the User text editor.
   - Main uses the winning socket for translated text and ignores duplicate output from losing sockets.

3. `WebRTC` remains available as its own preset.
   - Useful if WebSocket streaming behaves poorly on a machine or network.
   - Useful for debug because its events are explicit and easy to log.

4. Keep local browser speech-recognition preview out of authoritative latency claims.
   - It can improve perceived source text and enable narrow speculative target previews.
   - It does not improve actual Realtime translation latency.
   - Benchmarks must separate speculative UI latency from `/v1/realtime/translations` output latency.

5. Benchmark both paths with the same harness.
   - First target transcript delta.
   - End-of-utterance latency.
   - Reconnect latency.
   - p50/p95/p99, not one-off samples.
   - Korean and English target-language tests first; add other target languages after the transport decision is measured.

## If We Stay On WebSocket

The best WebSocket tuning is:

- Keep `gpt-realtime-translate`.
- Keep the warm socket.
- Keep `fast` mode as continuous streaming.
- Keep 10 ms chunks; test 5 ms only experimentally because it doubles message rate.
- Disable local speech preview for real latency benchmarks.
- Consider disabling `echoCancellation`, `noiseSuppression`, and `autoGainControl` for a "lab fastest" preset.
- Keep chunk dropping on backpressure.
- Add a p50/p95 log summarizer.

## If We Rewrite Native

A full native rewrite is not the first best move unless install size and memory are more important than delivery speed.

Native CoreAudio/WASAPI plus WebSocket would reduce some Electron overhead, but it keeps the less efficient JSON/base64/raw-PCM transport. Native WebRTC in C++/Swift/Rust could be excellent, but it is far more complex than using Chromium WebRTC inside Electron and would slow development materially.

Recommended sequence:

1. Electron + warmed WebSocket with PCM streaming.
2. Electron + WebRTC comparison runs.
3. Tauri spike only after the transport winner is clear.
4. Only consider native capture if Electron capture is measurably the bottleneck.

If the product must have the smallest possible footprint and can tolerate higher implementation cost, the native architecture should be:

- macOS: Swift or SwiftUI shell, CoreAudio or AVAudioEngine capture, native WebRTC library, Keychain for API key.
- Windows: WinUI 3 or lightweight native shell, WASAPI capture, native WebRTC library, Windows Credential Manager for API key.
- Shared core: Rust library for configuration, logging, metrics, and OpenAI REST client-secret creation where practical.

This is likely the smallest and lowest-memory final form, but it is not the fastest path to a correct product.

## Expected Result

The largest guaranteed win is removing startup latency by prewarming. The earlier WebSocket logs showed setup at roughly 551 ms to 1549 ms; warm sessions remove that from the user-perceived first utterance path.

The largest current app win is now implemented in `Fastest`: primed, raced warmed WebSocket streaming plus text-only translated output. It does not remove model inference latency or network RTT to OpenAI, so the acceptance gate must remain p50/p95 target-text latency, not one-off samples.

## Sources

- Realtime translation: https://developers.openai.com/api/docs/guides/realtime-translation
- Realtime WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- Realtime WebSocket: https://developers.openai.com/api/docs/guides/realtime-websocket
- Tauri 2.0 overview: https://v2.tauri.app/
- Tauri webview versions: https://v2.tauri.app/reference/webview-versions/
- `gpt-realtime-translate`: https://developers.openai.com/api/docs/models/gpt-realtime-translate
- `gpt-realtime-2`: https://developers.openai.com/api/docs/models/gpt-realtime-2
- `gpt-realtime-mini`: https://developers.openai.com/api/docs/models/gpt-realtime-mini
- `gpt-realtime-whisper`: https://developers.openai.com/api/docs/models/gpt-realtime-whisper
