/** Same list as the server (apps/server/src/droneaid/translate/languages.ts). */
export const TRANSLATION_LANGUAGES = ["en", "fr", "es", "pt", "de", "pl", "nl"];

export const DEFAULT_SOURCE_LANG = "en";

/** i18n key of a language name in the `droneaid` namespace. */
export const languageKey = (lang: string) => `translate.language.${lang}`;
