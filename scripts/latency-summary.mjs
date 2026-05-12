import fs from "node:fs";
import path from "node:path";

const targetMs = Number(process.env.LATENCY_TARGET_MS || 500);
const gateMetric = process.env.LATENCY_GATE_METRIC || "audio";
const logPath = process.argv[2] || path.join("logs", "latency.ndjson");

if (!fs.existsSync(logPath)) {
  console.error(`Latency log not found: ${logPath}`);
  process.exit(1);
}

const rows = fs.readFileSync(logPath, "utf8")
  .split(/\n/)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Could not parse ${logPath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

const sessions = new Map();
for (const row of rows) {
  if (!sessions.has(row.sessionId)) {
    sessions.set(row.sessionId, []);
  }
  sessions.get(row.sessionId).push(row);
}

const summaries = [];
for (const [sessionId, sessionRows] of sessions) {
  const start = findLast(sessionRows, "translator_start");
  const targetAudio = findFirst(sessionRows, "first_target_audio_delta");
  const targetAudioPlay = findFirst(sessionRows, "ui_ws_target_audio_scheduled");
  const targetTranscript = findFirst(sessionRows, "first_target_transcript_delta");
  const speculativeTarget = findFirst(sessionRows, "ui_speculative_target_translation_rendered");
  const speculativeTargetAudio = findFirst(sessionRows, "ui_speculative_target_audio_started");
  const localSpeech = findFirst(sessionRows, "local_speech_detected");
  const secretReady = findFirst(sessionRows, "translation_client_secret_ready");
  const webrtcReady = findFirst(sessionRows, "webrtc_remote_description_set");
  const wsOpen = findFirst(sessionRows, "ws_open");
  const stop = findLast(sessionRows, "translator_stop");
  const snapshots = sessionRows.filter((row) => row.event === "latency_snapshot");

  if (!start && !targetAudio && !targetTranscript && !wsOpen) {
    continue;
  }

  summaries.push({
    sessionId,
    transport: start?.transport || (webrtcReady ? "webrtc" : wsOpen ? "websocket" : "unknown"),
    mode: start?.latencyMode,
    targetLanguage: start?.targetLanguage,
    secretCreateMs: secretReady?.createMs,
    webrtcConnectMs: webrtcReady?.connectMs,
    wsConnectMs: wsOpen?.connectMs,
    localSpeechAtMs: localSpeech?.tMs,
    speechToTargetAudioMs: targetAudio?.speechToTargetAudioMs,
    speechToTargetAudioPlayMs: targetAudioPlay?.speechToTargetAudioPlayMs,
    speechEndToTargetAudioMs: targetAudio?.speechEndToTargetAudioMs,
    speechToTargetTranscriptMs: targetTranscript?.speechToTargetMs,
    speechEndToTargetTranscriptMs: targetTranscript?.speechEndToTargetMs,
    speechToSpeculativeTargetMs: speculativeTarget?.speechToTargetMs,
    speechToSpeculativeTargetAudioMs: speculativeTargetAudio?.speechToTargetAudioMs,
    dropped: max(snapshots, "droppedAudioChunks"),
    maxBufferedBytes: max(snapshots, "websocketBufferedBytes"),
    stopAtMs: stop?.tMs
  });
}

const webrtcAudio = summaries
  .filter((summary) => summary.transport === "webrtc" && typeof summary.speechToTargetAudioMs === "number")
  .map((summary) => summary.speechToTargetAudioMs);

const targetAudio = summaries
  .filter((summary) => typeof summary.speechToTargetAudioMs === "number")
  .map((summary) => summary.speechToTargetAudioMs);

const targetAudioPlay = summaries
  .filter((summary) => typeof summary.speechToTargetAudioPlayMs === "number")
  .map((summary) => summary.speechToTargetAudioPlayMs);

const transcript = summaries
  .filter((summary) => typeof summary.speechToTargetTranscriptMs === "number")
  .map((summary) => summary.speechToTargetTranscriptMs);

const endToTranscript = summaries
  .filter((summary) => typeof summary.speechEndToTargetTranscriptMs === "number")
  .map((summary) => summary.speechEndToTargetTranscriptMs);

const speculative = summaries
  .filter((summary) => typeof summary.speechToSpeculativeTargetMs === "number")
  .map((summary) => summary.speechToSpeculativeTargetMs);

const speculativeAudio = summaries
  .filter((summary) => typeof summary.speechToSpeculativeTargetAudioMs === "number")
  .map((summary) => summary.speechToSpeculativeTargetAudioMs);

console.table(summaries);
printStats("Speech-to-target audio delta", targetAudio);
printStats("Speech-to-target audio playback", targetAudioPlay);
printStats("WebRTC speech-to-target audio", webrtcAudio);
printStats("Speech-to-target transcript", transcript);
printStats("Speech-end-to-target transcript", endToTranscript);
printStats("Speech-to-speculative target", speculative);
printStats("Speech-to-speculative target audio", speculativeAudio);

if (gateMetric === "speculative" || gateMetric === "speculative-audio") {
  const values = gateMetric === "speculative-audio" ? speculativeAudio : speculative;
  if (!values.length) {
    console.error(`No ${gateMetric} samples found. Speak a supported Korean/English phrase in the app first.`);
    process.exit(2);
  }
  if (percentile(values, 0.5) > targetMs) {
    console.error(`FAIL: p50 ${gateMetric} is above ${targetMs} ms.`);
    process.exit(3);
  }
  console.log(`PASS: p50 ${gateMetric} is at or below ${targetMs} ms.`);
  process.exit(0);
}

if (gateMetric === "text" || gateMetric === "text-onset") {
  const values = gateMetric === "text" ? endToTranscript : transcript;
  if (!values.length) {
    console.error(`No target transcript samples found. Run a smoke test with LATENCY_GATE_METRIC=${gateMetric} first.`);
    process.exit(2);
  }
  if (percentile(values, 0.5) > targetMs) {
    console.error(`FAIL: p50 ${gateMetric} is above ${targetMs} ms.`);
    process.exit(3);
  }
  console.log(`PASS: p50 ${gateMetric} is at or below ${targetMs} ms.`);
  process.exit(0);
}

const audioGateValues = targetAudioPlay.length ? targetAudioPlay : targetAudio;
if (!audioGateValues.length) {
  console.error(`No first target audio samples found. Run Fastest mode and speak once, then rerun this command.`);
  process.exit(2);
}

if (percentile(audioGateValues, 0.5) > targetMs) {
  console.error(`FAIL: p50 speech-to-target audio is above ${targetMs} ms.`);
  process.exit(3);
}

console.log(`PASS: p50 speech-to-target audio is at or below ${targetMs} ms.`);

function findFirst(rows, event) {
  return rows.find((row) => row.event === event);
}

function findLast(rows, event) {
  return rows.filter((row) => row.event === event).at(-1);
}

function max(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => typeof value === "number");
  return values.length ? Math.max(...values) : undefined;
}

function percentile(values, p) {
  if (!values.length) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function printStats(label, values) {
  if (!values.length) {
    console.log(`${label}: no samples`);
    return;
  }
  console.log(`${label}: n=${values.length} p50=${percentile(values, 0.5)} ms p95=${percentile(values, 0.95)} ms min=${Math.min(...values)} ms max=${Math.max(...values)} ms`);
}
