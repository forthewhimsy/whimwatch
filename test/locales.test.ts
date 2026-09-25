import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatShortDate } from '../src/shared/dates.js';
import { gameWarnings } from '../src/shared/game.js';
import {
  CATALOGS,
  count,
  englishMessage,
  englishStack,
  LOCALE_IDS,
  LOCALE_INFO,
  list,
  plural,
  resolveLocale,
  setLocale,
  t,
  translatedError,
  withFallback,
} from '../src/shared/i18n/index.js';
import { DownloadUnavailableError } from '../src/core/downloads.js';
import { installFileLog } from '../src/main/log.js';
import { en } from '../src/shared/i18n/catalogs/en.js';
import { planInstall } from '../src/core/installer.js';
import { linkProblem } from '../src/core/sources/urls.js';
import { dayLabel } from '../src/renderer/src/history.js';
import { formatBytes, remoteSummary, timeAgo } from '../src/renderer/src/format.js';
import { rowSummary } from '../src/renderer/src/eligibility.js';
import { describeProblem, problemFields } from '../src/shared/problems.js';
import { checkAddedPage } from '../src/core/check.js';
import type { CreatorResult, RemoteInfo } from '../src/shared/types.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 8, 14, 15, 0).getTime();

afterEach(() => setLocale('en'));

/** Every message in a catalogue, by its dotted path. */
function messages(catalog: object, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) for (const [p, v] of messages(value, path)) out.set(p, v);
    else out.set(path, value);
  }
  return out;
}

/** The {placeholders} in a message's text; not ${…}, which is a value put into it. */
const placeholders = (text: string): string[] => [...new Set([...text.matchAll(/(?<![$\w])\{(\w+)\}/g)].map((m) => m[1]!))].sort();

/** Counts that reach every plural form of the languages CLDR knows (zero, one, two, few, many, other). */
const SAMPLE_COUNTS = [0, 1, 2, 3, 5, 6, 11, 21, 22, 25, 100, 101, 102, 1_000_000];

describe('choosing the language', () => {
  it("takes the first of the system's languages that WhimWatch has, by language alone", () => {
    expect(resolveLocale(['it-IT', 'en-US'])).toBe('it');
    expect(resolveLocale(['it-CH'])).toBe('it');
    expect(resolveLocale(['de-DE', 'it-IT'])).toBe('it');
    expect(resolveLocale(['en-GB', 'it-IT'])).toBe('en');
    expect(resolveLocale(['pt-BR'])).toBe('en');
    expect(resolveLocale([])).toBe('en');
  });

  it('takes Chinese by its script: Traditional is zh-TW, Simplified waits for a catalogue of its own', () => {
    for (const tag of ['zh-TW', 'zh-Hant-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh_TW']) expect(resolveLocale([tag]), tag).toBe('zh-TW');
    for (const tag of ['zh-CN', 'zh-Hans-CN', 'zh-SG', 'zh-Hans', 'zh']) expect(resolveLocale([tag]), tag).toBe('en');
    expect(resolveLocale(['zh-CN', 'it-IT'])).toBe('it');
    expect(resolveLocale(['not a tag', 'zh-HK'])).toBe('zh-TW');
  });

  it("shows English for a language this version doesn't have, as a newer version's state file can name", () => {
    setLocale('xx' as 'it');
    expect(t().common.cancel).toBe('Cancel');
    expect(count(3812)).toBe('3,812');
  });
});

describe('every catalogue', () => {
  const english = messages(en);

  for (const id of LOCALE_IDS) {
    const catalog = messages(CATALOGS[id]);

    it(`${id}: translates only messages English has, in the same form`, () => {
      for (const [path, value] of catalog) {
        const source = english.get(path);
        expect(source, `${id} ${path} isn't an English message`).toBeDefined();
        expect(typeof value, `${id} ${path}`).toBe(typeof source);
        expect(Array.isArray(value), `${id} ${path}`).toBe(Array.isArray(source));
        if (typeof value === 'function') expect(value.length, `${id} ${path} takes different arguments`).toBe((source as (...a: unknown[]) => string).length);
      }
    });

    it(`${id}: keeps every {placeholder}, so nothing the interface puts in goes missing`, () => {
      for (const [path, value] of catalog) {
        const source = english.get(path);
        if (typeof value === 'string') expect(placeholders(value), `${id} ${path}`).toEqual(placeholders(source as string));
        // A plural() message has a form for each count: every one of them keeps the placeholders.
        if (typeof value !== 'function' || !/(?<![$\w])\{\w+\}/.test(Function.prototype.toString.call(source))) continue;
        for (const n of SAMPLE_COUNTS) {
          setLocale('en');
          const wanted = placeholders((source as (n: number) => string)(n));
          setLocale(id);
          expect(placeholders((value as (n: number) => string)(n)), `${id} ${path}(${n})`).toEqual(wanted);
        }
      }
    });

    it(`${id}: holds arrow functions of its own, never a function from elsewhere`, () => {
      // The lint rules keep catalogues to text; this catches what slipped past them at run time.
      for (const [path, value] of catalog) {
        if (typeof value !== 'function') continue;
        const source = Function.prototype.toString.call(value);
        expect(source, `${id} ${path}`).not.toContain('[native code]');
        expect(source, `${id} ${path}`).toMatch(/^(\([\w\s,?:[\]|]*\)|\w+)\s*=>/);
      }
    });

    it(`${id}: is registered with a name and Intl tag`, () => {
      expect(LOCALE_INFO[id].name).toBeTruthy();
      expect(() => new Intl.PluralRules(LOCALE_INFO[id].intl)).not.toThrow();
    });
  }

  it('fall back to English message by message, and never take a message of the wrong form', () => {
    const merged = withFallback(en, { common: { cancel: 'Annulla', files: 'not a function' as unknown as (n: number) => string } });
    expect(merged.common.cancel).toBe('Annulla');
    expect(merged.common.close).toBe('Close');
    expect(merged.common.files(2)).toBe('2 files');
    expect(merged.home.checking).toBe(en.home.checking);
  });
});

describe('Italian', () => {
  it('counts, pluralizes and lists the Italian way', () => {
    setLocale('it');
    // Four digits aren't grouped in Italian (CLDR), five are.
    expect(count(12345)).toBe('12.345');
    expect(plural(1, { one: '# file sostituito', other: '# file sostituiti' })).toBe('1 file sostituito');
    expect(plural(3, { one: '# file sostituito', other: '# file sostituiti' })).toBe('3 file sostituiti');
    expect(list(['wicked.cc', 'LoversLab', 'Patreon'])).toBe('wicked.cc, LoversLab e Patreon');
    expect(formatBytes(1536)).toBe('1,5 KB');
  });

  it('dates and times: "3 ore fa", "ieri", and headings with a capital', () => {
    setLocale('it');
    expect(timeAgo(NOW - 20_000, NOW)).toBe('proprio ora');
    expect(timeAgo(NOW - 3 * 3600_000, NOW)).toBe('3 ore fa');
    expect(timeAgo(NOW - DAY, NOW)).toBe('ieri');
    expect(timeAgo(NOW - 16 * DAY, NOW)).toBe('2 settimane fa');
    // Counted, not "settimana scorsa", which would need an article after "Uscito".
    expect(timeAgo(NOW - 8 * DAY, NOW)).toBe('1 settimana fa');
    expect(timeAgo(NOW - 2 * DAY, NOW)).toBe('l’altro ieri');
    expect(formatShortDate(new Date(2026, 8, 11).getTime(), NOW)).toBe('11 set');
    expect(dayLabel(NOW - DAY, NOW)).toBe('Ieri');
    expect(dayLabel(new Date(2026, 8, 11, 9).getTime(), NOW)).toBe('Venerdì 11 set');
    expect(dayLabel(new Date(2026, 7, 2).getTime(), NOW)).toBe('Agosto');
  });

  it('reaches text built outside the window: rows, game warnings, links and install plans', () => {
    setLocale('it');
    const off = { key: 'e', name: 'E', files: [], localUpdatedAt: 0, remotes: [], status: 'unknown', mutedSources: ['loverslab', 'patreon'] } as CreatorResult;
    expect(rowSummary(off, (at) => timeAgo(at, NOW))).toBe('LoversLab e Patreon sono disattivati');
    expect(gameWarnings({ scriptModsEnabled: false }, { status: 'unknown' })[0]!.text).toContain('Le mod script sono disattivate');
    expect(linkProblem('')).toBe(t().links.empty);
    expect(linkProblem('https://example.com/x')).toContain('example.com non è tra questi');
    const plan = planInstall({
      id: 'p',
      creatorKey: 'moonberry',
      name: 'Moonberry',
      downloadUrl: '',
      source: 'wickedcc',
      downloads: [],
      extractedDir: '/x',
      extractedFiles: ['readme.txt'],
      installedFiles: [],
      modsRoots: ['/mods'],
    });
    expect(plan.warnings).toEqual(['Il download non contiene file .package o .ts4script.']);
  });

  it('agrees in number where English gets away with one form', () => {
    setLocale('it');
    expect(t().history.filesAdded(1)).toBe('1 aggiunto');
    expect(t().history.filesAdded(2)).toBe('2 aggiunti');
    expect(t().update.summary([t().update.replaces(1, true), t().update.adds(1, false)])).toBe('Questa operazione sostituisce 1 file e ne aggiunge 1.');
    expect(t().creator.hiddenPacks(2)).toContain('{setting}');
  });
});

describe('the log', () => {
  it('keeps errors worded for the user in English, formatted the English way', () => {
    setLocale('it');
    const err = translatedError((m) => m.summary.sitesOff(['LoversLab', 'Patreon']), DownloadUnavailableError);
    expect(err).toBeInstanceOf(DownloadUnavailableError);
    expect(err.message).toBe('LoversLab e Patreon sono disattivati');
    expect(englishMessage(err)).toBe('LoversLab and Patreon are turned off');
    expect(englishStack(err).split('\n')[0]).toBe('Error: LoversLab and Patreon are turned off');
    // Wording the English didn't leave the formatting in English.
    expect(list(['a', 'b'])).toBe('a e b');
    expect(englishMessage(new Error('plain'))).toBe('plain');
    // A download's file name goes into the English as it is, `$&` included.
    const named = translatedError((m) => m.downloads.program('$&$`.exe'));
    expect(englishStack(named).split('\n')[0]).toBe("Error: The download contains a program ($&$`.exe), so WhimWatch won't install it.");
  });

  it('writes them to the log file in English, whether logged as a message or as an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whimwatch-log-'));
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const quiet = (): void => undefined;
    Object.assign(console, { log: quiet, info: quiet, warn: quiet, error: quiet });
    try {
      const file = installFileLog(dir);
      setLocale('it');
      const err = translatedError((m) => m.main.shortcutTaken);
      console.warn('Quick hide shortcut unavailable:', englishMessage(err));
      console.error('Check failed', err);
      const text = readFileSync(file, 'utf8');
      expect(text).toContain("Quick hide shortcut unavailable: That shortcut is already used by another app or can't be used.");
      expect(text).toContain("Check failed Error: That shortcut is already used by another app or can't be used.");
      expect(text).not.toContain('scorciatoia');
    } finally {
      Object.assign(console, saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Spanish', () => {
  it('says times, dates, counts and lists the Spanish way', () => {
    setLocale('es');
    // Its words for weeks and longer carry their own article, so they stay words.
    expect(timeAgo(NOW - 8 * DAY, NOW)).toBe('la semana pasada');
    expect(timeAgo(NOW - 2 * DAY, NOW)).toBe('anteayer');
    expect(timeAgo(NOW - 3 * 3600_000, NOW)).toBe('hace 3 horas');
    expect(dayLabel(new Date(2026, 8, 11, 9).getTime(), NOW)).toBe('Viernes, 11 sept');
    expect(count(12345)).toBe('12.345');
    expect(list(['wicked.cc', 'LoversLab', 'Patreon'])).toBe('wicked.cc, LoversLab y Patreon');
    // A million is CLDR's "many" in Spanish; a message with only one and other falls back to other.
    expect(t().common.files(1_000_000)).toBe('1.000.000 archivos');
  });

  it('reaches text built outside the window, with the game by its Spanish name', () => {
    setLocale('es');
    const off = { key: 'e', name: 'E', files: [], localUpdatedAt: 0, remotes: [], status: 'unknown', mutedSources: ['patreon'] } as CreatorResult;
    expect(rowSummary(off, (at) => timeAgo(at, NOW))).toBe('Patreon está desactivado');
    expect(gameWarnings({ scriptModsEnabled: false }, { status: 'unknown' })[0]!.text).toContain('Los Sims 4');
    expect(t().update.summary([t().update.replaces(1, true), t().update.adds(1, false)])).toBe('Esto reemplaza 1 archivo y añade 1.');
  });
});

describe('Traditional Chinese', () => {
  it('says times, counts and lists the Taiwanese way, with the time before the verb', () => {
    setLocale('zh-TW');
    expect(timeAgo(NOW - 20_000, NOW)).toBe('剛剛');
    expect(timeAgo(NOW - DAY, NOW)).toBe('昨天');
    expect(timeAgo(NOW - 3 * 3600_000, NOW)).toBe('3 小時前');
    expect(t().summary.released(timeAgo(NOW - 8 * DAY, NOW))).toBe('上週發布');
    expect(t().home.checked(timeAgo(NOW - 20_000, NOW))).toBe('上次檢查：剛剛');
    expect(count(12345)).toBe('12,345');
    expect(t().common.files(1)).toBe('1 個檔案');
    expect(list(['wicked.cc', 'LoversLab', 'Patreon'])).toBe('wicked.cc、LoversLab和Patreon');
    // CLDR's Chinese unit list is a bare space, which runs the parts together.
    expect(list([t().history.filesReplaced(3), t().history.filesAdded(2)], 'unit')).toBe('已替換 3 個檔案，已新增 2 個');
    expect(t().update.leftAlone(5, [t().update.alreadyIdentical(3), t().update.notModFiles(2)])).toBe('另有 5 個未更動：3 個已完全相同，2 個不是 Mod 檔案');
  });

  it("reaches text built outside the window, with the game's own names for itself and its options", () => {
    setLocale('zh-TW');
    const off = { key: 'e', name: 'E', files: [], localUpdatedAt: 0, remotes: [], status: 'unknown', mutedSources: ['patreon'] } as CreatorResult;
    expect(rowSummary(off, (at) => timeAgo(at, NOW))).toBe('Patreon 的檢查已關閉');
    const [warning] = gameWarnings({ scriptModsEnabled: false }, { status: 'unknown' });
    expect(warning!.text).toContain('《The Sims 4》');
    expect(warning!.text).toContain('遊戲選項 → 其他 → 已允許腳本模組');
    expect(t().update.summary([t().update.replaces(1, true), t().update.adds(1, false)])).toBe('此更新將替換 1 個檔案和新增 1 個。');
    // Patreon's site is in English, so the way to its password setting is too.
    expect(t().settings.google).toContain('Settings → Account → Login');
  });
});

describe("why a page couldn't be read", () => {
  const page = (extra: Partial<RemoteInfo>): RemoteInfo => ({
    listing: { source: 'loverslab', url: 'https://www.loverslab.com/files/file/1-juniper-petal/', origin: 'directory' },
    checkedAt: NOW,
    status: 'error',
    ...extra,
  });

  it('is saved as a code, with English words for the report, whatever language the check ran in', () => {
    setLocale('it');
    expect(problemFields({ code: 'http', status: 503 })).toEqual({ problem: { code: 'http', status: 503 }, error: 'HTTP 503' });
    expect(problemFields({ code: 'no-date' }).error).toBe('No update date on page');
  });

  it('is worded in the language shown now, not the one it was saved in', () => {
    const saved = page(problemFields({ code: 'no-date' }));
    expect(remoteSummary(saved)).toBe('No update date on page');
    setLocale('it');
    expect(remoteSummary(saved)).toBe('Nessuna data di aggiornamento sulla pagina');
    // A failure WhimWatch has no words for keeps its own text, inside words it does have.
    expect(remoteSummary(page(problemFields({ code: 'failed', reason: 'net::ERR_NAME_NOT_RESOLVED' })))).toBe(
      'Controllo non riuscito: net::ERR_NAME_NOT_RESOLVED',
    );
  });

  it('still shows the English of results saved before there were codes', () => {
    setLocale('it');
    expect(remoteSummary(page({ error: 'LoversLab showed a different page' }))).toBe('LoversLab showed a different page');
    expect(remoteSummary(page({}))).toBe(t().remote.couldntCheck);
  });

  it("shows a code this version doesn't know by its saved English, or says it couldn't check", () => {
    const unknown = { code: 'from-a-newer-version' } as unknown as RemoteInfo['problem'];
    expect(remoteSummary(page({ problem: unknown, error: 'Something newer went wrong' }))).toBe('Something newer went wrong');
    expect(remoteSummary(page({ problem: unknown }))).toBe(t().remote.couldntCheck);
  });

  it("saves a failure's reason in English, even when WhimWatch is in Italian", async () => {
    setLocale('it');
    const fail = async (): Promise<never> => {
      throw translatedError((m) => m.downloads.tooManyRedirects);
    };
    const listing = { source: 'wickedcc', url: 'https://wicked.cc/animations/moonberry/juniper-petal', origin: 'manual' } as const;
    const info = await checkAddedPage({ key: 'moonberry', name: 'Moonberry', files: [] }, listing, [], { dirs: [], fetcher: { get: fail, head: fail } });
    expect(info?.problem).toEqual({ code: 'failed', reason: 'Too many redirects.' });
    expect(info?.error).toBe('Check failed: Too many redirects.');
    expect(remoteSummary(info!)).toBe('Controllo non riuscito: Too many redirects.');
  });

  it('has words for every code, in every language', () => {
    const codes = [
      { code: 'http', status: 500 },
      { code: 'posts-api', status: 500 },
      { code: 'verification', site: 'Patreon' },
      { code: 'desktop-only', site: 'Patreon' },
      { code: 'failed', reason: 'x' },
      ...(['page-not-found', 'file-not-found', 'creator-not-found', 'different-page', 'no-date', 'not-creator-page', 'no-patreon-page', 'no-release-posts', 'no-posts', 'unsupported-link', 'interrupted', 'timeout'] as const).map((code) => ({ code })),
    ] as const;
    for (const id of LOCALE_IDS) {
      setLocale(id);
      for (const problem of codes) expect(describeProblem(problem), `${id} ${problem.code}`).toMatch(/\S/);
    }
  });
});
