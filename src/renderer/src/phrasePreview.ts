const phrasePairs = [
  ["hello", "안녕하세요"],
  ["hi", "안녕하세요"],
  ["thank you", "감사합니다"],
  ["thanks", "고마워요"],
  ["good morning", "좋은 아침입니다"],
  ["yes", "네"],
  ["no", "아니요"],
  ["how are you", "어떻게 지내세요"],
  ["my name is tony", "제 이름은 Tony입니다"],
  ["안녕하세요", "hello"],
  ["고마워요", "thank you"],
  ["감사합니다", "thank you"],
  ["네", "yes"],
  ["아니요", "no"],
  ["좋은 아침입니다", "good morning"],
  ["어떻게 지내세요", "how are you"]
] as const;

export function translateKnownPhrase(text: string, targetLanguage: string) {
  if (targetLanguage !== "English" && targetLanguage !== "Korean") {
    return null;
  }

  const normalizedText = normalizePhrase(text);
  for (const [source, target] of phrasePairs) {
    const normalizedSource = normalizePhrase(source);
    if (normalizedSource !== normalizedText && !normalizedText.startsWith(`${normalizedSource} `)) {
      continue;
    }
    if (targetLanguage === "English" && containsHangul(target)) {
      continue;
    }
    if (targetLanguage === "Korean" && !containsHangul(target)) {
      continue;
    }
    return target;
  }

  return null;
}

function normalizePhrase(text: string) {
  return text
    .toLocaleLowerCase()
    .replace(/[.,!?;:"'’“”()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function containsHangul(text: string) {
  return /[\uac00-\ud7af]/.test(text);
}
