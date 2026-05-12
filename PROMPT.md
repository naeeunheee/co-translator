# Codex Goal Prompts

## Option 1: Fastest Practical Win

Use this if you want the shortest path to lower translation latency without changing the whole app shell yet.

```text
/goal Implement and benchmark a WebRTC-based OpenAI Realtime translation path inside the existing Electron app, while preserving the current WebSocket path as fallback.

Context:
- Project root: /Users/tonylee/solo/co-translator
- Current app: Electron + React + TypeScript realtime translator.
- Current transport: Electron main opens WebSocket to /v1/realtime/translations with OPENAI_REALTIME_MODEL=gpt-realtime-translate.
- Current audio path: renderer getUserMedia -> AudioContext -> AudioWorklet PCM16 downsample -> base64 -> IPC -> main -> JSON WebSocket.
- Current docs:
  - docs/realtime-low-latency-research.md
  - docs/lowest-latency-architecture-decision.md
- Current goal: reduce real translation latency as much as possible while keeping local-device-only architecture, no external server, no database.

Research before editing:
- Re-read OpenAI official docs for:
  - Realtime translation
  - Realtime WebRTC
  - Realtime WebSocket
  - gpt-realtime-translate
- Confirm current event names and endpoint shapes before implementation.

Implementation requirements:
1. Add an Electron main/preload API for creating a short-lived translation client secret.
   - Main process uses OPENAI_API_KEY.
   - Renderer must never receive the standard API key.
   - Use /v1/realtime/translations/client_secrets.
2. Add a renderer WebRTC translation session implementation.
   - Use RTCPeerConnection.
   - Capture microphone with getUserMedia.
   - Add microphone audio track directly to the peer connection.
   - Connect to /v1/realtime/translations/calls using SDP and the client secret.
   - Receive translated audio as a remote audio track.
   - Receive session.input_transcript.delta and session.output_transcript.delta over data channel.
3. Add a transport selector:
   - WebRTC fastest mode.
   - Existing WebSocket fallback/debug mode.
4. Do not delete the existing WebSocket implementation.
5. Disable local browser SpeechRecognition preview during real latency benchmark mode.
6. Preserve existing UI behavior where practical: source text, target text, state, errors, latency diagnostics.

Verification:
- npm run typecheck passes.
- npm run build passes.
- Manual dev run starts without exposing OPENAI_API_KEY to renderer.
- WebRTC path can start and stop cleanly.
- WebSocket fallback still works or remains selectable.
- Latency logs distinguish transport=webrtc vs transport=websocket.
- Add or update docs explaining setup, fallback, and benchmarking.

Done when:
- WebRTC translation path is implemented.
- Existing WebSocket path remains available.
- At least one benchmark run records first translated text/audio latency for WebRTC.
- docs/lowest-latency-architecture-decision.md is updated with measured results.
- Final report includes files changed, commands run, benchmark evidence, remaining risks, and next recommendation.
```

## Option 2: Best Size + Memory Target

Use this if you want Codex to test whether Tauri can replace Electron without losing WebRTC translation capability.

```text
/goal Build a Tauri 2 WebRTC translation spike for Co Translator and compare latency, file size, and memory against the current Electron app.

Context:
- Project root: /Users/tonylee/solo/co-translator
- Current packaged footprint:
  - release/: about 830 MB
  - release/mac-arm64: about 273 MB
  - release/win-arm64-unpacked: about 346 MB
  - node_modules/electron: about 274 MB
- Existing decision doc says Tauri + WebRTC may be the best combined latency, file size, and memory target.
- Current Electron app must not be destroyed.

Goal:
Create a minimal Tauri 2 prototype that proves whether the app can use:
- microphone getUserMedia
- RTCPeerConnection
- remote translated audio playback
- WebRTC data channel transcript deltas
- local secure-ish API key boundary through Rust backend commands
- no external server
- no database

Implementation constraints:
- Do not delete the Electron app.
- Put the spike in a clearly separate directory, e.g. apps/tauri-spike or tauri-spike.
- Reuse existing React UI only if it saves time; a minimal UI is acceptable.
- Keep the spike focused on proof and measurement, not full product polish.
- API key must stay out of frontend code.
- Use gpt-realtime-translate and /v1/realtime/translations.
- Prefer WebRTC translation calls, not WebSocket, unless platform WebRTC blocks progress.

Required deliverables:
1. Tauri project scaffold.
2. Rust command or backend path that creates OpenAI translation client secrets.
3. Frontend WebRTC translation session:
   - getUserMedia microphone
   - RTCPeerConnection
   - translated audio playback
   - data channel event parsing
4. Measurement script or documented manual measurement:
   - install/build size
   - app idle memory
   - active translation memory
   - first translated audio/text latency where possible
5. Comparison document:
   - Electron current app
   - Electron + WebRTC if already implemented
   - Tauri + WebRTC spike

Verification:
- Tauri dev run works on current machine or failure is documented with exact blocker.
- Tauri build works if platform tooling is available.
- npm run typecheck for existing app still passes.
- Existing Electron app remains runnable.
- No secrets are committed.
- docs/lowest-latency-architecture-decision.md is updated with evidence.

Done when:
- There is a working or conclusively blocked Tauri WebRTC spike.
- The final report answers: should we migrate from Electron to Tauri for lower file size/memory?
- The report includes actual measured sizes/memory where available, not guesses.
- The report recommends either Tauri migration, Electron WebRTC retention, or native rewrite investigation.
```

## Option 3: Full Architecture Bakeoff

Use this if you want the most rigorous decision, including native options, before committing to a rewrite.

```text
/goal Run a benchmark-driven architecture bakeoff for the lowest-latency, lowest-file-size, lowest-memory realtime translator architecture.

Context:
- Project root: /Users/tonylee/solo/co-translator
- Product goal: local desktop translator for macOS and Windows using OpenAI Realtime translation.
- Hard constraints:
  - no external application server
  - no database
  - API key must not be exposed to renderer/browser UI
  - must support macOS and Windows
  - target model is gpt-realtime-translate unless official docs show a better dedicated translation model
- Prior research docs:
  - docs/realtime-low-latency-research.md
  - docs/lowest-latency-architecture-decision.md

Architectures to evaluate:
1. Current Electron + WebSocket.
2. Electron + WebRTC translation calls.
3. Tauri + WebRTC translation calls.
4. Native macOS/Windows architecture feasibility:
   - macOS Swift/SwiftUI + AVAudioEngine/CoreAudio + native WebRTC
   - Windows WinUI 3 or lightweight shell + WASAPI + native WebRTC
   - shared Rust core where useful

Work plan:
1. Re-read relevant official docs:
   - OpenAI Realtime translation
   - OpenAI Realtime WebRTC
   - OpenAI Realtime WebSocket
   - gpt-realtime-translate
   - Tauri webview/platform docs
   - WebRTC media capture docs
2. Build or inspect enough implementation to measure the current app.
3. Add a repeatable benchmark harness where feasible:
   - transport name
   - model
   - target language
   - connection setup time
   - first audio sent
   - first source transcript delta
   - first target transcript delta
   - first translated audio received if available
   - memory idle
   - memory active
   - build/install artifact size
4. Produce a decision matrix:
   - latency
   - install size
   - runtime memory
   - implementation risk
   - platform reliability
   - security/key exposure
   - maintainability
5. Implement only small spikes needed to gather evidence. Avoid a full rewrite until the decision is clear.

Verification:
- Existing app typecheck/build still passes.
- Benchmarks are reproducible or clearly documented as manual with exact steps.
- Measurements are stored under docs/ or logs/ with timestamps.
- No API keys are written to docs/logs.
- Claims are tied to official docs or measured local evidence.

Done when:
- docs/architecture-bakeoff-report.md exists.
- It contains measured current Electron footprint and latency.
- It contains a concrete recommendation: Electron+WebRTC, Tauri+WebRTC, or full native.
- It explains why the losing options lost.
- It includes a phased implementation roadmap with checkpoints.
- It includes exact next /goal prompt for the chosen implementation phase.
```

Recommendation: start with Option 1, then run Option 2. Option 3 is valuable if you want a formal decision record before spending engineering time, but Option 1 gives the fastest real signal.
