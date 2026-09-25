import { en } from './catalogs/en.js';
import { es } from './catalogs/es.js';
import { it } from './catalogs/it.js';
import { zhTW } from './catalogs/zh-TW.js';
import { setFormatLocale } from './format.js';
import { DEFAULT_LOCALE, isLocaleId, type LocaleId } from './locales.js';

export { count, list, plural } from './format.js';
export * from './locales.js';

/** The shape of a catalogue: what each message is called with, and that it gives back text. */
export type Messages = Shape<typeof en>;

type Shape<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : T[K] extends string
      ? string
      : T[K] extends readonly string[]
        ? readonly string[]
        : Shape<T[K]>;
};

/**
 * A catalogue for a language other than English: any part of the English one, message for message.
 * What it leaves out is shown in English, so a new English message never has to wait for every
 * translation, and `npm run locales` lists what each one is missing.
 */
export type Translation = PartialMessages<Messages>;

type PartialMessages<T> = {
  [K in keyof T]?: T[K] extends string | readonly string[] | ((...args: never[]) => string) ? T[K] : PartialMessages<T[K]>;
};

export const CATALOGS: Record<LocaleId, Translation> = { en, es, it, 'zh-TW': zhTW };

/** The English catalogue with a translation laid over it, message by message. */
export function withFallback<T extends object>(base: T, over: PartialMessages<T> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    const replacement = (over as Record<string, unknown>)[key];
    if (replacement === undefined) out[key] = value;
    else if (typeof value === 'object' && value !== null && !Array.isArray(value)) out[key] = withFallback(value, replacement as PartialMessages<object>);
    // Only a replacement of the same shape: a string where English has a function would break the
    // caller, so the English message stands (and the locales test fails).
    else out[key] = typeof replacement === typeof value && Array.isArray(replacement) === Array.isArray(value) ? replacement : value;
  }
  return out as T;
}

let messages: Messages = en;
let locale: LocaleId = DEFAULT_LOCALE;

/**
 * Every message in the current language. Read it where the text is used (`t().home.checking`),
 * not once into a module constant, so a change of language reaches it.
 */
export function t(): Messages {
  return messages;
}

export function getLocale(): LocaleId {
  return locale;
}

/**
 * Switches the language of everything read from t() and formatted from here on. A language this
 * version doesn't have (a state file from a newer one) is English.
 */
export function setLocale(requested: LocaleId): void {
  const id = isLocaleId(requested) ? requested : DEFAULT_LOCALE;
  if (id === locale) return;
  locale = id;
  messages = id === 'en' ? en : withFallback(en, CATALOGS[id]);
  setFormatLocale(id);
}

/** English wording of errors made by translatedError, for the log. */
const englishOf = new WeakMap<Error, string>();

/**
 * An error for the person using WhimWatch, worded in their language, that remembers its English
 * wording too: the log goes into bug reports, and whoever reads one reads English. The English is
 * formatted the English way as well, so a log line never says "LoversLab e Patreon".
 */
export function translatedError<E extends Error = Error>(
  pick: (m: Messages) => string,
  Kind: new (message: string, options?: ErrorOptions) => E = Error as unknown as new (message: string, options?: ErrorOptions) => E,
  options?: ErrorOptions,
): E {
  const err = new Kind(pick(messages), options);
  englishOf.set(err, inEnglish(pick));
  return err;
}

/** A message in English, formatted the English way, whatever language WhimWatch is shown in. */
export function inEnglish(pick: (m: Messages) => string): string {
  setFormatLocale('en');
  try {
    return pick(en);
  } finally {
    setFormatLocale(locale);
  }
}

/** An error's message as the log should record it: in English where it was translated. */
export function englishMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return englishOf.get(err) ?? err.message;
}

/** An error's stack as the log should record it, with its message in English (see translatedError). */
export function englishStack(err: Error): string {
  const stack = err.stack ?? `${err.name}: ${err.message}`;
  const english = englishOf.get(err);
  // A function, so `$&` and the like in a download's file name stay as they are.
  return english === undefined ? stack : stack.replace(err.message, () => english);
}
