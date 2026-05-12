const { app, BrowserWindow, ipcMain, session } = require("electron");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");
const WebSocket = require("ws");

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
const smokeText = process.env.SMOKE_TEXT || "hello my name is Tony and I am testing live translation";
const smokeRate = process.env.SMOKE_RATE || "220";
const smokeVoice = process.env.SMOKE_VOICE;
const gateMetric = process.env.LATENCY_GATE_METRIC || "audio-play";
const runs = Math.max(1, Number(process.env.SMOKE_RUNS || 1));
const targetMs = Number(process.env.LATENCY_TARGET_MS || 500);
const gatePercentile = Number(process.env.LATENCY_GATE_PERCENTILE || 0.5);
const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";
const chunkMs = Math.max(1, Number(process.env.SMOKE_CHUNK_MS || 10));
const raceSockets = Math.max(1, Number(process.env.SMOKE_RACE_SOCKETS || 3));
const leadingSilenceMs = Math.max(0, Number(process.env.SMOKE_LEADING_SILENCE_MS || 400));
const sampleRate = 24000;
const bytesPerSample = 2;
const smokeDir = path.join(os.tmpdir(), "co-translator-ws-playback-smoke");
const speechAiff = path.join(smokeDir, "speech.aiff");
const speechPcm = path.join(smokeDir, "speech.pcm");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("no-sandbox");

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  try {
    synthesizePCM();
    const speechOffsetMs = detectSpeechOnsetMs(speechPcm);
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
    await window.loadURL(`data:text/html,${encodeURIComponent(renderPlaybackPage())}`);
    const results = [];
    for (let run = 1; run <= runs; run += 1) {
      const result = await runSmoke(run, speechOffsetMs, window);
      results.push(result);
      console.log(JSON.stringify({ type: "run_result", result }));
    }
    window.destroy();
    const key = gateMetric === "audio" ? "speechToTargetAudioMs" : "speechToTargetAudioPlayMs";
    const values = results.map((result) => typeof result[key] === "number" ? result[key] : Number.POSITIVE_INFINITY);
    const p50 = percentile(values, 0.5);
    const p95 = percentile(values, 0.95);
    const gated = percentile(values, gatePercentile);
    const successes = results.filter((result) => typeof result[key] === "number").length;
    const passed = successes === runs && gated <= targetMs;
    console.log(JSON.stringify({ type: "summary", gateMetric, gatePercentile, runs, successes, p50: finiteOrNull(p50), p95: finiteOrNull(p95), gated: finiteOrNull(gated), targetMs }));
    console.log(`${passed ? "PASS" : "FAIL"}: ${gateMetric} p${Math.round(gatePercentile * 100)} ${finiteOrNull(gated) ?? "timeout"} ms, target ${targetMs} ms, successes ${successes}/${runs}`);
    app.exit(passed ? 0 : 3);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    app.exit(3);
  }
});

async function runSmoke(run, speechOffsetMs, window) {
  return new Promise((resolve, reject) => {
    const activeSockets = new Set();
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ run, timedOut: true });
    }, Number(process.env.SMOKE_TIMEOUT_MS || 20000));

    const onMetric = (_event, metric) => {
      if (metric.run !== run) {
        return;
      }
      console.log(JSON.stringify(metric));
      if (metric.type === "first_target_audio_scheduled") {
        cleanup();
        resolve(metric);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ipcMain.off("metric", onMetric);
      for (const socket of activeSockets) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, "smoke run complete");
        }
      }
    };

    ipcMain.on("metric", onMetric);
    streamToRealtime(run, speechOffsetMs, window, (socket) => {
      activeSockets.add(socket);
    }).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

async function streamToRealtime(run, speechOffsetMs, window, onSocket) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  const sockets = Array.from({ length: raceSockets }, (_, lane) => {
    const socket = new WebSocket(`wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(model)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": "co-translator-ws-playback-smoke"
      }
    });
    onSocket(socket);
    return { lane, socket, connectMs: 0 };
  });

  await Promise.all(sockets.map(async (entry) => {
    const openedAt = Date.now();
    await once(entry.socket, "open");
    entry.connectMs = Date.now() - openedAt;
    entry.socket.send(JSON.stringify({
      type: "session.update",
      session: {
        audio: {
          output: {
            language: targetLanguage
          }
        }
      }
    }));
    await waitForSessionUpdated(entry.socket);
  }));

  const streamStartedAt = Date.now();
  const speechStartedAt = streamStartedAt + speechOffsetMs;
  let winner = false;

  for (const entry of sockets) {
    entry.socket.on("message", (data) => {
      const event = parseJson(data.toString());
      if (!event) {
        return;
      }
      if (event.type === "error") {
        window.webContents.send("target-error", event.error?.message || "Realtime API error");
        return;
      }
      if (!winner && event.type === "session.output_audio.delta" && typeof event.delta === "string" && event.delta) {
        const now = Date.now();
        if (now < speechStartedAt) {
          return;
        }
        winner = true;
        window.webContents.send("target-audio", {
          run,
          base64Pcm16: event.delta,
          receivedAt: now,
          first: true,
          lane: entry.lane,
          raceSockets,
          connectMs: entry.connectMs,
          speechOffsetMs,
          speechToTargetAudioMs: now - speechStartedAt
        });
      }
    });
  }

  await streamPCM(sockets.map((entry) => entry.socket), speechPcm);
}

function streamPCM(sockets, pcmPath) {
  return new Promise((resolve, reject) => {
    const data = fs.readFileSync(pcmPath);
    const chunkBytes = sampleRate * bytesPerSample * chunkMs / 1000;
    let offset = 0;
    const sendNext = () => {
      const openSockets = sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
      if (!openSockets.length) {
        reject(new Error("All WebSockets closed while streaming audio."));
        return;
      }
      if (offset >= data.length) {
        resolve();
        return;
      }
      const chunk = data.subarray(offset, Math.min(offset + chunkBytes, data.length));
      offset += chunk.length;
      const message = JSON.stringify({
        type: "session.input_audio_buffer.append",
        audio: chunk.toString("base64")
      });
      for (const socket of openSockets) {
        socket.send(message);
      }
      setTimeout(sendNext, chunkMs);
    };
    sendNext();
  });
}

function renderPlaybackPage() {
  return `<!doctype html>
<html>
<body>
<script>
const { ipcRenderer } = require("electron");
const sampleRate = ${JSON.stringify(sampleRate)};
const minScheduleAheadSeconds = 0.008;
const maxBufferAheadSeconds = 0.45;
let audioContext;
let nextStartTime = 0;

function player() {
  if (!audioContext) {
    audioContext = new AudioContext({ latencyHint: "interactive", sampleRate });
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}

ipcRenderer.on("target-audio", (_event, payload) => {
  const context = player();
  const samples = decodePcm16(payload.base64Pcm16);
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  const now = context.currentTime;
  if (nextStartTime < now || nextStartTime > now + maxBufferAheadSeconds) {
    nextStartTime = now + minScheduleAheadSeconds;
  }
  const startAt = nextStartTime;
  source.start(startAt);
  nextStartTime = startAt + buffer.duration;
  if (payload.first) {
    const scheduleDelayMs = Math.max(0, Math.round((startAt - now) * 1000));
    ipcRenderer.send("metric", {
      run: payload.run,
      type: "first_target_audio_scheduled",
      transport: "electron-websocket",
      targetLanguage: ${JSON.stringify(targetLanguage)},
      connectMs: payload.connectMs,
      lane: payload.lane,
      raceSockets: payload.raceSockets,
      speechOffsetMs: payload.speechOffsetMs,
      speechToTargetAudioMs: payload.speechToTargetAudioMs,
      scheduleDelayMs,
      speechToTargetAudioPlayMs: payload.speechToTargetAudioMs + scheduleDelayMs,
      firstDeltaBytes: payload.base64Pcm16.length
    });
  }
});

ipcRenderer.on("target-error", (_event, message) => {
  ipcRenderer.send("metric", { run: 0, type: "api_error", message });
});

function decodePcm16(base64Pcm16) {
  const binary = atob(base64Pcm16);
  const sampleCount = Math.floor(binary.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    const value = (high << 8) | low;
    const signed = value >= 0x8000 ? value - 0x10000 : value;
    samples[index] = signed / 0x8000;
  }
  return samples;
}
</script>
</body>
</html>`;
}

function synthesizePCM() {
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
    `adelay=${leadingSilenceMs}:all=1,apad=pad_dur=2`,
    "-ar",
    String(sampleRate),
    "-ac",
    "1",
    "-f",
    "s16le",
    speechPcm
  ], { stdio: "ignore" });
}

async function waitForSessionUpdated(socket) {
  while (true) {
    const payload = await once(socket, "message");
    const data = Array.isArray(payload) ? payload[0] : payload;
    const event = parseJson(data.toString());
    if (!event) {
      continue;
    }
    if (event.type === "error") {
      throw new Error(event.error?.message || "Realtime API error");
    }
    if (event.type === "session.updated") {
      return;
    }
  }
}

function detectSpeechOnsetMs(pcmPath) {
  const data = fs.readFileSync(pcmPath);
  const windowMs = 5;
  const threshold = 0.012;
  const chunkBytes = sampleRate * bytesPerSample * windowMs / 1000;
  for (let offset = 0; offset < data.length; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, data.length);
    let sumSquares = 0;
    let sampleCount = 0;
    for (let index = offset; index + 1 < end; index += 2) {
      const sample = data.readInt16LE(index);
      const normalized = sample / 32768;
      sumSquares += normalized * normalized;
      sampleCount += 1;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, sampleCount));
    if (rms >= threshold) {
      return Math.round(offset / (sampleRate * bytesPerSample) * 1000);
    }
  }
  return leadingSilenceMs;
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      cleanup();
      resolve(args.length > 1 ? args : args[0]);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${event} wait ended because WebSocket closed.`));
    };
    const cleanup = () => {
      emitter.off(event, onEvent);
      emitter.off("error", onError);
      emitter.off("close", onClose);
    };
    emitter.once(event, onEvent);
    emitter.once("error", onError);
    emitter.once("close", onClose);
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
