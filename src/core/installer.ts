import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { PlannedFile, UpdatePlan } from '../shared/api.js';
import type { InstallOperation, InstallRecord, LocalFile } from '../shared/types.js';
import { t, translatedError } from '../shared/i18n/index.js';
import { MOD_FILE } from './archive.js';
import { throwIfCancelled } from './fetcher.js';
import { sameFile } from './pack-files.js';
import { isGameRunning as defaultIsGameRunning } from './process.js';

export interface PlanInput {
  id: string;
  creatorKey: string;
  name: string;
  downloadUrl: string;
  source: UpdatePlan['source'];
  downloads: string[];
  extractedDir: string;
  /** Paths relative to extractedDir. */
  extractedFiles: string[];
  /** Files currently installed for this creator. */
  installedFiles: LocalFile[];
  modsRoots: string[];
}

/**
 * Decides where each downloaded mod file goes: over the installed file with
 * the same name; failing that, in place of the one installed file that is
 * another version or edition of it (sameFile), which it replaces; otherwise
 * next to the creator's newest installed file.
 */
export function planInstall(input: PlanInput): UpdatePlan {
  const warnings: string[] = [];
  // Files moved or deleted since they were scanned: replacing one would put a copy back where it was.
  const installedFiles = input.installedFiles.filter((f) => existsSync(f.path));
  const installedByName = new Map(installedFiles.map((f) => [basename(f.path).toLowerCase(), f]));
  const homeDir = defaultTargetDir(installedFiles, input.modsRoots);

  const files: PlannedFile[] = [];
  const seen = new Map<string, string>();
  const incomingNames = new Set(input.extractedFiles.filter((f) => MOD_FILE.test(f)).map((f) => basename(f).toLowerCase()));
  // An installed file the download also has by name is replaced by that one, never renamed over.
  const renameable = installedFiles.filter((f) => !incomingNames.has(basename(f.path).toLowerCase()));
  const claimed = new Set<string>();
  for (const rel of input.extractedFiles.filter((f) => MOD_FILE.test(f))) {
    const name = basename(rel);
    const key = name.toLowerCase();
    const first = seen.get(key);
    if (first) {
      warnings.push(t().installer.duplicate(name, first));
      continue;
    }
    seen.set(key, rel);

    const source = join(input.extractedDir, rel);
    const installed = installedByName.get(key);
    if (installed) {
      files.push({ source, target: installed.path, kind: 'replace', installedAt: installed.mtimeMs });
      continue;
    }
    // Only when exactly one file of theirs is another version or edition of it: two would be a guess.
    const older = renameable.filter((f) => sameFile(basename(f.path), name));
    const replaces = older.length === 1 && !claimed.has(older[0]!.path) ? older[0]! : undefined;
    const renamedTarget = replaces && join(dirname(replaces.path), name);
    if (replaces && renamedTarget && !existsSync(renamedTarget)) {
      claimed.add(replaces.path);
      files.push({ source, target: renamedTarget, kind: 'replace', installedAt: replaces.mtimeMs, replaces: replaces.path });
      continue;
    }
    const dir = /\.ts4script$/i.test(name) ? scriptDir(homeDir, input.modsRoots) : homeDir;
    const target = join(dir, name);
    if (existsSync(target)) warnings.push(t().installer.exists(name));
    files.push({ source, target, kind: existsSync(target) ? 'replace' : 'add' });
  }

  if (!files.length) warnings.push(t().installer.noModFiles);
  const incoming = new Set(files.map((f) => basename(f.target).toLowerCase()));
  return {
    id: input.id,
    creatorKey: input.creatorKey,
    name: input.name,
    downloadUrl: input.downloadUrl,
    source: input.source,
    downloads: input.downloads,
    files,
    possiblyObsolete: installedFiles.filter((f) => !incoming.has(basename(f.path).toLowerCase()) && !claimed.has(f.path)).map((f) => f.path),
    skipped: input.extractedFiles.filter((f) => !MOD_FILE.test(f)),
    warnings,
    upToDate: false,
  };
}

/**
 * Marks planned replacements that are byte-identical to the installed file.
 * If every downloaded mod file matches, the plan is "already up to date",
 * which is common when a pack appears on a second site after early access.
 */
export async function markUnchanged(plan: UpdatePlan, signal?: AbortSignal): Promise<void> {
  for (const file of plan.files) {
    throwIfCancelled(signal);
    if (file.kind !== 'replace') continue;
    // Renamed but byte for byte the same: nothing to install, and their file keeps its name.
    file.unchanged = await sameContent(file.source, file.replaces ?? file.target);
  }
  plan.upToDate = plan.files.length > 0 && plan.files.every((f) => f.unchanged);
  plan.onlyAdds = !plan.upToDate && plan.files.some((f) => f.unchanged) && plan.files.every((f) => f.unchanged || f.kind === 'add');
}

async function sameContent(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    if (sa.size !== sb.size) return false;
    const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
    return ha === hb;
  } catch {
    return false;
  }
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function defaultTargetDir(installed: LocalFile[], roots: string[]): string {
  const newest = [...installed].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (newest) return dirname(newest.path);
  if (!roots[0]) throw translatedError((m) => m.installer.noModsFolder);
  return roots[0];
}

/** Script mods only load at most one folder deep inside Mods. */
export function scriptDir(dir: string, roots: string[]): string {
  const root = rootOf(dir, roots);
  if (!root) return dir;
  const segments = relative(root, dir).split(sep).filter(Boolean);
  return segments.length <= 1 ? dir : join(root, segments[0]!);
}

function rootOf(path: string, roots: string[]): string | undefined {
  return roots.find((r) => path === r || path.startsWith(r.endsWith(sep) ? r : r + sep));
}

export interface ApplyOptions {
  plan: UpdatePlan;
  /** Paths from plan.possiblyObsolete the user chose to remove. */
  remove: string[];
  /** Planned targets the user unticked. */
  skip?: string[];
  backupRoot: string;
  modsRoots: string[];
  now?: () => number;
  isGameRunning?: () => Promise<boolean>;
}

export async function applyInstall(opts: ApplyOptions): Promise<InstallRecord> {
  const { plan, modsRoots } = opts;
  const skip = new Set(opts.skip ?? []);
  // Identical files are left alone: no copy, no backup.
  const files = plan.files.filter((f) => !skip.has(f.target) && !f.unchanged);
  if (!files.length && !opts.remove.length) throw translatedError((m) => m.installer.nothingSelected);
  if (await (opts.isGameRunning ?? defaultIsGameRunning)()) {
    throw translatedError((m) => m.installer.closeGameUpdate);
  }
  for (const f of files) {
    assertInside(f.target, modsRoots);
    if (f.replaces) assertInside(f.replaces, modsRoots);
  }
  for (const path of opts.remove) {
    if (!plan.possiblyObsolete.includes(path)) throw new Error(`Refusing to remove a file outside the plan: ${path}`);
    assertInside(path, modsRoots);
  }

  const at = (opts.now ?? Date.now)();
  // No creator name in the folder name: the backups folder shouldn't read as a list of what's installed.
  const id = `${at}-${randomBytes(4).toString('hex')}`;
  const backupDir = join(opts.backupRoot, id);
  const done: InstallOperation[] = [];
  const stamp = new Date(at);

  try {
    for (const f of files) {
      if (existsSync(f.target)) {
        const backup = backupPath(backupDir, f.target, modsRoots);
        await move(f.target, backup);
        done.push({ kind: 'replace', target: f.target, backup });
      } else {
        done.push({ kind: 'add', target: f.target });
      }
      // Another version or edition of it, under its old name: out, so the two don't both load.
      if (f.replaces && existsSync(f.replaces)) {
        const backup = backupPath(backupDir, f.replaces, modsRoots);
        await move(f.replaces, backup);
        done.push({ kind: 'remove', target: f.replaces, backup });
      }
      await mkdir(dirname(f.target), { recursive: true });
      await copyFile(f.source, f.target);
      // The file date is WhimWatch's record of "installed version"; mark it as now.
      await utimes(f.target, stamp, stamp);
    }
    for (const path of opts.remove) {
      const backup = backupPath(backupDir, path, modsRoots);
      await move(path, backup);
      done.push({ kind: 'remove', target: path, backup });
    }
  } catch (err) {
    await revert(done);
    throw err;
  }

  await clearThumbnailCache(modsRoots);
  return { id, creatorKey: plan.creatorKey, name: plan.name, at, backupDir, operations: done };
}

export async function undoInstall(
  record: InstallRecord,
  opts: { now?: () => number; isGameRunning?: () => Promise<boolean> } = {},
): Promise<InstallRecord> {
  if (record.undoneAt) return record;
  if (record.backupDeletedAt) throw translatedError((m) => m.installer.backupDeleted);
  if (await (opts.isGameRunning ?? defaultIsGameRunning)()) {
    throw translatedError((m) => m.installer.closeGameUndo);
  }
  for (const op of record.operations) {
    if (op.backup && !existsSync(op.backup)) throw translatedError((m) => m.installer.backupMissing(basename(op.target)));
  }
  await revert(record.operations);
  await rm(record.backupDir, { recursive: true, force: true });
  return { ...record, undoneAt: (opts.now ?? Date.now)() };
}

async function revert(ops: InstallOperation[]): Promise<void> {
  for (const op of [...ops].reverse()) {
    if (op.kind !== 'remove') await rm(op.target, { force: true });
    if (op.backup) await move(op.backup, op.target);
  }
}

function backupPath(backupDir: string, target: string, roots: string[]): string {
  const index = roots.findIndex((r) => rootOf(target, [r]));
  return index >= 0 ? join(backupDir, String(index), relative(roots[index]!, target)) : join(backupDir, 'other', basename(target));
}

function assertInside(path: string, roots: string[]): void {
  if (!rootOf(path, roots)) throw new Error(`Refusing to touch a file outside your Mods folders: ${path}`);
}

async function move(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

/** The game caches thumbnails next to the Mods folder; stale entries can show old CC. */
async function clearThumbnailCache(roots: string[]): Promise<void> {
  for (const root of roots) {
    if (basename(root).toLowerCase() !== 'mods') continue;
    await rm(join(dirname(root), 'localthumbcache.package'), { force: true }).catch(() => undefined);
  }
}
