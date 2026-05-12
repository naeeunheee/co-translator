import type { TranslatorApi } from "../../shared/types";

declare global {
  interface Window {
    translator: TranslatorApi;
  }
}

export {};
