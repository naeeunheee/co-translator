export const languageOptions = [
  "Auto",
  "English",
  "Korean",
  "Japanese",
  "Chinese",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Vietnamese",
  "Thai",
  "Indonesian"
] as const;

export const targetLanguageOptions = languageOptions.filter((language) => language !== "Auto");

type NamedLanguage = Exclude<(typeof languageOptions)[number], "Auto">;

const apiLanguageCodes: Record<NamedLanguage, string> = {
  English: "en",
  Korean: "ko",
  Japanese: "ja",
  Chinese: "zh",
  Spanish: "es",
  French: "fr",
  German: "de",
  Portuguese: "pt",
  Italian: "it",
  Vietnamese: "vi",
  Thai: "th",
  Indonesian: "id"
};

const browserLanguageCodes: Record<NamedLanguage, string> = {
  English: "en-US",
  Korean: "ko-KR",
  Japanese: "ja-JP",
  Chinese: "zh-CN",
  Spanish: "es-ES",
  French: "fr-FR",
  German: "de-DE",
  Portuguese: "pt-PT",
  Italian: "it-IT",
  Vietnamese: "vi-VN",
  Thai: "th-TH",
  Indonesian: "id-ID"
};

function isNamedLanguage(language: string): language is NamedLanguage {
  return language !== "Auto" && language in apiLanguageCodes;
}

export function languageCode(language: string) {
  return isNamedLanguage(language) ? apiLanguageCodes[language] : "en";
}

export function transcriptionLanguageCode(language: string) {
  return language === "Auto" ? undefined : languageCode(language);
}

export function languageLocaleCode(language: string) {
  return isNamedLanguage(language) ? browserLanguageCodes[language] : undefined;
}
