import { DEFAULT_LOCALE, LOCALE_INFO, type LocaleId } from './locales.js';

/**
 * The locale text is currently shown in, and the Intl formatters for it. Kept apart from the
 * catalogues, which call count/plural/list from here while they are being read.
 */
let current: LocaleId = DEFAULT_LOCALE;

export function currentLocale(): LocaleId {
  return current;
}

/** Only index.ts's setLocale calls this, so the formatters and the messages never disagree. */
export function setFormatLocale(id: LocaleId): void {
  current = id;
}

/** The BCP 47 tag for the current locale's dates and numbers. */
export function intlTag(): string {
  return LOCALE_INFO[current].intl;
}

const cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  const full = `${current}|${key}`;
  let value = cache.get(full) as T | undefined;
  if (value === undefined) {
    value = make();
    cache.set(full, value);
  }
  return value;
}

export function dateTimeFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached(`date:${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(intlTag(), options));
}

/** "yesterday", "3 days ago": in words for the units the language says in words (LocaleInfo.relativeWords). */
export function relativeTimeFormat(unit: Intl.RelativeTimeFormatUnit): Intl.RelativeTimeFormat {
  const words = LOCALE_INFO[current].relativeWords?.includes(unit) ?? true;
  return cached(`relative:${words}`, () => new Intl.RelativeTimeFormat(intlTag(), { numeric: words ? 'auto' : 'always' }));
}

export function numberFormat(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  return cached(`number:${JSON.stringify(options)}`, () => new Intl.NumberFormat(intlTag(), options));
}

/** 3812 → "3,812" in English, "3.812" in Italian. */
export function count(n: number): string {
  return numberFormat().format(n);
}

/** The plural categories a language can use (CLDR). Every language has `other`. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/**
 * The form of a phrase for `n`, with `#` standing for the number: plural(3, { one: '# file', other:
 * '# files' }) is "3 files". Languages with more forms (few, many…) add them; a missing form falls
 * back to `other`.
 */
export function plural(n: number, forms: PluralForms): string {
  const rules = cached('plural', () => new Intl.PluralRules(intlTag()));
  return (forms[rules.select(n)] ?? forms.other).replaceAll('#', count(n));
}

/**
 * ["LoversLab", "Patreon"] → "LoversLab and Patreon" ("LoversLab e Patreon"). The `unit` type only
 * separates ("2 already identical, 1 isn't a mod file"), for items that aren't a list of names.
 */
export function list(items: readonly string[], type: 'conjunction' | 'disjunction' | 'unit' = 'conjunction'): string {
  const separator = LOCALE_INFO[current].unitSeparator;
  if (type === 'unit' && separator !== undefined) return items.join(separator);
  const tag = LOCALE_INFO[current].listIntl ?? intlTag();
  return cached(`list:${type}`, () => new Intl.ListFormat(tag, { style: 'long', type })).format(items);
}
