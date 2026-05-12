import { contextBridge, ipcRenderer } from "electron";
import type {
  ApiKeyStatus,
  ApiPricing,
  AudioChunk,
  ExitSaveState,
  MainToRendererEvent,
  MeetingAudioChunkSaveRequest,
  MeetingTranscriptionRequest,
  MeetingTranscriptionResult,
  TranslatorApi,
  TranslatorConfig
} from "../shared/types.js";

const api: TranslatorApi = {
  warmSession(config: TranslatorConfig) {
    return ipcRenderer.invoke("translator:warm", config);
  },
  startSession(config: TranslatorConfig) {
    return ipcRenderer.invoke("translator:start", config);
  },
  startTranslationCall(config: TranslatorConfig) {
    return ipcRenderer.invoke("translator:start-translation-call", config);
  },
  stopSession() {
    return ipcRenderer.invoke("translator:stop");
  },
  getApiKeyStatus(): Promise<ApiKeyStatus> {
    return ipcRenderer.invoke("translator:get-api-key-status");
  },
  getApiPricing(): Promise<ApiPricing> {
    return ipcRenderer.invoke("translator:get-api-pricing");
  },
  setApiKey(apiKey: string): Promise<ApiKeyStatus> {
    return ipcRenderer.invoke("translator:set-api-key", apiKey);
  },
  openApiKeyPage() {
    return ipcRenderer.invoke("translator:open-api-key-page");
  },
  transcribeMeetingAudio(request: MeetingTranscriptionRequest): Promise<MeetingTranscriptionResult> {
    return ipcRenderer.invoke("translator:meeting-transcribe", request);
  },
  saveMeetingAudioChunk(request: MeetingAudioChunkSaveRequest): Promise<void> {
    return ipcRenderer.invoke("translator:save-meeting-audio-chunk", request);
  },
  updateExitSaveState(state: ExitSaveState) {
    ipcRenderer.send("translator:exit-save-state", state);
  },
  sendAudio(chunk: AudioChunk) {
    ipcRenderer.send("translator:audio", chunk);
  },
  logUiEvent(event: string, data: Record<string, unknown> = {}) {
    ipcRenderer.send("translator:ui-log", { event, data });
  },
  onEvent(callback: (event: MainToRendererEvent) => void) {
    const listener = (_: Electron.IpcRendererEvent, event: MainToRendererEvent) => callback(event);
    ipcRenderer.on("translator:event", listener);
    return () => ipcRenderer.off("translator:event", listener);
  }
};

contextBridge.exposeInMainWorld("translator", api);
