import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import WebSocket from "ws";
import { languageCode, languageOptions, targetLanguageOptions, transcriptionLanguageCode } from "../shared/languages.js";
import {
  type ApiKeyStatus,
  type ApiPricing,
  type AudioChunk,
  type ExitSaveState,
  type LatencyMode,
  type LatencySnapshot,
  type MainToRendererEvent,
  type MeetingAudioChunkSaveRequest,
  type MeetingTranscriptionRequest,
  type MeetingTranscriptionResult,
  type MeetingTranscriptSegment,
  type TranslationCallStart,
  type TranslatorConfig
} from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const logDir = path.join(rootDir, "logs");
const latencyLogPath = path.join(logDir, "latency.ndjson");
const apiKeyPageUrl = "https://platform.openai.com/settings/organization/api-keys";
const apiKeyStoreFile = "openai-api-key.json";
const REALTIME_TRANSLATE_USD_PER_MINUTE = 0.034;
const REALTIME_TRANSLATE_USD_PER_SECOND = 0.00057;
const REALTIME_WHISPER_USD_PER_MINUTE = 0.017;
const REALTIME_WHISPER_USD_PER_SECOND = 0.00028;
const MEETING_DIARIZE_USD_PER_MINUTE = 0.006;
const MEETING_DIARIZE_USD_PER_SECOND = MEETING_DIARIZE_USD_PER_MINUTE / 60;
const TRANSCRIPTION_SPEECH_RMS_THRESHOLD = 0.012;
const DEFAULT_TRANSCRIPTION_SILENCE_HOLD_MS = 600;
const KOREAN_TRANSCRIPTION_SILENCE_HOLD_MS = 1000;
const TRANSCRIPTION_LONG_BREAK_MS = 1800;
const STOP_TRANSCRIPT_SETTLE_QUIET_MS = 350;
const STOP_TRANSCRIPT_SETTLE_MAX_MS = 4000;
const devServerUrl = "http://127.0.0.1:5173";
const trustedDevOrigin = new URL(devServerUrl).origin;
const maxApiKeyLength = 4096;
const maxAudioBase64Length = 64 * 1024;
const maxMeetingAudioChunkBase64Length = 6 * 1024 * 1024;
const maxMeetingAudioBase64Length = 36 * 1024 * 1024;
const maxExitSaveTextLength = 2 * 1024 * 1024;
const validLatencyModes = new Set<LatencyMode>(["fast", "webrtc", "balanced", "stable"]);
const validSourceLanguages = new Set<string>(languageOptions);
const validTargetLanguages = new Set<string>(targetLanguageOptions);

let mainWindow: BrowserWindow | null = null;
let realtimeSocket: WebSocket | null = null;
let realtimeSockets: WebSocket[] = [];
let realtimeWinnerLane: number | undefined;
let transcriptionSocket: WebSocket | null = null;
let sessionId = "";
let finalizedSourceText = "";
let finalizedTargetText = "";
let sourceSegmentText = "";
let targetSegmentText = "";
let pendingAudioChunks: AudioChunk[] = [];
let pendingTranscriptionAudioChunks: AudioChunk[] = [];
let latencyConfig = getLatencyConfig("balanced");
let latencySnapshot = createLatencySnapshot();
let activeConfig: TranslatorConfig | null = null;
let isStreaming = false;
let warmCloseTimer: NodeJS.Timeout | undefined;
let warmConnectPromise: Promise<void> | null = null;
let translationClientSecretRefreshTimer: NodeJS.Timeout | undefined;
let firstSpeechAt: number | undefined;
let firstAudioSentAt: number | undefined;
let seenRealtimeEventTypes = new Set<string>();
let lastLatencyPublishAt = 0;
let lastRealtimeTranscriptAt = 0;
let realtimeTranscriptWaiters: Array<() => void> = [];
let sessionStartedAt = 0;
let preSpeechChunksSent = 0;
let transcriptionItemOrder: string[] = [];
let transcriptionItemText = new Map<string, string>();
let transcriptionItemSeparator = new Map<string, string>();
let pendingTranscriptionItemSeparators: string[] = [];
let transcriptionBufferHasAudio = false;
let transcriptionSpeechActive = false;
let transcriptionSilentMs = 0;
let transcriptionSilenceHoldMs = DEFAULT_TRANSCRIPTION_SILENCE_HOLD_MS;
let transcriptionLastSpeechEndedAt: number | undefined;
let lastTranscriptionTranscriptAt = 0;
let transcriptionTranscriptWaiters: Array<() => void> = [];
let exitSaveState: ExitSaveState = { sourceText: "", targetText: "" };
let closeConfirmed = false;
let closePromptActive = false;
let cachedTranslationClientSecret: {
  config: TranslatorConfig;
  value: string;
  expiresAtMs: number;
} | null = null;

type StoredApiKey = {
  encoding: "safeStorage" | "plain";
  value: string;
};

function getLatencyConfig(mode: LatencyMode) {
  if (mode === "fast") {
    return {
      maxQueuedAudioChunks: 25,
      maxWebSocketBufferBytes: 256 * 1024
    };
  }
  if (mode === "stable") {
    return {
      maxQueuedAudioChunks: 12,
      maxWebSocketBufferBytes: 1024 * 1024
    };
  }
  return {
    maxQueuedAudioChunks: 12,
    maxWebSocketBufferBytes: 512 * 1024
  };
}

function sendEvent(event: MainToRendererEvent) {
  mainWindow?.webContents.send("translator:event", event);
}

function startLogSession() {
  sessionId = `session-${Date.now()}`;
  sessionStartedAt = Date.now();
  fs.mkdirSync(logDir, { recursive: true });
  logLatency("session_log_start", {
    pid: process.pid,
    logPath: latencyLogPath
  });
}

function logLatency(event: string, data: Record<string, unknown> = {}) {
  const now = Date.now();
  const line = {
    ts: new Date(now).toISOString(),
    tMs: sessionStartedAt ? now - sessionStartedAt : 0,
    sessionId,
    event,
    ...data
  };
  const serialized = JSON.stringify(line);
  console.log(`[latency] ${serialized}`);
  try {
    fs.appendFileSync(latencyLogPath, `${serialized}\n`, "utf8");
  } catch (error) {
    console.error("[latency] failed to write latency log", error);
  }
}

function createLatencySnapshot(): LatencySnapshot {
  return {
    websocketBufferedBytes: 0,
    queuedAudioChunks: 0,
    audioChunksSent: 0,
    droppedAudioChunks: 0,
    rootCause: "Waiting for speech"
  };
}

function sameSessionConfig(left: TranslatorConfig | null, right: TranslatorConfig) {
  return (
    left?.targetLanguage === right.targetLanguage &&
    left?.latencyMode === right.latencyMode
  );
}

function shouldTranscribeUserVoice(config: TranslatorConfig) {
  return config.transcribeUserVoice !== false;
}

function shouldOpenSeparateTranscriptionSocket(config: TranslatorConfig) {
  return shouldTranscribeUserVoice(config);
}

function transcriptionSilenceHoldMsFor(config: TranslatorConfig) {
  return config.sourceLanguage === "Korean" ? KOREAN_TRANSCRIPTION_SILENCE_HOLD_MS : DEFAULT_TRANSCRIPTION_SILENCE_HOLD_MS;
}

function socketIsOpen() {
  return realtimeSockets.length > 0 && realtimeSockets.every((socket) => socket.readyState === WebSocket.OPEN);
}

function openRealtimeSockets() {
  return realtimeSockets.filter((socket) => socket.readyState === WebSocket.OPEN);
}

function closeRealtimeSockets(code = 1000, reason = "closing realtime sockets") {
  for (const socket of realtimeSockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }
  realtimeSockets = [];
  realtimeSocket = null;
  realtimeWinnerLane = undefined;
}

function closeTranscriptionSocket(code = 1000, reason = "closing transcription socket") {
  if (transcriptionSocket?.readyState === WebSocket.OPEN || transcriptionSocket?.readyState === WebSocket.CONNECTING) {
    transcriptionSocket.close(code, reason);
  }
  transcriptionSocket = null;
  resetTranscriptionState();
}

function realtimeRaceSocketCount(config: TranslatorConfig) {
  if (config.latencyMode !== "fast") {
    return 1;
  }
  return configuredRealtimeRaceSocketCount();
}

function configuredRealtimeRaceSocketCount() {
  return Math.max(1, Number(process.env.OPENAI_REALTIME_RACE_SOCKETS || 3));
}

function getApiPricing(): ApiPricing {
  return {
    realtimeTranslateUsdPerMinute: REALTIME_TRANSLATE_USD_PER_MINUTE,
    realtimeTranslateUsdPerSecond: REALTIME_TRANSLATE_USD_PER_SECOND,
    realtimeWhisperUsdPerMinute: REALTIME_WHISPER_USD_PER_MINUTE,
    realtimeWhisperUsdPerSecond: REALTIME_WHISPER_USD_PER_SECOND,
    realtimeRaceSockets: configuredRealtimeRaceSocketCount(),
    meetingDiarizeUsdPerMinute: MEETING_DIARIZE_USD_PER_MINUTE,
    meetingDiarizeUsdPerSecond: MEETING_DIARIZE_USD_PER_SECOND,
    realtimeSourceTranscriptMode: "separate"
  };
}

function clearWarmCloseTimer() {
  if (warmCloseTimer) {
    clearTimeout(warmCloseTimer);
    warmCloseTimer = undefined;
  }
}

function clearTranslationClientSecretRefreshTimer() {
  if (translationClientSecretRefreshTimer) {
    clearTimeout(translationClientSecretRefreshTimer);
    translationClientSecretRefreshTimer = undefined;
  }
}

function scheduleTranslationClientSecretRefresh(config: TranslatorConfig) {
  clearTranslationClientSecretRefreshTimer();
  if (isStreaming || !translationClientSecretIsFresh(config)) {
    return;
  }

  const refreshInMs = Math.max(1000, cachedTranslationClientSecret!.expiresAtMs - Date.now() - 10_000);
  logLatency("translation_client_secret_refresh_scheduled", {
    refreshInMs,
    targetLanguage: config.targetLanguage
  });
  translationClientSecretRefreshTimer = setTimeout(() => {
    if (isStreaming) {
      return;
    }
    void getTranslationClientSecret(config)
      .then(() => scheduleTranslationClientSecretRefresh(config))
      .catch((error: unknown) => {
        logLatency("translation_client_secret_refresh_error", {
          message: error instanceof Error ? error.message : "Could not refresh translation client secret."
        });
      });
  }, refreshInMs);
}

function scheduleWarmClose(reason: string) {
  const warmIdleTimeoutMs = Number(process.env.OPENAI_WARM_IDLE_TIMEOUT_MS || 45_000);
  clearWarmCloseTimer();
  if (isStreaming || !realtimeSockets.length) {
    return;
  }
  logLatency("warm_close_scheduled", {
    reason,
    idleTimeoutMs: warmIdleTimeoutMs
  });
  warmCloseTimer = setTimeout(() => {
    if (!isStreaming && realtimeSockets.length) {
      logLatency("warm_close_idle_timeout", {
        idleTimeoutMs: warmIdleTimeoutMs
      });
      closeRealtimeSockets(1000, "warm idle timeout");
      activeConfig = null;
      sendEvent({ type: "state", state: "idle", message: "Warm socket closed" });
    }
  }, warmIdleTimeoutMs);
}

function publishLatency(partial: Partial<LatencySnapshot> = {}, force = false) {
  latencySnapshot = {
    ...latencySnapshot,
    ...partial,
    websocketBufferedBytes: maxRealtimeBufferedAmount(),
    queuedAudioChunks: pendingAudioChunks.length
  };
  const now = Date.now();
  if (!force && now - lastLatencyPublishAt < 500) {
    return;
  }
  lastLatencyPublishAt = now;
  logLatency("latency_snapshot", latencySnapshot);
  sendEvent({ type: "latency", snapshot: latencySnapshot });
}

function maxRealtimeBufferedAmount() {
  return realtimeSockets.reduce((maxBuffered, socket) => Math.max(maxBuffered, socket.bufferedAmount), 0);
}

function trustedRendererUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (!app.isPackaged && url.origin === trustedDevOrigin) {
      return true;
    }
    return url.protocol === "file:" && url.pathname.endsWith("/dist/renderer/index.html");
  } catch {
    return false;
  }
}

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent) {
  const senderFrameUrl = event.senderFrame?.url;
  return event.sender === mainWindow?.webContents && Boolean(senderFrameUrl && trustedRendererUrl(senderFrameUrl));
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent) {
  if (!isTrustedSender(event)) {
    throw new Error("Rejected IPC call from an untrusted renderer.");
  }
}

function normalizeDevServerUrl(rawUrl: string | undefined) {
  if (app.isPackaged || !rawUrl) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    if (url.origin === trustedDevOrigin) {
      return devServerUrl;
    }
  } catch {
    return null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(value: unknown): TranslatorConfig {
  if (!isRecord(value)) {
    throw new Error("Translator config must be an object.");
  }
  if (typeof value.sourceLanguage !== "string" || !validSourceLanguages.has(value.sourceLanguage)) {
    throw new Error("Unsupported source language.");
  }
  if (typeof value.targetLanguage !== "string" || !validTargetLanguages.has(value.targetLanguage)) {
    throw new Error("Unsupported target language.");
  }
  if (typeof value.latencyMode !== "string" || !validLatencyModes.has(value.latencyMode as LatencyMode)) {
    throw new Error("Unsupported latency mode.");
  }
  if (value.transcribeUserVoice !== undefined && typeof value.transcribeUserVoice !== "boolean") {
    throw new Error("transcribeUserVoice must be a boolean.");
  }
  return {
    sourceLanguage: value.sourceLanguage,
    targetLanguage: value.targetLanguage,
    latencyMode: value.latencyMode as LatencyMode,
    transcribeUserVoice: value.transcribeUserVoice
  };
}

function validateApiKey(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("API key must be text.");
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("sk-") || trimmed.length > maxApiKeyLength) {
    throw new Error("API key must start with sk- and fit the expected length.");
  }
  return trimmed;
}

function validateAudioChunk(value: unknown): AudioChunk | null {
  if (!isRecord(value)) {
    return null;
  }
  const { base64Pcm16, capturedAt, speechStartedAt, chunkMs, rms } = value;
  if (
    typeof base64Pcm16 !== "string" ||
    base64Pcm16.length === 0 ||
    base64Pcm16.length > maxAudioBase64Length ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Pcm16)
  ) {
    return null;
  }
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt) || capturedAt <= 0) {
    return null;
  }
  if (speechStartedAt !== undefined && (typeof speechStartedAt !== "number" || !Number.isFinite(speechStartedAt) || speechStartedAt <= 0)) {
    return null;
  }
  if (typeof chunkMs !== "number" || !Number.isFinite(chunkMs) || chunkMs <= 0 || chunkMs > 1000) {
    return null;
  }
  if (typeof rms !== "number" || !Number.isFinite(rms) || rms < 0 || rms > 10) {
    return null;
  }
  return {
    base64Pcm16,
    capturedAt,
    speechStartedAt,
    chunkMs,
    rms
  } as AudioChunk;
}

function validateMeetingTranscriptionRequest(value: unknown): MeetingTranscriptionRequest {
  if (!isRecord(value)) {
    throw new Error("Meeting transcription request must be an object.");
  }
  const { base64Audio, mimeType, sourceLanguage } = value;
  if (
    typeof base64Audio !== "string" ||
    base64Audio.length === 0 ||
    base64Audio.length > maxMeetingAudioBase64Length ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Audio)
  ) {
    throw new Error("Meeting audio must be a base64 audio file under 25 MB.");
  }
  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/") || mimeType.length > 120) {
    throw new Error("Meeting audio must include an audio MIME type.");
  }
  if (typeof sourceLanguage !== "string" || !validSourceLanguages.has(sourceLanguage)) {
    throw new Error("Unsupported meeting source language.");
  }
  return {
    base64Audio,
    mimeType,
    sourceLanguage
  };
}

function validateMeetingAudioChunkSaveRequest(value: unknown): MeetingAudioChunkSaveRequest {
  if (!isRecord(value)) {
    throw new Error("Meeting audio chunk request must be an object.");
  }
  const { sessionId, sequence, base64Audio, mimeType, capturedAt } = value;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(sessionId)) {
    throw new Error("Meeting audio chunk session id is invalid.");
  }
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0 || sequence > 999_999) {
    throw new Error("Meeting audio chunk sequence is invalid.");
  }
  if (
    typeof base64Audio !== "string" ||
    base64Audio.length === 0 ||
    base64Audio.length > maxMeetingAudioChunkBase64Length ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Audio)
  ) {
    throw new Error("Meeting audio chunk must be a base64 audio file under 6 MB.");
  }
  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/") || mimeType.length > 120) {
    throw new Error("Meeting audio chunk must include an audio MIME type.");
  }
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt) || capturedAt <= 0) {
    throw new Error("Meeting audio chunk capture time is invalid.");
  }
  return {
    sessionId,
    sequence,
    base64Audio,
    mimeType,
    capturedAt
  };
}

function validateExitSaveState(value: unknown): ExitSaveState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.sourceText !== "string" || typeof value.targetText !== "string") {
    return null;
  }
  return {
    sourceText: value.sourceText.slice(0, maxExitSaveTextLength),
    targetText: value.targetText.slice(0, maxExitSaveTextLength)
  };
}

function sanitizeLogData(value: unknown) {
  if (!isRecord(value)) {
    return {};
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (key.length > 80) {
      continue;
    }
    if (typeof item === "string") {
      sanitized[key] = item.slice(0, 500);
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      sanitized[key] = item;
    }
  }
  return sanitized;
}

function loadEnv() {
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
}

function apiKeyStorePath() {
  return path.join(app.getPath("userData"), apiKeyStoreFile);
}

function readStoredApiKey(): { apiKey: string; storage: ApiKeyStatus["storage"] } | null {
  const storePath = apiKeyStorePath();
  if (!fs.existsSync(storePath)) {
    return null;
  }

  try {
    const stored = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<StoredApiKey>;
    if (!stored.value) {
      return null;
    }
    if (stored.encoding === "safeStorage") {
      return {
        apiKey: safeStorage.decryptString(Buffer.from(stored.value, "base64")),
        storage: "encrypted"
      };
    }
    if (stored.encoding === "plain") {
      logLatency("api_key_store_plain_ignored");
      return null;
    }
  } catch (error) {
    logLatency("api_key_store_read_error", {
      message: error instanceof Error ? error.message : "Could not read API key store."
    });
  }
  return null;
}

function writeStoredApiKey(apiKey: string): ApiKeyStatus {
  const trimmedApiKey = validateApiKey(apiKey);
  const canEncrypt = safeStorage.isEncryptionAvailable();
  if (!canEncrypt) {
    throw new Error("OS encryption is unavailable. Set OPENAI_API_KEY in your environment instead.");
  }
  const stored: StoredApiKey = {
    encoding: "safeStorage",
    value: safeStorage.encryptString(trimmedApiKey).toString("base64")
  };

  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(apiKeyStorePath(), JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
  process.env.OPENAI_API_KEY = trimmedApiKey;
  cachedTranslationClientSecret = null;
  clearTranslationClientSecretRefreshTimer();
  if (!isStreaming) {
    closeRealtimeSockets(1000, "api key updated");
    activeConfig = null;
  }
  return {
    configured: true,
    storage: "encrypted"
  };
}

function getApiKeyStatus(): ApiKeyStatus {
  const stored = readStoredApiKey();
  if (stored?.apiKey) {
    return {
      configured: true,
      storage: stored.storage
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      configured: true,
      storage: "environment"
    };
  }
  return {
    configured: false,
    storage: "none"
  };
}

function getApiKey() {
  const apiKey = readStoredApiKey()?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logLatency("missing_api_key");
    throw new Error("OPENAI_API_KEY is missing. Add it in API key settings.");
  }
  return apiKey;
}

function translationClientSecretIsFresh(config: TranslatorConfig) {
  return (
    cachedTranslationClientSecret !== null &&
    sameSessionConfig(cachedTranslationClientSecret.config, config) &&
    cachedTranslationClientSecret.expiresAtMs - Date.now() > 10_000
  );
}

async function getTranslationClientSecret(config: TranslatorConfig) {
  if (translationClientSecretIsFresh(config)) {
    logLatency("translation_client_secret_reused", {
      targetLanguage: config.targetLanguage,
      expiresInMs: cachedTranslationClientSecret!.expiresAtMs - Date.now()
    });
    return cachedTranslationClientSecret!.value;
  }

  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";
  const startedAt = Date.now();
  logLatency("translation_client_secret_start", {
    model,
    targetLanguage: config.targetLanguage,
    targetLanguageCode: languageCode(config.targetLanguage)
  });

  const response = await fetch("https://api.openai.com/v1/realtime/translations/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "co-translator-local-desktop"
    },
    body: JSON.stringify({
      session: {
        model,
        audio: {
          output: {
            language: languageCode(config.targetLanguage)
          }
        }
      }
    })
  });

  const payload = await response.json().catch(() => null) as {
    value?: string;
    client_secret?: { value?: string; expires_at?: number };
    expires_at?: number;
    error?: { message?: string };
  } | null;

  if (!response.ok) {
    throw new Error(payload?.error?.message || `Could not create translation client secret (${response.status}).`);
  }

  const value = payload?.value || payload?.client_secret?.value;
  if (!value) {
    throw new Error("Translation client secret response did not include a value.");
  }

  const expiresAtSeconds = payload?.expires_at || payload?.client_secret?.expires_at;
  cachedTranslationClientSecret = {
    config,
    value,
    expiresAtMs: expiresAtSeconds ? expiresAtSeconds * 1000 : Date.now() + 45_000
  };
  logLatency("translation_client_secret_ready", {
    createMs: Date.now() - startedAt,
    expiresInMs: cachedTranslationClientSecret.expiresAtMs - Date.now()
  });
  return value;
}

async function transcribeMeetingAudio(request: MeetingTranscriptionRequest): Promise<MeetingTranscriptionResult> {
  const model = process.env.OPENAI_MEETING_TRANSCRIPTION_MODEL || "gpt-4o-transcribe-diarize";
  const language = transcriptionLanguageCode(request.sourceLanguage);
  const audio = Buffer.from(request.base64Audio, "base64");
  if (audio.length < 512) {
    throw new Error("Meeting audio is too short to transcribe.");
  }

  const startedAt = Date.now();
  logLatency("meeting_transcription_start", {
    model,
    sourceLanguage: request.sourceLanguage,
    sourceLanguageCode: language,
    bytes: audio.length,
    mimeType: request.mimeType
  });

  const form = new FormData();
  form.append("file", new Blob([audio], { type: request.mimeType }), meetingAudioFilename(request.mimeType));
  form.append("model", model);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");
  if (language) {
    form.append("language", language);
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "OpenAI-Safety-Identifier": "co-translator-local-desktop"
    },
    body: form
  });

  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
      ? payload.error.message
      : `Could not diarize meeting audio (${response.status}).`;
    throw new Error(message);
  }

  const result = normalizeMeetingTranscription(payload);
  logLatency("meeting_transcription_ready", {
    model,
    readyMs: Date.now() - startedAt,
    segments: result.segments.length,
    speakers: new Set(result.segments.map((segment) => segment.speaker)).size
  });
  return result;
}

async function saveMeetingAudioChunk(request: MeetingAudioChunkSaveRequest) {
  const audio = Buffer.from(request.base64Audio, "base64");
  if (!audio.length) {
    throw new Error("Meeting audio chunk was empty.");
  }
  const directory = path.join(app.getPath("userData"), "meeting-audio", request.sessionId);
  const filename = meetingAudioChunkFilename(request.mimeType, request.sequence);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, filename), audio, { mode: 0o600 });
  logLatency("meeting_audio_chunk_saved", {
    sessionId: request.sessionId,
    sequence: request.sequence,
    bytes: audio.length,
    capturedAt: request.capturedAt
  });
}

function meetingAudioChunkFilename(mimeType: string, sequence: number) {
  const ext = path.extname(meetingAudioFilename(mimeType)) || ".webm";
  return `chunk-${String(sequence).padStart(4, "0")}${ext}`;
}

function meetingAudioFilename(mimeType: string) {
  if (mimeType.includes("wav")) {
    return "meeting.wav";
  }
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return "meeting.mp3";
  }
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) {
    return "meeting.m4a";
  }
  if (mimeType.includes("ogg")) {
    return "meeting.ogg";
  }
  return "meeting.webm";
}

function normalizeMeetingTranscription(payload: unknown): MeetingTranscriptionResult {
  if (!isRecord(payload)) {
    throw new Error("Meeting transcription response was not valid JSON.");
  }

  const speakerMap = new Map<string, string>();
  const segments: MeetingTranscriptSegment[] = [];
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
  for (const rawSegment of rawSegments) {
    if (!isRecord(rawSegment) || typeof rawSegment.text !== "string") {
      continue;
    }
    const text = rawSegment.text.trim();
    if (!text) {
      continue;
    }
    const rawSpeaker = typeof rawSegment.speaker === "string" && rawSegment.speaker.trim()
      ? rawSegment.speaker.trim()
      : "speaker";
    if (!speakerMap.has(rawSpeaker)) {
      speakerMap.set(rawSpeaker, `User ${speakerMap.size + 1}`);
    }
    const segment: MeetingTranscriptSegment = {
      speaker: speakerMap.get(rawSpeaker)!,
      text
    };
    if (typeof rawSegment.start === "number" && Number.isFinite(rawSegment.start)) {
      segment.start = rawSegment.start;
    }
    if (typeof rawSegment.end === "number" && Number.isFinite(rawSegment.end)) {
      segment.end = rawSegment.end;
    }
    segments.push(segment);
  }

  if (!segments.length && typeof payload.text === "string" && payload.text.trim()) {
    segments.push({
      speaker: "User 1",
      text: payload.text.trim()
    });
  }

  const groupedSegments = mergeConsecutiveMeetingSegments(segments);
  return {
    segments: groupedSegments,
    text: groupedSegments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n\n")
  };
}

function mergeConsecutiveMeetingSegments(segments: MeetingTranscriptSegment[]) {
  const grouped: MeetingTranscriptSegment[] = [];
  for (const segment of segments) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.speaker === segment.speaker) {
      previous.text = `${previous.text}\n\n${segment.text}`;
      previous.end = segment.end ?? previous.end;
      continue;
    }
    grouped.push({ ...segment });
  }
  return grouped;
}

function createWindow() {
  closeConfirmed = false;
  closePromptActive = false;
  exitSaveState = { sourceText: "", targetText: "" };
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    title: "Co Translator",
    backgroundColor: "#060606",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === apiKeyPageUrl) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!trustedRendererUrl(url)) {
      event.preventDefault();
    }
  });

  mainWindow.on("close", (event) => {
    if (closeConfirmed || !hasExitSaveText()) {
      return;
    }
    event.preventDefault();
    if (closePromptActive || !mainWindow) {
      return;
    }
    closePromptActive = true;
    void confirmCloseWithSave(mainWindow).finally(() => {
      closePromptActive = false;
    });
  });

  const normalizedDevUrl = normalizeDevServerUrl(process.env.VITE_DEV_SERVER_URL);
  if (normalizedDevUrl) {
    mainWindow.loadURL(normalizedDevUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function confirmCloseWithSave(window: BrowserWindow) {
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    title: "Save transcript?",
    message: "Save transcribed and translated text before leaving?",
    detail: "Co Translator will save two Markdown files: user voice transcription and translated text.",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });

  if (response === 2 || window.isDestroyed()) {
    return;
  }
  if (response === 0) {
    const saved = await saveExitTexts(window).catch(async (error: unknown) => {
      await dialog.showMessageBox(window, {
        type: "error",
        title: "Could not save transcripts",
        message: error instanceof Error ? error.message : "Co Translator could not write the transcript files."
      });
      return false;
    });
    if (!saved || window.isDestroyed()) {
      return;
    }
  }

  closeConfirmed = true;
  window.close();
}

async function saveExitTexts(window: BrowserWindow) {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: "Choose where to save transcripts",
    defaultPath: app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"]
  });
  const directory = filePaths[0];
  if (canceled || !directory) {
    return false;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sourcePath = path.join(directory, `${timestamp}-user-transcription.md`);
  const targetPath = path.join(directory, `${timestamp}-translated-text.md`);
  await Promise.all([
    fs.promises.writeFile(sourcePath, markdownDocument("User voice transcription", exitSaveState.sourceText), "utf8"),
    fs.promises.writeFile(targetPath, markdownDocument("Translated text", exitSaveState.targetText), "utf8")
  ]);
  return true;
}

function markdownDocument(title: string, text: string) {
  return `# ${title}\n\n${text.trim()}\n`;
}

function hasExitSaveText() {
  return Boolean(exitSaveState.sourceText.trim() || exitSaveState.targetText.trim());
}

function connectRealtime(config: TranslatorConfig, readyState: "connected" | "warm" = "connected") {
  const apiKey = getApiKey();

  return new Promise<void>((resolve, reject) => {
    const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";
    const url = `wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(model)}`;
    const raceCount = realtimeRaceSocketCount(config);
    let settled = false;
    let sessionReadyTimeout: NodeJS.Timeout | undefined;
    const readyLanes = new Set<number>();
    const connectStartedAt = Date.now();
    resetRealtimeState();
    latencyConfig = getLatencyConfig(config.latencyMode);
    activeConfig = config;
    logLatency("ws_connect_start", {
      model,
      targetLanguage: config.targetLanguage,
      targetLanguageCode: languageCode(config.targetLanguage),
      latencyMode: config.latencyMode,
      raceSockets: raceCount
    });
    closeRealtimeSockets(1000, "replacing realtime sockets");

    const markSessionReady = (reason: string) => {
      if (settled) {
        return;
      }
      clearSessionReadyTimeout();
      settled = true;
      logLatency("session_ready", {
        reason,
        readyMs: Date.now() - connectStartedAt,
        readySockets: readyLanes.size,
        raceSockets: raceCount
      });
      publishLatency({ rootCause: "WebSocket ready; waiting for speech" }, true);
      flushPendingAudio();
      resolve();
    };

    const markLaneReady = (lane: number, reason: string) => {
      readyLanes.add(lane);
      if (readyLanes.size >= raceCount) {
        markSessionReady(reason);
      }
    };

    const clearSessionReadyTimeout = () => {
      if (sessionReadyTimeout) {
        clearTimeout(sessionReadyTimeout);
        sessionReadyTimeout = undefined;
      }
    };

    sessionReadyTimeout = setTimeout(() => {
      logLatency("session_update_ack_timeout", {
        timeoutMs: 3000,
        readySockets: readyLanes.size,
        raceSockets: raceCount
      });
      if (readyLanes.size > 0) {
        markSessionReady("session_update_ack_timeout");
      }
    }, 3000);

    const sockets = Array.from({ length: raceCount }, (_, lane) => {
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Safety-Identifier": "co-translator-local-desktop"
        }
      });
      socket.on("open", () => {
        logLatency("ws_open", {
          connectMs: Date.now() - connectStartedAt,
          lane,
          raceSockets: raceCount
        });
        sendEvent({
          type: "state",
          state: readyState,
          message: readyState === "warm" ? "Warm socket ready" : `Connected to ${model}`
        });
        socket.send(
          JSON.stringify({
            type: "session.update",
            session: {
              audio: {
                output: {
                  language: languageCode(config.targetLanguage)
                }
              }
            }
          })
        );
        logLatency("session_update_sent", {
          targetLanguageCode: languageCode(config.targetLanguage),
          lane
        });
      });

      socket.on("message", (data) => {
        const event = parseRealtimeEvent(data.toString());
        if (!event) {
          return;
        }
        if (event.type === "session.updated") {
          logLatency("session_updated", {
            readyMs: Date.now() - connectStartedAt,
            lane,
            raceSockets: raceCount
          });
          markLaneReady(lane, "session_updated");
          return;
        }
        handleRealtimeEvent(event, lane, raceCount);
      });

      socket.on("error", (error) => {
        logLatency("ws_error", {
          message: error.message,
          lane,
          raceSockets: raceCount
        });
        if (!settled && readyLanes.size === 0) {
          sendEvent({ type: "error", message: error.message });
          sendEvent({ type: "state", state: "error", message: error.message });
          clearSessionReadyTimeout();
          settled = true;
          reject(error);
        }
      });

      socket.on("close", (code, reason) => {
        const isCurrentSocket = realtimeSockets.includes(socket);
        logLatency("ws_close", {
          code,
          reason: reason.toString(),
          isCurrentSocket,
          lane,
          raceSockets: raceCount
        });
        if (isCurrentSocket) {
          realtimeSockets = realtimeSockets.filter((candidate) => candidate !== socket);
          realtimeSocket = realtimeSockets[0] || null;
        }
        if (code !== 1000 && code !== 1005) {
          const detail = reason.toString() || `WebSocket closed with code ${code}`;
          if (!settled && !realtimeSockets.length) {
            sendEvent({ type: "error", message: detail });
            clearSessionReadyTimeout();
            settled = true;
            reject(new Error(detail));
          }
        }
        if (isCurrentSocket && !realtimeSockets.length) {
          activeConfig = null;
          sendEvent({ type: "state", state: "idle" });
        }
      });
      return socket;
    });
    realtimeSockets = sockets;
    realtimeSocket = sockets[0] || null;
  });
}

function connectTranscription(config: TranslatorConfig) {
  const apiKey = getApiKey();

  return new Promise<void>((resolve, reject) => {
    const model = process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || "gpt-realtime-whisper";
    const url = "wss://api.openai.com/v1/realtime?intent=transcription";
    const language = transcriptionLanguageCode(config.sourceLanguage);
    const connectStartedAt = Date.now();
    let settled = false;
    let readyTimeout: NodeJS.Timeout | undefined;

    closeTranscriptionSocket(1000, "replacing transcription socket");
    resetTranscriptionState();
    transcriptionSilenceHoldMs = transcriptionSilenceHoldMsFor(config);

    logLatency("transcription_connect_start", {
      model,
      sourceLanguage: config.sourceLanguage,
      sourceLanguageCode: language,
      silenceHoldMs: transcriptionSilenceHoldMs
    });

    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": "co-translator-local-desktop"
      }
    });
    transcriptionSocket = socket;

    const markReady = (reason: string) => {
      if (settled) {
        return;
      }
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = undefined;
      }
      settled = true;
      logLatency("transcription_session_ready", {
        reason,
        readyMs: Date.now() - connectStartedAt
      });
      flushPendingTranscriptionAudio();
      resolve();
    };

    readyTimeout = setTimeout(() => {
      markReady("transcription_session_update_ack_timeout");
    }, 3000);

    socket.on("open", () => {
      logLatency("transcription_ws_open", {
        connectMs: Date.now() - connectStartedAt
      });
      const transcription: Record<string, string> = { model };
      if (language) {
        transcription.language = language;
      }
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: {
                  type: "audio/pcm",
                  rate: 24000
                },
                transcription,
                turn_detection: null
              }
            }
          }
        })
      );
      logLatency("transcription_session_update_sent", {
        sourceLanguageCode: language,
        silenceHoldMs: transcriptionSilenceHoldMs
      });
    });

    socket.on("message", (data) => {
      const event = parseRealtimeEvent(data.toString());
      if (!event) {
        return;
      }
      if (event.type === "session.updated") {
        markReady("session_updated");
        return;
      }
      handleTranscriptionEvent(event);
    });

    socket.on("error", (error) => {
      logLatency("transcription_ws_error", {
        message: error.message
      });
      if (!settled) {
        if (readyTimeout) {
          clearTimeout(readyTimeout);
          readyTimeout = undefined;
        }
        settled = true;
        reject(error);
      } else {
        sendEvent({ type: "error", message: error.message });
      }
    });

    socket.on("close", (code, reason) => {
      const isCurrentSocket = transcriptionSocket === socket;
      logLatency("transcription_ws_close", {
        code,
        reason: reason.toString(),
        isCurrentSocket
      });
      if (isCurrentSocket) {
        transcriptionSocket = null;
      }
      if (!settled && code !== 1000 && code !== 1005) {
        if (readyTimeout) {
          clearTimeout(readyTimeout);
          readyTimeout = undefined;
        }
        settled = true;
        reject(new Error(reason.toString() || `Transcription WebSocket closed with code ${code}`));
      }
    });
  });
}

function parseRealtimeEvent(raw: string) {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function handleRealtimeEvent(event: Record<string, unknown>, lane = 0, raceCount = 1) {
  if (typeof event.type === "string" && !seenRealtimeEventTypes.has(event.type)) {
    seenRealtimeEventTypes.add(event.type);
    logLatency("realtime_event_type_seen", {
      type: event.type,
      lane,
      raceSockets: raceCount
    });
  }

  if (isRealtimeTranscriptEvent(event.type) && !isStreaming) {
    logLatency("realtime_transcript_ignored_while_idle", {
      type: event.type,
      lane,
      raceSockets: raceCount
    });
    return;
  }

  if (event.type === "error") {
    const error = event.error as { message?: string } | undefined;
    logLatency("api_error", {
      message: error?.message || "Realtime API error",
      lane,
      raceSockets: raceCount
    });
    if (raceCount === 1 || realtimeWinnerLane === undefined) {
      sendEvent({ type: "error", message: error?.message || "Realtime API error" });
    }
    return;
  }

  if (
    raceCount > 1 &&
    realtimeWinnerLane === undefined &&
    (event.type === "session.input_transcript.delta" || event.type === "session.input_transcript.done") &&
    lane !== 0
  ) {
    return;
  }

  if (
    raceCount > 1 &&
    realtimeWinnerLane === undefined &&
    event.type !== "session.input_transcript.delta" &&
    event.type !== "session.input_transcript.done"
  ) {
    const transcriptDelta = typeof event.delta === "string" ? event.delta : "";
    const transcriptDone = typeof event.transcript === "string" ? event.transcript : "";
    if (
      (event.type === "session.output_transcript.delta" && transcriptDelta) ||
      (event.type === "session.output_transcript.done" && transcriptDone)
    ) {
      realtimeWinnerLane = lane;
      logLatency("realtime_text_winner_lane", {
        lane,
        raceSockets: raceCount
      });
    } else {
      return;
    }
  }
  if (
    raceCount > 1 &&
    realtimeWinnerLane !== undefined &&
    event.type !== "session.input_transcript.delta" &&
    event.type !== "session.input_transcript.done" &&
    lane !== realtimeWinnerLane
  ) {
    return;
  }

  if (event.type === "session.input_transcript.delta") {
    if (transcriptionSocket) {
      return;
    }
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (delta) {
      sourceSegmentText += delta;
      if (latencySnapshot.speechToInputTranscriptMs === undefined && firstSpeechAt !== undefined) {
        logLatency("first_source_transcript_delta", {
          speechToInputTranscriptMs: Date.now() - firstSpeechAt,
          deltaChars: delta.length
        });
        publishLatency({
          speechToInputTranscriptMs: Date.now() - firstSpeechAt,
          rootCause: "API has started source transcription"
        }, true);
      }
      markRealtimeTranscriptUpdated();
      sendEvent({ type: "sourceTranscript", text: joinTranscript(finalizedSourceText, sourceSegmentText), final: false });
    }
    return;
  }

  if (event.type === "session.input_transcript.done") {
    if (transcriptionSocket) {
      return;
    }
    const transcript = typeof event.transcript === "string" ? event.transcript : sourceSegmentText;
    if (transcript) {
      logLatency("source_transcript_done", {
        chars: transcript.length
      });
      finalizedSourceText = joinTranscript(finalizedSourceText, transcript.trim());
      sourceSegmentText = "";
      markRealtimeTranscriptUpdated();
      sendEvent({ type: "sourceTranscript", text: finalizedSourceText, final: true });
    }
    return;
  }

  if (event.type === "session.output_transcript.delta") {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (delta) {
      targetSegmentText += delta;
      if (latencySnapshot.speechToTargetMs === undefined && firstSpeechAt !== undefined) {
        const now = Date.now();
        logLatency("first_target_transcript_delta", {
          speechToTargetMs: now - firstSpeechAt,
          firstAudioToTargetMs: firstAudioSentAt === undefined ? undefined : now - firstAudioSentAt,
          deltaChars: delta.length
        });
        publishLatency({
          speechToTargetMs: now - firstSpeechAt,
          firstAudioToTargetMs: firstAudioSentAt === undefined ? undefined : now - firstAudioSentAt,
          rootCause: "Streaming translated text"
        }, true);
      }
      markRealtimeTranscriptUpdated();
      sendEvent({ type: "targetTranslation", text: joinTranscript(finalizedTargetText, targetSegmentText), final: false });
    }
    return;
  }

  if (event.type === "session.output_transcript.done") {
    const transcript = typeof event.transcript === "string" ? event.transcript : targetSegmentText;
    if (transcript) {
      logLatency("target_transcript_done", {
        chars: transcript.length
      });
      finalizedTargetText = joinTranscript(finalizedTargetText, transcript.trim());
      targetSegmentText = "";
      markRealtimeTranscriptUpdated();
      sendEvent({ type: "targetTranslation", text: finalizedTargetText, final: true });
    }
  }
}

function isRealtimeTranscriptEvent(type: unknown) {
  return (
    type === "session.input_transcript.delta" ||
    type === "session.input_transcript.done" ||
    type === "session.output_transcript.delta" ||
    type === "session.output_transcript.done"
  );
}

function markRealtimeTranscriptUpdated() {
  lastRealtimeTranscriptAt = Date.now();
  const waiters = realtimeTranscriptWaiters;
  realtimeTranscriptWaiters = [];
  for (const wake of waiters) {
    wake();
  }
}

function handleTranscriptionEvent(event: Record<string, unknown>) {
  if (event.type === "error") {
    const error = event.error as { message?: string } | undefined;
    logLatency("transcription_api_error", {
      message: error?.message || "Realtime transcription API error"
    });
    sendEvent({ type: "error", message: error?.message || "Realtime transcription API error" });
    return;
  }

  if (event.type !== "conversation.item.input_audio_transcription.delta" && event.type !== "conversation.item.input_audio_transcription.completed") {
    return;
  }

  const itemId = typeof event.item_id === "string" ? event.item_id : "default";
  if (!transcriptionItemText.has(itemId)) {
    transcriptionItemOrder.push(itemId);
    transcriptionItemText.set(itemId, "");
    transcriptionItemSeparator.set(itemId, transcriptionItemOrder.length === 1 ? "" : pendingTranscriptionItemSeparators.shift() || "\n");
  }

  if (event.type === "conversation.item.input_audio_transcription.delta") {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) {
      return;
    }
    transcriptionItemText.set(itemId, `${transcriptionItemText.get(itemId) || ""}${delta}`);
    logLatency("transcription_delta", {
      itemId,
      deltaChars: delta.length
    });
    markTranscriptionTranscriptUpdated();
    sendEvent({ type: "sourceTranscript", text: currentTranscriptionText(), final: false });
    return;
  }

  const transcript = typeof event.transcript === "string" ? event.transcript.trim() : "";
  if (!transcript) {
    return;
  }
  transcriptionItemText.set(itemId, transcript);
  logLatency("transcription_completed", {
    itemId,
    chars: transcript.length
  });
  markTranscriptionTranscriptUpdated();
  sendEvent({ type: "sourceTranscript", text: currentTranscriptionText(), final: true });
}

function markTranscriptionTranscriptUpdated() {
  lastTranscriptionTranscriptAt = Date.now();
  const waiters = transcriptionTranscriptWaiters;
  transcriptionTranscriptWaiters = [];
  for (const wake of waiters) {
    wake();
  }
}

function currentTranscriptionText() {
  let text = "";
  for (const itemId of transcriptionItemOrder) {
    const itemText = transcriptionItemText.get(itemId)?.trim();
    if (itemText) {
      const separator = text ? transcriptionItemSeparator.get(itemId) || "\n" : "";
      text = `${text}${separator}${normalizeTranscriptWhitespace(itemText)}`;
    }
  }
  return text;
}

function joinTranscript(previous: string, next: string) {
  const trimmedPrevious = normalizeTranscriptWhitespace(previous);
  const trimmedNext = normalizeTranscriptWhitespace(next);
  if (!trimmedPrevious) {
    return trimmedNext;
  }
  if (!trimmedNext) {
    return trimmedPrevious;
  }
  return `${trimmedPrevious}${needsJoinSpace(trimmedPrevious, trimmedNext) ? "\n" : ""}${trimmedNext}`;
}

function normalizeTranscriptWhitespace(text: string) {
  return text
    .trim()
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ");
}

function needsJoinSpace(previous: string, next: string) {
  return !/[\s([{“‘"']$/.test(previous) && !/^[\s,.;:!?)}\]。？！、，；：）]/.test(next);
}

ipcMain.handle("translator:start", async (event, rawConfig: unknown) => {
  assertTrustedSender(event);
  const config = validateConfig(rawConfig);
  clearWarmCloseTimer();
  clearTranslationClientSecretRefreshTimer();
  isStreaming = true;
  startLogSession();
  logLatency("translator_start", {
    sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage,
    latencyMode: config.latencyMode,
    reusedWarmSocket: socketIsOpen() && sameSessionConfig(activeConfig, config)
  });

  if (!socketIsOpen() && warmConnectPromise && sameSessionConfig(activeConfig, config)) {
    logLatency("translator_wait_for_warm_socket");
    await warmConnectPromise;
  }

  if (socketIsOpen() && sameSessionConfig(activeConfig, config)) {
    latencyConfig = getLatencyConfig(config.latencyMode);
    resetStreamingState();
    if (shouldOpenSeparateTranscriptionSocket(config)) {
      await connectTranscription(config);
    }
    sendEvent({ type: "state", state: "connected", message: "Using warm Realtime socket" });
    publishLatency({ rootCause: "Warm WebSocket reused; waiting for speech" }, true);
    return;
  }

  closeRealtimeSockets(1000, "starting new realtime session");
  sendEvent({ type: "state", state: "connecting", message: "Connecting to OpenAI Realtime" });
  if (shouldOpenSeparateTranscriptionSocket(config)) {
    await Promise.all([connectRealtime(config), connectTranscription(config)]);
  } else {
    closeTranscriptionSocket(1000, "transcription disabled");
    await connectRealtime(config);
  }
});

ipcMain.handle("translator:start-translation-call", async (event, rawConfig: unknown): Promise<TranslationCallStart> => {
  assertTrustedSender(event);
  const config = validateConfig(rawConfig);
  clearWarmCloseTimer();
  clearTranslationClientSecretRefreshTimer();
  isStreaming = true;
  startLogSession();
  resetStreamingState();
  logLatency("translator_start", {
    sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage,
    latencyMode: config.latencyMode,
    transport: "webrtc",
    reusedTranslationClientSecret: translationClientSecretIsFresh(config)
  });
  sendEvent({ type: "state", state: "connecting", message: "Connecting WebRTC translation" });
  const clientSecret = await getTranslationClientSecret(config);
  return { clientSecret };
});

ipcMain.handle("translator:stop", async (event) => {
  assertTrustedSender(event);
  logLatency("translator_stop", latencySnapshot);
  sendEvent({ type: "state", state: "stopping", message: "Stopping" });
  await stopTranscriptionSocket();
  await waitForRealtimeTranscriptSettled("translator_stop");
  flushRealtimeTranscriptSnapshot("translator_stop");
  isStreaming = false;
  scheduleWarmClose("translator stop");
  pendingAudioChunks = [];
  pendingTranscriptionAudioChunks = [];
  firstSpeechAt = undefined;
  firstAudioSentAt = undefined;
  sendEvent({ type: "state", state: socketIsOpen() ? "warm" : "idle", message: socketIsOpen() ? "Warm socket ready" : "idle" });
});

ipcMain.handle("translator:get-api-key-status", async (event): Promise<ApiKeyStatus> => {
  assertTrustedSender(event);
  return getApiKeyStatus();
});

ipcMain.handle("translator:get-api-pricing", async (event): Promise<ApiPricing> => {
  assertTrustedSender(event);
  return getApiPricing();
});

ipcMain.handle("translator:set-api-key", async (event, apiKey: unknown): Promise<ApiKeyStatus> => {
  assertTrustedSender(event);
  return writeStoredApiKey(validateApiKey(apiKey));
});

ipcMain.handle("translator:open-api-key-page", async (event) => {
  assertTrustedSender(event);
  await shell.openExternal(apiKeyPageUrl);
});

ipcMain.handle("translator:meeting-transcribe", async (event, rawRequest: unknown): Promise<MeetingTranscriptionResult> => {
  assertTrustedSender(event);
  return transcribeMeetingAudio(validateMeetingTranscriptionRequest(rawRequest));
});

ipcMain.handle("translator:save-meeting-audio-chunk", async (event, rawRequest: unknown): Promise<void> => {
  assertTrustedSender(event);
  await saveMeetingAudioChunk(validateMeetingAudioChunkSaveRequest(rawRequest));
});

ipcMain.handle("translator:warm", async (event, rawConfig: unknown) => {
  assertTrustedSender(event);
  const config = validateConfig(rawConfig);
  if (isStreaming) {
    return;
  }

  if (!sessionId) {
    startLogSession();
  }

  if (config.latencyMode === "webrtc") {
    if (realtimeSockets.length) {
      logLatency("warm_close_websocket_for_webrtc");
      closeRealtimeSockets(1000, "switching to WebRTC translation");
      activeConfig = null;
    }
    await getTranslationClientSecret(config);
    scheduleTranslationClientSecretRefresh(config);
    sendEvent({ type: "state", state: "warm", message: "Warm translation token ready" });
    return;
  }

  clearTranslationClientSecretRefreshTimer();

  if (socketIsOpen() && sameSessionConfig(activeConfig, config)) {
    logLatency("warm_reuse_existing_socket", {
      targetLanguage: config.targetLanguage,
      latencyMode: config.latencyMode
    });
    scheduleWarmClose("warm refresh");
    sendEvent({ type: "state", state: "warm", message: "Warm socket ready" });
    return;
  }

  if (warmConnectPromise && sameSessionConfig(activeConfig, config)) {
    logLatency("warm_already_connecting", {
      targetLanguage: config.targetLanguage,
      latencyMode: config.latencyMode
    });
    await warmConnectPromise;
    scheduleWarmClose("warm connected");
    sendEvent({ type: "state", state: "warm", message: "Warm socket ready" });
    return;
  }

  if (realtimeSockets.length) {
    logLatency("warm_reconnect_for_config", {
      targetLanguage: config.targetLanguage,
      latencyMode: config.latencyMode
    });
    closeRealtimeSockets(1000, "warm reconnect");
  }

  warmConnectPromise = connectRealtime(config, "warm").finally(() => {
    warmConnectPromise = null;
  });
  await warmConnectPromise;
  scheduleWarmClose("warm connected");
  sendEvent({ type: "state", state: "warm", message: "Warm socket ready" });
});

function resetStreamingState() {
  resetRealtimeState();
  resetTranscriptionState();
}

function resetRealtimeState() {
  finalizedSourceText = "";
  finalizedTargetText = "";
  sourceSegmentText = "";
  targetSegmentText = "";
  pendingAudioChunks = [];
  latencySnapshot = createLatencySnapshot();
  firstSpeechAt = undefined;
  firstAudioSentAt = undefined;
  seenRealtimeEventTypes = new Set<string>();
  lastLatencyPublishAt = 0;
  lastRealtimeTranscriptAt = 0;
  realtimeTranscriptWaiters = [];
  preSpeechChunksSent = 0;
  realtimeWinnerLane = undefined;
}

function resetTranscriptionState() {
  pendingTranscriptionAudioChunks = [];
  transcriptionItemOrder = [];
  transcriptionItemText = new Map<string, string>();
  transcriptionItemSeparator = new Map<string, string>();
  pendingTranscriptionItemSeparators = [];
  transcriptionBufferHasAudio = false;
  transcriptionSpeechActive = false;
  transcriptionSilentMs = 0;
  transcriptionSilenceHoldMs = DEFAULT_TRANSCRIPTION_SILENCE_HOLD_MS;
  transcriptionLastSpeechEndedAt = undefined;
  lastTranscriptionTranscriptAt = 0;
  transcriptionTranscriptWaiters = [];
}

ipcMain.on("translator:audio", (event, rawChunk: unknown) => {
  if (!isTrustedSender(event)) {
    return;
  }
  const chunk = validateAudioChunk(rawChunk);
  if (!chunk) {
    return;
  }

  if (chunk.speechStartedAt !== undefined && firstSpeechAt === undefined) {
    firstSpeechAt = chunk.speechStartedAt;
    logLatency("local_speech_detected", {
      chunkMs: chunk.chunkMs,
      rms: chunk.rms
    });
    sendEvent({
      type: "speechActivity",
      speechStartedAt: firstSpeechAt,
      rms: chunk.rms
    });
    publishLatency({ rootCause: "Speech detected locally" }, true);
  }

  if (!openRealtimeSockets().length) {
    pendingAudioChunks.push(chunk);
    if (pendingAudioChunks.length > latencyConfig.maxQueuedAudioChunks) {
      pendingAudioChunks = pendingAudioChunks.slice(-latencyConfig.maxQueuedAudioChunks);
    }
    logLatency("audio_queued_waiting_for_ws", {
      queuedAudioChunks: pendingAudioChunks.length,
      chunkMs: chunk.chunkMs
    });
    publishLatency({ rootCause: "Audio waiting for WebSocket" });
    return;
  }

  sendAudioChunk(chunk);
});

ipcMain.on("translator:exit-save-state", (event, rawState: unknown) => {
  if (!isTrustedSender(event)) {
    return;
  }
  const state = validateExitSaveState(rawState);
  if (!state) {
    return;
  }
  exitSaveState = state;
});

ipcMain.on("translator:ui-log", (event, payload: { event?: unknown; data?: unknown }) => {
  if (!isTrustedSender(event)) {
    return;
  }
  if (typeof payload?.event !== "string") {
    return;
  }
  if (payload.event.length > 128) {
    return;
  }
  const data = sanitizeLogData(payload.data);
  logLatency(payload.event, data);
});

function sendAudioChunk(chunk: AudioChunk) {
  const sockets = openRealtimeSockets();
  if (!sockets.length) {
    return;
  }

  if (maxRealtimeBufferedAmount() > latencyConfig.maxWebSocketBufferBytes) {
    publishLatency({
      droppedAudioChunks: latencySnapshot.droppedAudioChunks + 1,
      rootCause: "Network/WebSocket backpressure"
    }, true);
    sendEvent({ type: "state", state: "connected", message: "Live, catching up" });
    return;
  }

  const now = Date.now();
  if (firstAudioSentAt === undefined) {
    firstAudioSentAt = now;
    logLatency("first_audio_sent", {
      localCaptureToSendMs: Math.max(0, now - chunk.capturedAt),
      chunkMs: chunk.chunkMs,
      rms: chunk.rms,
      afterSpeechDetected: firstSpeechAt === undefined ? undefined : now - firstSpeechAt,
      websocketBufferedBytes: maxRealtimeBufferedAmount(),
      raceSockets: sockets.length
    });
  }
  if (firstSpeechAt !== undefined && chunk.capturedAt < firstSpeechAt) {
    preSpeechChunksSent += 1;
  }
  publishLatency({
    audioChunksSent: latencySnapshot.audioChunksSent + 1,
    localCaptureToSendMs: Math.max(0, now - chunk.capturedAt),
    preSpeechChunksSent,
    rootCause: "Audio is streaming to OpenAI"
  });
  const message = JSON.stringify({
    type: "session.input_audio_buffer.append",
    audio: chunk.base64Pcm16
  });
  for (const socket of sockets) {
    socket.send(message);
  }
  sendTranscriptionAudioChunk(chunk);
}

function sendTranscriptionAudioChunk(chunk: AudioChunk) {
  if (!transcriptionSocket || transcriptionSocket.readyState !== WebSocket.OPEN) {
    pendingTranscriptionAudioChunks.push(chunk);
    if (pendingTranscriptionAudioChunks.length > latencyConfig.maxQueuedAudioChunks) {
      pendingTranscriptionAudioChunks = pendingTranscriptionAudioChunks.slice(-latencyConfig.maxQueuedAudioChunks);
    }
    return;
  }

  if (transcriptionSocket.bufferedAmount > latencyConfig.maxWebSocketBufferBytes) {
    logLatency("transcription_audio_dropped_backpressure", {
      bufferedBytes: transcriptionSocket.bufferedAmount,
      chunkMs: chunk.chunkMs
    });
    return;
  }

  transcriptionSocket.send(
    JSON.stringify({
      type: "input_audio_buffer.append",
      audio: chunk.base64Pcm16
    })
  );
  transcriptionBufferHasAudio = true;
  updateTranscriptionCommitState(chunk);
}

function updateTranscriptionCommitState(chunk: AudioChunk) {
  if (chunk.rms >= TRANSCRIPTION_SPEECH_RMS_THRESHOLD) {
    if (!transcriptionSpeechActive && transcriptionLastSpeechEndedAt !== undefined) {
      const silentGapMs = Math.max(0, chunk.capturedAt - transcriptionLastSpeechEndedAt);
      pendingTranscriptionItemSeparators.push(silentGapMs >= TRANSCRIPTION_LONG_BREAK_MS ? "\n\n" : "\n");
    }
    transcriptionSpeechActive = true;
    transcriptionSilentMs = 0;
    return;
  }

  if (!transcriptionSpeechActive) {
    return;
  }

  transcriptionSilentMs += chunk.chunkMs;
  if (transcriptionSilentMs >= transcriptionSilenceHoldMs) {
    transcriptionLastSpeechEndedAt = Math.max(0, chunk.capturedAt - transcriptionSilentMs);
    commitTranscriptionAudioBuffer("local_silence");
    transcriptionSpeechActive = false;
    transcriptionSilentMs = 0;
  }
}

function commitTranscriptionAudioBuffer(reason: string) {
  if (!transcriptionSocket || transcriptionSocket.readyState !== WebSocket.OPEN || !transcriptionBufferHasAudio) {
    return;
  }

  transcriptionSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  transcriptionBufferHasAudio = false;
  logLatency("transcription_audio_committed", { reason });
}

async function stopTranscriptionSocket() {
  if (!transcriptionSocket) {
    return;
  }
  const hadBufferedAudio = transcriptionBufferHasAudio;
  commitTranscriptionAudioBuffer("translator_stop");
  await waitForTranscriptionTranscriptSettled("translator_stop", hadBufferedAudio);
  flushTranscriptionTranscriptSnapshot("translator_stop");
  closeTranscriptionSocket(1000, "translator stop");
}

async function waitForRealtimeTranscriptSettled(reason: string) {
  if (!openRealtimeSockets().length || (firstSpeechAt === undefined && !sourceSegmentText && !targetSegmentText && !lastRealtimeTranscriptAt)) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < STOP_TRANSCRIPT_SETTLE_MAX_MS) {
    const pendingSegment = Boolean(sourceSegmentText || targetSegmentText);
    const quietForMs = lastRealtimeTranscriptAt ? Date.now() - lastRealtimeTranscriptAt : 0;
    if (!pendingSegment && quietForMs >= STOP_TRANSCRIPT_SETTLE_QUIET_MS) {
      logLatency("realtime_stop_transcript_settled", {
        reason,
        settleMs: Date.now() - startedAt,
        quietForMs
      });
      return;
    }
    await waitForRealtimeTranscriptUpdate(Math.min(120, STOP_TRANSCRIPT_SETTLE_MAX_MS - (Date.now() - startedAt)));
  }

  logLatency("realtime_stop_transcript_settle_timeout", {
    reason,
    maxMs: STOP_TRANSCRIPT_SETTLE_MAX_MS,
    sourceSegmentChars: sourceSegmentText.length,
    targetSegmentChars: targetSegmentText.length
  });
}

function flushRealtimeTranscriptSnapshot(reason: string) {
  if (!transcriptionSocket && sourceSegmentText) {
    finalizedSourceText = joinTranscript(finalizedSourceText, sourceSegmentText);
    sourceSegmentText = "";
    sendEvent({ type: "sourceTranscript", text: finalizedSourceText, final: true });
  }
  if (targetSegmentText) {
    finalizedTargetText = joinTranscript(finalizedTargetText, targetSegmentText);
    targetSegmentText = "";
    sendEvent({ type: "targetTranslation", text: finalizedTargetText, final: true });
  } else if (finalizedTargetText) {
    sendEvent({ type: "targetTranslation", text: finalizedTargetText, final: true });
  }
  logLatency("realtime_stop_transcript_flushed", {
    reason,
    sourceChars: finalizedSourceText.length,
    targetChars: finalizedTargetText.length
  });
}

function waitForRealtimeTranscriptUpdate(timeoutMs: number) {
  if (timeoutMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      realtimeTranscriptWaiters = realtimeTranscriptWaiters.filter((candidate) => candidate !== wake);
      resolve();
    };
    const timer = setTimeout(wake, timeoutMs);
    realtimeTranscriptWaiters.push(wake);
  });
}

async function waitForTranscriptionTranscriptSettled(reason: string, hadBufferedAudio: boolean) {
  if (!hadBufferedAudio && !transcriptionItemOrder.length && !lastTranscriptionTranscriptAt) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < STOP_TRANSCRIPT_SETTLE_MAX_MS) {
    const quietForMs = lastTranscriptionTranscriptAt ? Date.now() - lastTranscriptionTranscriptAt : 0;
    if (lastTranscriptionTranscriptAt && quietForMs >= STOP_TRANSCRIPT_SETTLE_QUIET_MS) {
      logLatency("transcription_stop_transcript_settled", {
        reason,
        settleMs: Date.now() - startedAt,
        quietForMs
      });
      return;
    }
    if (!hadBufferedAudio && !lastTranscriptionTranscriptAt) {
      return;
    }
    await waitForTranscriptionTranscriptUpdate(Math.min(120, STOP_TRANSCRIPT_SETTLE_MAX_MS - (Date.now() - startedAt)));
  }

  logLatency("transcription_stop_transcript_settle_timeout", {
    reason,
    maxMs: STOP_TRANSCRIPT_SETTLE_MAX_MS,
    items: transcriptionItemOrder.length
  });
}

function flushTranscriptionTranscriptSnapshot(reason: string) {
  const text = currentTranscriptionText();
  if (text) {
    sendEvent({ type: "sourceTranscript", text, final: true });
  }
  logLatency("transcription_stop_transcript_flushed", {
    reason,
    chars: text.length
  });
}

function waitForTranscriptionTranscriptUpdate(timeoutMs: number) {
  if (timeoutMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      transcriptionTranscriptWaiters = transcriptionTranscriptWaiters.filter((candidate) => candidate !== wake);
      resolve();
    };
    const timer = setTimeout(wake, timeoutMs);
    transcriptionTranscriptWaiters.push(wake);
  });
}

function flushPendingAudio() {
  const chunks = pendingAudioChunks;
  pendingAudioChunks = [];
  if (chunks.length) {
    logLatency("flush_pending_audio", {
      chunks: chunks.length
    });
  }
  for (const chunk of chunks) {
    sendAudioChunk(chunk);
  }
}

function flushPendingTranscriptionAudio() {
  const chunks = pendingTranscriptionAudioChunks;
  pendingTranscriptionAudioChunks = [];
  if (chunks.length) {
    logLatency("flush_pending_transcription_audio", {
      chunks: chunks.length
    });
  }
  for (const chunk of chunks) {
    sendTranscriptionAudioChunk(chunk);
  }
}

loadEnv();

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  clearWarmCloseTimer();
  clearTranslationClientSecretRefreshTimer();
  closeRealtimeSockets(1000, "app window closed");
  closeTranscriptionSocket(1000, "app window closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
