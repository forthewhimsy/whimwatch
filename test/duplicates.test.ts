import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCleanup, findDuplicates, suggestKeep } from '../src/core/duplicates.js';
import { undoInstall } from '../src/core/installer.js';
import type { LocalFile } from '../src/shared/types.js';

let tmp: string;
let mods: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'whimwatch-dupes-'));
  mods = join(tmp, 'Mods');
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

async function put(rel: string, content: string): Promise<string> {
  const path = join(mods, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

async function local(path: string): Promise<LocalFile> {
  const st = await stat(path);
  return { path, root: mods, relPath: relative(mods, path), size: st.size, mtimeMs: st.mtimeMs, kind: 'other', authors: {} };
}

async function tree(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await visit(full);
      else out[relative(mods, full)] = await readFile(full, 'utf8');
    }
  };
  await visit(mods);
  return out;
}

describe('finding duplicates', () => {
  it('groups files that are byte for byte the same, and only those', async () => {
    const a = await put(join('Moonberry', 'WW_Moonberry_Juniper.package'), 'juniper');
    const b = await put(join('Downloads', 'WW_Moonberry_Juniper.package'), 'juniper');
    const c = await put('WW_Moonberry_Juniper (1).package', 'juniper');
    // Same size, different bytes; and one of a kind.
    const d = await put('WW_Amberlily_Thornwood.package', 'thornwo');
    const e = await put('WW_EchoSims_Velvet.package', 'velvet, alone');
    const progress: [number, number][] = [];
    const groups = await findDuplicates(await Promise.all([a, b, c, d, e].map(local)), { onProgress: (done, total) => progress.push([done, total]) });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.copies.map((x) => x.path).sort()).toEqual([a, b, c].sort());
    expect(groups[0]!.size).toBe(7);
    // Only same-size files were read: the one of a kind never was.
    expect(progress.at(-1)).toEqual([28, 28]);
  });

  it('takes a hard link or a symbolic link for the file it is, not a duplicate', async () => {
    const a = await put('Juniper.package', 'juniper');
    const hard = join(mods, 'Hard.package');
    await link(a, hard);
    const soft = join(mods, 'Soft.package');
    await symlink(a, soft);
    expect(await findDuplicates(await Promise.all([a, hard, soft].map(local)))).toEqual([]);
  });

  it("doesn't offer a copy that really lives outside the Mods folders, behind a linked folder", async () => {
    const own = await put('Juniper.package', 'juniper');
    // A library shared between game profiles, linked into Mods.
    const library = join(tmp, 'Library');
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'Juniper.package'), 'juniper');
    await symlink(library, join(mods, 'Shared'));
    const linked = join(mods, 'Shared', 'Juniper.package');
    expect(await findDuplicates(await Promise.all([own, linked].map(local)), { roots: [mods] })).toEqual([]);
    // Nor removes it, were it asked to.
    const { record, skipped } = await applyCleanup({ groups: [{ keep: own, remove: [linked] }], backupRoot: join(tmp, 'backups'), modsRoots: [mods], isGameRunning: async () => false });
    expect(record).toBeUndefined();
    expect(skipped).toBe(1);
    expect(await readFile(join(library, 'Juniper.package'), 'utf8')).toBe('juniper');
  });

  it('stops when cancelled', async () => {
    const a = await put('A.package', 'same');
    const b = await put('B.package', 'same');
    const abort = new AbortController();
    abort.abort();
    await expect(findDuplicates(await Promise.all([a, b].map(local)), { signal: abort.signal })).rejects.toThrow();
  });
});

describe('the copy to keep', () => {
  const copy = (relPath: string, mtimeMs = 0) => ({ path: join('/m', relPath), root: '/m', relPath, mtimeMs });

  it('keeps one without a copy marker, then the least deeply filed, then the oldest', () => {
    expect(suggestKeep([copy('Juniper (1).package'), copy('a/b/Juniper.package')], new Set())).toBe(join('/m', 'a/b/Juniper.package'));
    expect(suggestKeep([copy('a/b/Juniper.package'), copy('a/Juniper.package')], new Set())).toBe(join('/m', 'a/Juniper.package'));
    expect(suggestKeep([copy('a/Juniper.package', 5), copy('b/Juniper.package', 3)], new Set())).toBe(join('/m', 'b/Juniper.package'));
  });

  it('keeps the one WhimWatch installed, where its updates look for it', () => {
    expect(suggestKeep([copy('Juniper.package'), copy('Extras/Juniper.package')], new Set([join('/m', 'Extras/Juniper.package')]))).toBe(join('/m', 'Extras/Juniper.package'));
  });

  it('keeps a script that loads over one filed too deep to', () => {
    expect(suggestKeep([copy('a/b/Thornwood.ts4script'), copy('a/Thornwood.ts4script', 9)], new Set([join('/m', 'a/b/Thornwood.ts4script')]))).toBe(join('/m', 'a/Thornwood.ts4script'));
  });
});

describe('removing duplicates', () => {
  const noGame = async (): Promise<boolean> => false;

  it('backs the copies up, and undo puts them back', async () => {
    const keep = await put(join('Moonberry', 'Juniper.package'), 'juniper');
    const extra = await put('Juniper (1).package', 'juniper');
    await put('Other.package', 'other');
    const before = await tree();
    const { record, skipped } = await applyCleanup({ groups: [{ keep, remove: [extra] }], backupRoot: join(tmp, 'backups'), modsRoots: [mods], isGameRunning: noGame });
    expect(skipped).toBe(0);
    expect(record?.cleanup).toBe(true);
    expect(record?.operations.map((o) => o.kind)).toEqual(['remove']);
    expect(Object.keys(await tree()).sort()).toEqual([join('Moonberry', 'Juniper.package'), 'Other.package']);
    await undoInstall(record!, { isGameRunning: noGame });
    expect(await tree()).toEqual(before);
  });

  it('leaves a copy that has changed since it was found', async () => {
    const keep = await put('Juniper.package', 'juniper');
    const extra = await put('Juniper (1).package', 'juniper');
    await writeFile(extra, 'edited by hand');
    const { record, skipped } = await applyCleanup({ groups: [{ keep, remove: [extra] }], backupRoot: join(tmp, 'backups'), modsRoots: [mods], isGameRunning: noGame });
    expect(record).toBeUndefined();
    expect(skipped).toBe(1);
    expect(await readFile(extra, 'utf8')).toBe('edited by hand');
  });

  it("doesn't remove a name that is the kept file itself", async () => {
    const keep = await put('Juniper.package', 'juniper');
    const hard = join(mods, 'Hard.package');
    await link(keep, hard);
    const { record, skipped } = await applyCleanup({ groups: [{ keep, remove: [hard] }], backupRoot: join(tmp, 'backups'), modsRoots: [mods], isGameRunning: noGame });
    expect(record).toBeUndefined();
    expect(skipped).toBe(1);
  });

  it('changes nothing while the game is running, or outside the Mods folders', async () => {
    const keep = await put('Juniper.package', 'juniper');
    const extra = await put('Juniper (1).package', 'juniper');
    await expect(
      applyCleanup({ groups: [{ keep, remove: [extra] }], backupRoot: join(tmp, 'backups'), modsRoots: [mods], isGameRunning: async () => true }),
    ).rejects.toThrow(/Close The Sims 4/);
    const outside = join(tmp, 'elsewhere.package');
    await writeFile(outside, 'juniper');
    await expect(applyCleanup({ groups: [{ keep, remove: [outside] }], backupRoot: join(tmp, 'backups'), modsRoots: [mods], isGameRunning: noGame })).rejects.toThrow(
      /outside your Mods/,
    );
    expect(Object.keys(await tree()).sort()).toEqual(['Juniper (1).package', 'Juniper.package']);
  });
});
