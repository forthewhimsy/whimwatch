import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { DuplicateGroup } from '../shared/api.js';
import { translatedError } from '../shared/i18n/index.js';
import type { InstallOperation, InstallRecord, LocalFile } from '../shared/types.js';
import { CancelledError, throwIfCancelled } from './fetcher.js';
import { sameContent, sha256 } from './hash.js';
import { assertInside, backupPath, move, revert } from './installer.js';
import { isGameRunning as defaultIsGameRunning } from './process.js';

export interface FindOptions {
  signal?: AbortSignal;
  /** Bytes read so far, of the bytes that have to be read. */
  onProgress?: (done: number, total: number) => void;
  /** How many files are read at once. */
  concurrency?: number;
  /**
   * The Mods folders: a copy whose real path is outside all of them (reached through a linked folder,
   * such as a library shared between game profiles) is never offered, since it won't be removed.
   */
  roots?: readonly string[];
}

/**
 * Mod files that are byte for byte the same as another, grouped. Only files of the same size are
 * read, so a folder of thousands costs little more than listing it. Two paths to one file (a hard
 * link, or a symbolic link beside what it points to) are one file, not a duplicate: removing either
 * frees nothing, and removing a link's target would break the link.
 */
export async function findDuplicates(files: readonly LocalFile[], opts: FindOptions = {}): Promise<Omit<DuplicateGroup, 'keep'>[]> {
  const realRoots = opts.roots && (await Promise.all(opts.roots.map((r) => realpath(r).catch(() => undefined)))).filter((r): r is string => r !== undefined);
  const inside = (real: string): boolean => !realRoots || realRoots.some((root) => real.startsWith(root.endsWith(sep) ? root : root + sep));
  const bySize = new Map<number, LocalFile[]>();
  for (const f of files) if (f.size > 0) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);

  const candidates: LocalFile[] = [];
  for (const same of bySize.values()) {
    if (same.length < 2) continue;
    const seen = new Set<string>();
    const distinct: LocalFile[] = [];
    for (const f of same) {
      throwIfCancelled(opts.signal);
      const st = await stat(f.path).catch(() => undefined);
      const real = await realpath(f.path).catch(() => undefined);
      if (!st?.isFile() || !real || !inside(real)) continue;
      // Some file systems give no file number (0): the real path is what there is to tell by.
      const id = st.ino ? `${st.dev}:${st.ino}` : real;
      if (seen.has(id)) continue;
      seen.add(id);
      distinct.push(f);
    }
    if (distinct.length > 1) candidates.push(...distinct);
  }

  const total = candidates.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const hashes = new Map<LocalFile, string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const f = candidates[next++]!;
      try {
        hashes.set(f, await sha256(f.path, opts.signal));
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        // Unreadable now (moved, locked, cloud-only and offline): left out, never guessed at.
      }
      done += f.size;
      opts.onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, worker));
  throwIfCancelled(opts.signal);

  const byHash = new Map<string, LocalFile[]>();
  for (const f of candidates) {
    const hash = hashes.get(f);
    if (hash) byHash.set(hash, [...(byHash.get(hash) ?? []), f]);
  }
  return [...byHash.entries()]
    .filter(([, same]) => same.length > 1)
    .map(([hash, same]) => ({
      id: hash,
      name: basename(same[0]!.path),
      size: same[0]!.size,
      copies: same.map((f) => ({ path: f.path, root: f.root, relPath: f.relPath, mtimeMs: f.mtimeMs })),
    }))
    // What frees the most comes first.
    .sort((a, b) => b.size * (b.copies.length - 1) - a.size * (a.copies.length - 1));
}

/** "Pack (1).package", "Pack - Copy.package", "Copy of Pack.package", "Pack_copy2.package". */
const COPY_MARKER = /(?:\s\(\d+\)|\s-\s(?:copy|kopie|copia)(?:\s\(\d+\))?|[_\s-]copy\d*)(?=\.[^.]+$)|^copy of /i;

/**
 * The copy to keep, unless the user picks another: one that actually loads (a script more than one
 * folder deep in Mods doesn't); one WhimWatch installed, which its updates know where to find; one
 * without a copy marker in its name; the least deeply filed; the oldest; and by path, so the same
 * files always give the same answer.
 */
export function suggestKeep(copies: readonly { path: string; root: string; relPath: string; mtimeMs: number }[], installed: ReadonlySet<string>): string {
  const depth = (c: (typeof copies)[number]): number => c.relPath.split(/[\\/]/).length;
  // A script loads at most one folder into Mods (the rule scriptDir keeps for installs): told from
  // its path inside its Mods folder, which is the same whichever way the Mods folder is written.
  const loads = (c: (typeof copies)[number]): boolean => !/\.ts4script$/i.test(c.path) || depth(c) <= 2;
  const rank = (c: (typeof copies)[number]): number[] => [loads(c) ? 0 : 1, installed.has(c.path) ? 0 : 1, COPY_MARKER.test(basename(c.path)) ? 1 : 0, depth(c), c.mtimeMs];
  const sorted = [...copies].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return sorted[0]!.path;
}

export interface CleanupOptions {
  /** For each group: the copy to keep and the copies to remove. */
  groups: readonly { keep: string; remove: readonly string[] }[];
  backupRoot: string;
  modsRoots: string[];
  now?: () => number;
  isGameRunning?: () => Promise<boolean>;
  signal?: AbortSignal;
}

/**
 * Moves the copies to remove into a backup folder, as an update's replaced files are, so History can
 * put them back. Each is compared with the copy kept just before it's moved: files change between
 * finding and removing (an update, a copy edited by hand), and a copy no longer the same as the one
 * kept is left where it is. Returns the record, or undefined when nothing was removed, and how many
 * copies were left for that reason.
 */
export async function applyCleanup(opts: CleanupOptions): Promise<{ record?: InstallRecord; skipped: number }> {
  if (await (opts.isGameRunning ?? defaultIsGameRunning)()) throw translatedError((m) => m.installer.closeGameCleanup);
  for (const g of opts.groups) {
    assertInside(g.keep, opts.modsRoots);
    for (const path of g.remove) assertInside(path, opts.modsRoots);
  }
  // The folders as they really are: a copy reached through a linked folder can live elsewhere.
  const realRoots = (await Promise.all(opts.modsRoots.map((r) => realpath(r).catch(() => undefined)))).filter((r): r is string => r !== undefined);
  const at = (opts.now ?? Date.now)();
  const id = `${at}-${randomBytes(4).toString('hex')}`;
  const backupDir = join(opts.backupRoot, id);
  const done: InstallOperation[] = [];
  let skipped = 0;
  try {
    for (const g of opts.groups) {
      const kept = await stat(g.keep).catch(() => undefined);
      const keptReal = await realpath(g.keep).catch(() => undefined);
      for (const path of g.remove) {
        throwIfCancelled(opts.signal);
        const st = await stat(path).catch(() => undefined);
        const real = await realpath(path).catch(() => undefined);
        const same =
          kept?.isFile() &&
          st?.isFile() &&
          real !== undefined &&
          // Really in a Mods folder, not a shared library reached through a link in one.
          realRoots.some((root) => real.startsWith(root.endsWith(sep) ? root : root + sep)) &&
          // One file under two names: removing this name frees nothing, and may break a link. By file
          // number, and by real path for drives that give none.
          real !== keptReal &&
          !(st.ino && st.dev === kept.dev && st.ino === kept.ino) &&
          (await sameContent(g.keep, path, opts.signal));
        if (!same || !existsSync(path)) {
          skipped++;
          continue;
        }
        const backup = backupPath(backupDir, path, opts.modsRoots);
        await move(path, backup);
        // The copy kept must still be there after each move; if it isn't, put this one back and
        // leave the rest of the group.
        if (!existsSync(g.keep)) {
          await move(backup, path);
          skipped += g.remove.length - g.remove.indexOf(path);
          break;
        }
        done.push({ kind: 'remove', target: path, backup });
      }
    }
  } catch (err) {
    await revert(done);
    throw err;
  }
  if (!done.length) return { skipped };
  return { record: { id, creatorKey: '', name: '', at, backupDir, operations: done, cleanup: true }, skipped };
}

