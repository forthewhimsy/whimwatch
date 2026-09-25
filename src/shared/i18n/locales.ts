/**
 * The languages WhimWatch can be shown in. Adding one: a catalogue in ./catalogs/<id>.ts, an entry
 * here and in CATALOGS (./index.ts). See "Translating WhimWatch" in CONTRIBUTING.md. An id is the
 * language alone, or language and region where a language is written more than one way (zh-TW).
 */
export const LOCALE_IDS = ['en', 'es', 'it', 'zh-TW'] as const;

export type LocaleId = (typeof LOCALE_IDS)[number];

/** The Language setting: a locale, or whatever the system prefers. */
export type LanguageSetting = 'system' | LocaleId;

export interface LocaleInfo {
  /** The language's name in itself, as the Language setting lists it ("Italiano"). */
  name: string;
  /** BCP 47 tag for dates, numbers, plurals and lists. */
  intl: string;
  /** A different tag for lists only, when the catalogue's style differs from the default for `intl`. */
  listIntl?: string;
  /**
   * Units said in words rather than counted ("yesterday", "last week"); all of them when unset. Only
   * where the words fit after "Released" and "Checked": Italian's "settimana scorsa" wants an article
   * there, so weeks and longer are counted ("1 settimana fa").
   */
  relativeWords?: readonly Intl.RelativeTimeFormatUnit[];
  /**
   * What separates items of a `unit` list, when CLDR's is too faint for a line of its own: Chinese
   * gets a bare space ("已替換 3 個檔案 已新增 2 個"), which reads as one run-on phrase.
   */
  unitSeparator?: string;
}

export const LOCALE_INFO: Record<LocaleId, LocaleInfo> = {
  // British list style: "wicked.cc, LoversLab and Patreon", without the serial comma, as the copy is written.
  en: { name: 'English', intl: 'en', listIntl: 'en-GB' },
  // "la semana pasada", "el mes pasado" carry their own article, so they read well after "Publicado".
  es: { name: 'Español', intl: 'es' },
  it: { name: 'Italiano', intl: 'it', relativeWords: ['second', 'minute', 'hour', 'day'] },
  // Traditional Chinese, by CLDR's name for zh-TW, which is also how the EA app's language list puts it.
  'zh-TW': { name: '中文（台灣）', intl: 'zh-TW', unitSeparator: '，' },
};

export const DEFAULT_LOCALE: LocaleId = 'en';

export function isLocaleId(value: unknown): value is LocaleId {
  return LOCALE_IDS.some((id) => id === value);
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === 'system' || isLocaleId(value);
}

/**
 * The first of the system's preferred languages that WhimWatch has; English when none is. Most go by
 * language alone ("it-CH" is Italian). Chinese goes by script: Traditional (Taiwan, Hong Kong, Macau,
 * zh-Hant) is zh-TW, and Simplified isn't here yet, so a zh-CN system is shown English rather than
 * characters it doesn't write. Preferences come in order, so an Italian speaker who also lists German
 * gets Italian while German isn't there.
 */
export function resolveLocale(preferred: readonly string[]): LocaleId {
  for (const tag of preferred) {
    const id = localeOf(tag);
    if (id) return id;
  }
  return DEFAULT_LOCALE;
}

function localeOf(tag: string): LocaleId | undefined {
  const language = tag.toLowerCase().split(/[-_]/)[0];
  if (language !== 'zh') return isLocaleId(language) ? language : undefined;
  try {
    return new Intl.Locale(tag.replaceAll('_', '-')).maximize().script === 'Hant' ? 'zh-TW' : undefined;
  } catch {
    return undefined;
  }
}
