import { dateTimeFormat } from './i18n/format.js';

/** "Sep 11, 2026" ("11 set 2026"), in the current language. */
export const dateFormat = (): Intl.DateTimeFormat => dateTimeFormat({ year: 'numeric', month: 'short', day: 'numeric' });

/**
 * "Sep 11, 2026", always with the year. Leaving it out for this year put "Sep 20" beside "Mar 2, 2025",
 * and which was older had to be worked out.
 */
export function formatShortDate(t?: number): string {
  return t === undefined ? '—' : dateFormat().format(new Date(t));
}
