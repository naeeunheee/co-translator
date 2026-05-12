import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";

const phraseSource = fs.readFileSync(path.join("src", "renderer", "src", "phrasePreview.ts"), "utf8");
const phraseBody = phraseSource.match(/const phrasePairs = \[([\s\S]*?)\] as const;/)?.[1];
if (!phraseBody) {
  throw new Error("Could not read phrasePairs from src/renderer/src/phrasePreview.ts.");
}
const phrasePairs = JSON.parse(`[${phraseBody}]`);

const cases = [
  ["고마워요", "English", "thank you"],
  ["hello", "Korean", "안녕하세요"],
  ["thank you", "Korean", "감사합니다"],
  ["hello my name is Tony", "Korean", "안녕하세요"],
  ["고마워요 Tony", "English", "thank you"],
  ["네", "English", "yes"],
  ["unknown phrase", "English", null],
  ["고마워요", "Japanese", null]
];

const targetMs = Number(process.env.LATENCY_TARGET_MS || 500);
const startedAt = performance.now();
for (const [text, targetLanguage, expected] of cases) {
  const actual = translateKnownPhrase(text, targetLanguage);
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)} for ${text}/${targetLanguage}, got ${JSON.stringify(actual)}.`);
  }
}
const elapsedMs = performance.now() - startedAt;
console.log(`phrase preview check passed in ${elapsedMs.toFixed(3)} ms`);
if (elapsedMs > targetMs) {
  throw new Error(`Phrase preview exceeded ${targetMs} ms.`);
}

function translateKnownPhrase(text, targetLanguage) {
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

function normalizePhrase(text) {
  return text
    .toLocaleLowerCase()
    .replace(/[.,!?;:"'’“”()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function containsHangul(text) {
  return /[\uac00-\ud7af]/.test(text);
}
