import { languageLocaleCode } from "../../shared/languages";
import type { LatencyMode } from "../../shared/types";

type SpeechRecognitionConstructor = new () => SpeechRecognition;

type SpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type SpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: {
      transcript: string;
    };
  }>;
};

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

export type SpeechPreview = {
  stop(): void;
};

export function createSpeechPreview(
  sourceLanguage: string,
  latencyMode: LatencyMode,
  onText: (text: string, final: boolean) => void,
  targetLanguage?: string
): SpeechPreview | null {
  const speechWindow = window as SpeechRecognitionWindow;
  const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    return null;
  }

  const recognition = new SpeechRecognition();
  let stopped = false;
  let finalizedText = "";

  recognition.continuous = true;
  recognition.interimResults = latencyMode !== "stable";
  recognition.lang = languageLocaleCode(previewLanguage(sourceLanguage, targetLanguage)) || navigator.language || "en-US";

  recognition.onresult = (event) => {
    let interimText = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0]?.transcript.trim() || "";
      if (!transcript) {
        continue;
      }
      if (result.isFinal) {
        finalizedText = [finalizedText, transcript].filter(Boolean).join("\n\n");
      } else {
        interimText = [interimText, transcript].filter(Boolean).join(" ");
      }
    }
    onText([finalizedText, interimText].filter(Boolean).join("\n\n"), !interimText);
  };

  recognition.onend = () => {
    if (!stopped) {
      try {
        recognition.start();
      } catch {
        stopped = true;
      }
    }
  };

  try {
    recognition.start();
  } catch {
    return null;
  }

  return {
    stop() {
      stopped = true;
      recognition.stop();
    }
  };
}

function previewLanguage(sourceLanguage: string, targetLanguage?: string) {
  if (sourceLanguage !== "Auto") {
    return sourceLanguage;
  }
  if (targetLanguage === "English") {
    return "Korean";
  }
  if (targetLanguage === "Korean") {
    return "English";
  }
  return sourceLanguage;
}
