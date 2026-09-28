import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppSettings, CheckResult, InstallRecord, SeenEvent } from '../shared/types.js';
import type { CreatorLinkPrefs, DiscoveryCache } from './check.js';
import type { ScanCache } from './scanner.js';

/** Settings and results; small enough to rewrite on every change. */

export interface AppState {
  schema: 1;
  dirs: string[];
  settings: AppSettings;
  linkPrefs: Record<string, CreatorLinkPrefs>;
  /** Creator key → remote date the user marked as seen. */
  dismissed: Record<string, number>;
  /** Creator key → remote date an OS notification was already shown for. */
  notified: Record<string, number>;
  /**
   * Creator key → upload date of the newest archive on their pages a notification already asked
   * about ("Might be an update"): announced once, as a question, never as an update.
   */
  notifiedMaybe?: Record<string, number>;
  discovery: DiscoveryCache;
  lastResult?: CheckResult;
  installs: InstallRecord[];
  /** Newest WhimWatch release seen on GitHub, and when that was checked. */
  appRelease?: { version: string; url: string; checkedAt: number };
  /** A release version the user chose to ignore. */
  dismissedAppVersion?: string;
  /** Game warnings hidden by the user (ids include the game version, so they return after a patch). */
  dismissedGameWarnings: string[];
  seenHistory: SeenEvent[];
  firstCheckNotice: boolean;
}

export function defaultState(): AppState {
  return {
    schema: 1,
    dirs: [],
    settings: {
      // Checks run only when the user clicks Check now, unless they turn on checking at launch.
      checkOnLaunch: false,
      checkAppUpdates: true,
      recheckAfterMinutes: 60,
      autoInstall: false,
      privateLinks: false,
      keepBackupsDays: 30,
      clearBrowsingDataOnExit: true,
      forgetSignInsOnExit: false,
      notificationNames: false,
      privacyScreen: false,
      hidePageTitles: false,
      showNewPacks: true,
      quickHide: false,
      quickHideShortcut: 'CommandOrControl+Shift+H',
      theme: 'dark',
      language: 'system',
      mutedSources: [],
    },
    linkPrefs: {},
    dismissed: {},
    notified: {},
    discovery: {},
    installs: [],
    dismissedGameWarnings: [],
    seenHistory: [],
    firstCheckNotice: false,
  };
}

export async function loadState(path: string): Promise<AppState> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AppState> & { scanCache?: unknown };
    const defaults = defaultState();
    // Older versions kept the scan cache and the full list of other files in this file.
    delete parsed.scanCache;
    const last = parsed.lastResult as (CheckResult & { unrecognized?: unknown[] }) | undefined;
    if (last && last.unrecognizedCount === undefined) {
      last.unrecognizedCount = Array.isArray(last.unrecognized) ? last.unrecognized.length : 0;
      delete last.unrecognized;
    }
    return { ...defaults, ...parsed, settings: { ...defaults.settings, ...parsed.settings } };
  } catch {
    // Keep the unreadable file for inspection rather than silently discarding it.
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined);
    return defaultState();
  }
}

/**
 * The scan cache can hold an entry per CC file (tens of thousands), so it lives
 * in its own file and is only written after scans. Older state files carried it
 * inline; that copy is used once if no cache file exists yet.
 */
export async function loadScanCache(path: string, legacyStatePath?: string): Promise<ScanCache> {
  for (const [file, pick] of [
    [path, (v: unknown) => v],
    [legacyStatePath, (v: unknown) => (v as { scanCache?: unknown } | null)?.scanCache],
  ] as const) {
    if (!file) continue;
    try {
      const value = pick(JSON.parse(await readFile(file, 'utf8')));
      if (value && typeof value === 'object') return value as ScanCache;
    } catch {
      // Missing or unreadable: rebuilt by the next scan.
    }
  }
  return {};
}

/**
 * Writes via a uniquely named temp file + rename, so a crash never leaves a
 * half-written file and overlapping saves can't clobber each other's temp file.
 * Callers should still serialize saves (see SaveQueue) so the newest wins.
 */
export async function saveState(path: string, state: AppState): Promise<void> {
  await writeJsonAtomic(path, state);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  try {
    await renameWithRetry(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Windows briefly locks files that antivirus or search indexers are reading. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
}

/** Runs saves one at a time; a save requested while one is running waits for it. */
export class SaveQueue {
  private tail: Promise<void> = Promise.resolve();

  run(save: () => Promise<void>): Promise<void> {
    const next = this.tail.then(save, save);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
