const { app, BrowserWindow, ipcMain, session } = require("electron");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");

const rootDir = path.resolve(__dirname, "..");
for (const filename of [".env", ".env.local"]) {
  const parsed = dotenv.config({ path: path.join(rootDir, filename), quiet: true }).parsed;
  if (!parsed) {
    continue;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (value.trim()) {
      process.env[key] = value;
    }
  }
}

const targetLanguage = process.env.SMOKE_TARGET_LANGUAGE || "ko";
const smokeText = process.env.SMOKE_TEXT || "hello";
const smokeRate = process.env.SMOKE_RATE || "300";
const smokeVoice = process.env.SMOKE_VOICE;
const gateMetric = process.env.LATENCY_GATE_METRIC || "audio";
const runs = Math.max(1, Number(process.env.SMOKE_RUNS || 1));
const targetMs = Number(process.env.LATENCY_TARGET_MS || 500);
const stopAfterSpeechEnd = process.env.SMOKE_STOP_AFTER_SPEECH_END === "1";
const tailSilenceSeconds = Number(process.env.SMOKE_TAIL_SILENCE_SECONDS || 18);
const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";
const smokeDir = path.join(os.tmpdir(), "co-translator-smoke");
const speechAiff = path.join(smokeDir, "speech.aiff");
const captureWav = path.join(smokeDir, "capture.wav");

fs.mkdirSync(smokeDir, { recursive: true });
childProcess.execFileSync("/usr/bin/say", [
  ...(smokeVoice ? ["-v", smokeVoice] : []),
  "-r",
  smokeRate,
  "-o",
  speechAiff,
  smokeText
], { stdio: "ignore" });
childProcess.execFileSync("/opt/homebrew/bin/ffmpeg", [
  "-y",
  "-i",
  speechAiff,
  "-af",
  `adelay=2000:all=1,apad=pad_dur=${tailSilenceSeconds}`,
  "-ar",
  "48000",
  "-ac",
  "1",
  "-acodec",
  "pcm_s16le",
  captureWav
], { stdio: "ignore" });

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", captureWav);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("no-sandbox");

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    const result = await runSmoke(run);
    results.push(result);
    console.log(JSON.stringify({ type: "run_result", ...result }));
  }

  const key = gateMetric === "text" ? "speechEndToTargetMs" : gateMetric === "text-onset" ? "speechToTargetMs" : "speechToTargetAudioMs";
  const values = results.map((result) => typeof result[key] === "number" ? result[key] : Number.POSITIVE_INFINITY);
  const p50 = percentile(values, 0.5);
  const p95 = percentile(values, 0.95);
  const successes = results.filter((result) => typeof result[key] === "number").length;
  const passed = successes === runs && p50 <= targetMs;
  console.log(JSON.stringify({ type: "summary", gateMetric, runs, successes, p50: finiteOrNull(p50), p95: finiteOrNull(p95), targetMs }));
  console.log(`${passed ? "PASS" : "FAIL"}: ${gateMetric} p50 ${finiteOrNull(p50) ?? "timeout"} ms, target ${targetMs} ms, successes ${successes}/${runs}`);
  app.exit(passed ? 0 : 3);
});

async function runSmoke(run) {
  const clientSecret = await createClientSecret();
  const testHtml = path.join(smokeDir, `test-${run}.html`);
  fs.writeFileSync(testHtml, renderTestPage(clientSecret, run), "utf8");

  const window = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => {
      window.destroy();
      resolve({ run, timedOut: true });
    }, Number(process.env.SMOKE_TIMEOUT_MS || 20000));

    const listener = (_event, metric) => {
      if (metric.run !== run) {
        return;
      }
      console.log(JSON.stringify(metric));

      if (metric.type === "first_target_audio_delta" && gateMetric === "audio") {
        cleanup();
        resolve(metric);
        return;
      }
      if (metric.type === "first_target_transcript_delta" && (gateMetric === "text" || gateMetric === "text-onset")) {
        cleanup();
        resolve(metric);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ipcMain.off("metric", listener);
      window.destroy();
    };

    ipcMain.on("metric", listener);
    await window.loadFile(testHtml);
  });
}

async function createClientSecret() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  const sessionConfig = {
    model,
    audio: {
      output: {
        language: targetLanguage
      }
    }
  };

  const response = await fetch("https://api.openai.com/v1/realtime/translations/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "co-translator-latency-smoke"
    },
    body: JSON.stringify({
      session: sessionConfig
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Could not create client secret (${response.status}).`);
  }
  const value = payload?.value || payload?.client_secret?.value;
  if (!value) {
    throw new Error("Client secret response did not include a value.");
  }
  return value;
}

function renderTestPage(clientSecret, run) {
  return `<!doctype html>
<html>
<body>
<script>
const { ipcRenderer } = require("electron");
const clientSecret = ${JSON.stringify(clientSecret)};
const run = ${JSON.stringify(run)};
const gateMetric = ${JSON.stringify(gateMetric)};
const speechThreshold = 0.02;
const remoteThreshold = 0.002;
let firstSpeechAt;
let lastSpeechAt;
let speechEndedAt;
let firstRemoteAudioAt;
let firstTargetTranscriptAt;
let firstSourceTranscriptAt;
const seenEventTypes = new Set();

main().catch((error) => {
  ipcRenderer.send("metric", { run, type: "error", message: error.message });
});

async function main() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  detectLocalSpeech(stream);

  const pc = new RTCPeerConnection();
  pc.onconnectionstatechange = () => {
    ipcRenderer.send("metric", { run, type: "connection_state", state: pc.connectionState, t: Date.now() });
  };
  pc.ontrack = ({ streams }) => {
    if (streams[0]) {
      const translatedAudio = new Audio();
      translatedAudio.autoplay = true;
      translatedAudio.srcObject = streams[0];
      translatedAudio.play().catch((error) => {
        ipcRenderer.send("metric", { run, type: "audio_play_error", message: error.message });
      });
      detectRemoteSpeech(streams[0]);
    }
  };
  const dc = pc.createDataChannel("oai-events");
  dc.onopen = () => ipcRenderer.send("metric", { run, type: "data_channel_open", t: Date.now() });
  dc.onmessage = ({ data }) => {
    try {
      const event = JSON.parse(data);
      if (event.type && !seenEventTypes.has(event.type)) {
        seenEventTypes.add(event.type);
        ipcRenderer.send("metric", { run, type: "event_type_seen", eventType: event.type, t: Date.now() });
      }
      if (event.type === "error") {
        ipcRenderer.send("metric", {
          run,
          type: "api_error",
          message: event.error?.message || "Realtime API error",
          code: event.error?.code
        });
      }
      if (event.type === "session.output_transcript.delta" && firstSpeechAt && !firstTargetTranscriptAt) {
        firstTargetTranscriptAt = Date.now();
        emitTargetTranscriptMetric();
      }
      if (event.type === "session.input_transcript.delta" && firstSpeechAt && !firstSourceTranscriptAt) {
        firstSourceTranscriptAt = Date.now();
        ipcRenderer.send("metric", {
          run,
          type: "first_source_transcript_delta",
          speechToSourceMs: firstSourceTranscriptAt - firstSpeechAt,
          speechEndToSourceMs: speechEndedAt ? firstSourceTranscriptAt - speechEndedAt : undefined,
          delta: event.delta
        });
      }
    } catch {}
  };

  for (const track of stream.getAudioTracks()) {
    pc.addTrack(track, stream);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const response = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + clientSecret,
      "Content-Type": "application/sdp"
    },
    body: offer.sdp
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
  ipcRenderer.send("metric", { run, type: "remote_description_set", t: Date.now() });
}

function detectLocalSpeech(stream) {
  const audioContext = new AudioContext({ latencyHint: "interactive" });
  audioContext.resume().catch(() => {});
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    const rms = calculateRms(samples);
    if (!firstSpeechAt && rms >= speechThreshold) {
      firstSpeechAt = Date.now();
      ipcRenderer.send("metric", { run, type: "local_speech_detected", rms, t: firstSpeechAt });
    }
    if (firstSpeechAt && !speechEndedAt) {
      const now = Date.now();
      if (rms >= 0.01) {
        lastSpeechAt = now;
        speechEndedAt = undefined;
      } else if (lastSpeechAt && !speechEndedAt && now - lastSpeechAt >= 240) {
        speechEndedAt = lastSpeechAt;
        ipcRenderer.send("metric", {
          run,
          type: "local_speech_ended",
          speechDurationMs: speechEndedAt - firstSpeechAt
        });
        if (${JSON.stringify(stopAfterSpeechEnd)}) {
          for (const track of stream.getAudioTracks()) {
            track.stop();
          }
        }
        emitTargetTranscriptMetric();
      }
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function detectRemoteSpeech(stream) {
  const audioContext = new AudioContext({ latencyHint: "interactive" });
  audioContext.resume().catch(() => {});
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    const rms = calculateRms(samples);
    if (firstSpeechAt && !firstRemoteAudioAt && rms >= remoteThreshold) {
      firstRemoteAudioAt = Date.now();
      ipcRenderer.send("metric", {
        run,
        type: "first_target_audio_delta",
        speechToTargetAudioMs: firstRemoteAudioAt - firstSpeechAt,
        speechEndToTargetAudioMs: speechEndedAt ? firstRemoteAudioAt - speechEndedAt : undefined,
        rms
      });
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function calculateRms(samples) {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function emitTargetTranscriptMetric() {
  if (!firstSpeechAt || !firstTargetTranscriptAt) {
    return;
  }
  if (gateMetric === "text" && !speechEndedAt) {
    return;
  }
  ipcRenderer.send("metric", {
    run,
    type: "first_target_transcript_delta",
    speechToTargetMs: firstTargetTranscriptAt - firstSpeechAt,
    speechEndToTargetMs: speechEndedAt ? firstTargetTranscriptAt - speechEndedAt : undefined
  });
}
</script>
</body>
</html>`;
}

function percentile(values, p) {
  if (!values.length) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
