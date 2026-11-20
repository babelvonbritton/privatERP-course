/** Supported languages. URLs are /en/ and /id/; `tag` is what Intl formatting uses. */
export const LOCALES = ["en", "id"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_TAGS: Record<Locale, string> = { en: "en-US", id: "id-ID" };
/** Each language is named in itself so people can always find theirs. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English (US)", id: "Bahasa Indonesia" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Picks the best supported language for a browser's preference list. */
export function guessLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
