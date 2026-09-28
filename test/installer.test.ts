import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractDownload, isSafeEntryPath, listArchive, parseSevenZipListing, UnsafeArchiveError } from '../src/core/archive.js';
import { applyInstall, planInstall, scriptDir, undoInstall } from '../src/core/installer.js';
import type { LocalFile } from '../src/shared/types.js';
import { buildZip } from './helpers/zip-builder.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'whimwatch-install-'));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await visit(full);
      else out[relative(root, full)] = await readFile(full, 'utf8');
    }
  };
  await visit(root);
  return out;
}

describe('archive extraction', () => {
  it('extracts mod files and reports everything unpacked', async () => {
    const zip = join(tmp, 'pack.zip');
    await writeFile(zip, buildZip([{ name: 'Pack/WW_Pack.package', data: 'pkg' }, { name: 'Pack/readme.txt', data: 'hi' }]));
    const files = await extractDownload(zip, join(tmp, 'out'));
    expect(files).toEqual([join('Pack', 'WW_Pack.package'), join('Pack', 'readme.txt')]);
    expect(await readFile(join(tmp, 'out', 'Pack', 'WW_Pack.package'), 'utf8')).toBe('pkg');
  });

  it('unpacks archives nested one level deep', async () => {
    const inner = buildZip([{ name: 'WW_Inner.package', data: 'inner' }]);
    const zip = join(tmp, 'outer.zip');
    await writeFile(zip, buildZip([{ name: 'inner.zip', data: inner }]));
    const files = await extractDownload(zip, join(tmp, 'out'));
    expect(files).toContain(join('inner.zip.contents', 'WW_Inner.package'));
  });

  it('refuses path traversal', async () => {
    const zip = join(tmp, 'evil.zip');
    await writeFile(zip, buildZip([{ name: '../../escape.package', data: 'x' }]));
    await expect(extractDownload(zip, join(tmp, 'out'))).rejects.toBeInstanceOf(UnsafeArchiveError);
    expect(existsSync(join(tmp, '..', 'escape.package'))).toBe(false);
  });

  it('refuses archives that contain programs', async () => {
    const zip = join(tmp, 'exe.zip');
    await writeFile(zip, buildZip([{ name: 'WW.package', data: 'x' }, { name: 'installer.exe', data: 'MZ' }]));
    await expect(extractDownload(zip, join(tmp, 'out'))).rejects.toThrow(/program/);
    expect(existsSync(join(tmp, 'out', 'WW.package'))).toBe(false);
  });

  it('refuses zips containing symbolic links', async () => {
    const zip = join(tmp, 'link.zip');
    await writeFile(zip, buildZip([{ name: 'escape', data: '../../..', mode: 0o120777 }, { name: 'WW.package', data: 'x' }]));
    await expect(extractDownload(zip, join(tmp, 'out'))).rejects.toThrow(/link/);
    expect(existsSync(join(tmp, 'out', 'escape'))).toBe(false);
  });

  it('refuses real 7-Zip archives containing symbolic links', async () => {
    // symlink.7z holds readme.txt and escape.package -> ../../outside.txt (7za really creates that link).
    const archive = join(tmp, 'links.7z');
    await writeFile(archive, await readFile(join(import.meta.dirname, 'fixtures', 'archives', 'symlink.7z')));
    expect((await listArchive(archive)).find((e) => e.name === 'escape.package')).toMatchObject({ symlink: true });
    await expect(extractDownload(archive, join(tmp, 'out'))).rejects.toThrow(/link/);
    expect(existsSync(join(tmp, 'out'))).toBe(false);
  });

  it('only opens real 7z archives as .7z', async () => {
    // 7-Zip reads many formats; a zip (or disk image) renamed to .7z must not be unpacked by it.
    const fake = join(tmp, 'fake.7z');
    await writeFile(fake, buildZip([{ name: 'WW.package', data: 'x' }]));
    await expect(extractDownload(fake, join(tmp, 'out'))).rejects.toThrow();
    expect(existsSync(join(tmp, 'out', 'WW.package'))).toBe(false);
  });

  it('lists and extracts RAR archives off the main thread', async () => {
    const rar = join(import.meta.dirname, 'fixtures', 'archives', 'FolderTest.rar');
    const entries = await listArchive(rar);
    expect(entries.find((e) => e.name.endsWith('long.txt'))).toMatchObject({ size: 1049076, directory: false });
    const out = join(tmp, 'rar');
    await mkdir(out);
    const copy = join(tmp, 'FolderTest.rar');
    await writeFile(copy, await readFile(rar));
    // No mod files inside, so extractDownload unpacks it and returns its text files.
    const files = await extractDownload(copy, out);
    expect(files.some((f) => f.endsWith('long.txt'))).toBe(true);
    expect((await stat(join(out, files.find((f) => f.endsWith('long.txt'))!))).size).toBe(1049076);
  });

  it('cancels RAR extraction', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(extractDownload(join(import.meta.dirname, 'fixtures', 'archives', 'WithComment.rar'), join(tmp, 'x'), abort.signal)).rejects.toThrow(
      'Cancelled',
    );
  });

  it('checks entry paths', () => {
    expect(isSafeEntryPath('a/b.package')).toBe(true);
    expect(isSafeEntryPath('..\\x')).toBe(false);
    expect(isSafeEntryPath('C:\\Windows\\x')).toBe(false);
    expect(isSafeEntryPath('/etc/passwd')).toBe(false);
  });

  it('parses 7-Zip technical listings', () => {
    const out =
      'Path = Pack\nFolder = +\nSize = 0\n\nPath = Pack/a.package\nFolder = -\nSize = 12\n\nPath = b\nAttributes = D_ drwxr-xr-x\nSize = 0\n\nPath = link\nAttributes = _ lrwxrwxrwx\nSize = 9\n';
    expect(parseSevenZipListing(out)).toEqual([
      { name: 'Pack', size: 0, directory: true, symlink: false },
      { name: 'Pack/a.package', size: 12, directory: false, symlink: false },
      { name: 'b', size: 0, directory: true, symlink: false },
      { name: 'link', size: 9, directory: false, symlink: true },
    ]);
  });
});

describe('installer', () => {
  const localFile = async (path: string, root: string): Promise<LocalFile> => {
    const st = await stat(path);
    return { path, root, relPath: relative(root, path), size: st.size, mtimeMs: st.mtimeMs, kind: 'ww-animation', authors: {} };
  };

  it('plans replacements, additions and possibly obsolete files', async () => {
    const mods = join(tmp, 'Mods');
    await put(join(mods, 'Anims', 'Tester', 'WW_Tester.package'), 'old');
    await put(join(mods, 'Anims', 'Tester', 'WW_Tester_Old.package'), 'old2');
    const installed = [
      await localFile(join(mods, 'Anims', 'Tester', 'WW_Tester.package'), mods),
      await localFile(join(mods, 'Anims', 'Tester', 'WW_Tester_Old.package'), mods),
    ];
    const extracted = join(tmp, 'x');
    const plan = planInstall({
      id: 'p1',
      creatorKey: 'tester',
      name: 'Tester',
      downloadUrl: 'https://wicked.cc/x',
      source: 'wickedcc',
      downloads: ['Tester.zip'],
      extractedDir: extracted,
      extractedFiles: ['WW_TESTER.package', join('extra', 'WW_Tester_New.package'), 'Tester_Script.ts4script', 'readme.txt', join('alt', 'WW_Tester.package')],
      installedFiles: installed,
      modsRoots: [mods],
    });

    expect(plan.files).toEqual([
      { source: join(extracted, 'WW_TESTER.package'), target: join(mods, 'Anims', 'Tester', 'WW_Tester.package'), kind: 'replace', installedAt: installed[0]!.mtimeMs },
      { source: join(extracted, 'extra', 'WW_Tester_New.package'), target: join(mods, 'Anims', 'Tester', 'WW_Tester_New.package'), kind: 'add' },
      // Scripts go no deeper than one folder.
      { source: join(extracted, 'Tester_Script.ts4script'), target: join(mods, 'Anims', 'Tester_Script.ts4script'), kind: 'add' },
    ]);
    expect(plan.possiblyObsolete).toEqual([join(mods, 'Anims', 'Tester', 'WW_Tester_Old.package')]);
    expect(plan.skipped).toEqual(['readme.txt']);
    expect(plan.warnings).toEqual([`The download has more than one WW_Tester.package; only WW_TESTER.package will be installed.`]);
  });

  it('keeps script mods within one folder of the Mods root', () => {
    const mods = join(tmp, 'Mods');
    expect(scriptDir(join(mods, 'a', 'b', 'c'), [mods])).toBe(join(mods, 'a'));
    expect(scriptDir(join(mods, 'a'), [mods])).toBe(join(mods, 'a'));
    expect(scriptDir(mods, [mods])).toBe(mods);
  });

  it('applies with backups and undoes back to the exact original files', async () => {
    const mods = join(tmp, 'Mods');
    await put(join(mods, 'Tester', 'WW_Tester.package'), 'v1');
    await put(join(mods, 'Tester', 'WW_Tester_Old.package'), 'obsolete');
    await put(join(mods, 'Other.package'), 'unrelated');
    await put(join(tmp, 'localthumbcache.package'), 'cache');
    await put(join(tmp, 'x', 'WW_Tester.package'), 'v2');
    await put(join(tmp, 'x', 'WW_Tester_New.package'), 'new');
    const before = await tree(mods);

    const installed = [await localFile(join(mods, 'Tester', 'WW_Tester.package'), mods), await localFile(join(mods, 'Tester', 'WW_Tester_Old.package'), mods)];
    const plan = planInstall({
      id: 'p2', creatorKey: 'tester', name: 'Tester', downloadUrl: '', source: 'wickedcc', downloads: ['a.zip'],
      extractedDir: join(tmp, 'x'), extractedFiles: ['WW_Tester.package', 'WW_Tester_New.package'], installedFiles: installed, modsRoots: [mods],
    });
    const now = Date.UTC(2026, 8, 14);
    const record = await applyInstall({
      plan,
      remove: [join(mods, 'Tester', 'WW_Tester_Old.package')],
      backupRoot: join(tmp, 'backups'),
      modsRoots: [mods],
      now: () => now,
      isGameRunning: async () => false,
    });

    expect(await tree(mods)).toEqual({
      [join('Tester', 'WW_Tester.package')]: 'v2',
      [join('Tester', 'WW_Tester_New.package')]: 'new',
      'Other.package': 'unrelated',
    });
    expect((await stat(join(mods, 'Tester', 'WW_Tester.package'))).mtimeMs).toBe(now);
    expect(record.operations.map((o) => o.kind)).toEqual(['replace', 'add', 'remove']);
    // The backup folder name doesn't say whose files are inside.
    expect(basename(record.backupDir)).toMatch(/^\d{13}-[0-9a-f]{8}$/);
    expect(existsSync(join(tmp, 'localthumbcache.package'))).toBe(false);

    const undone = await undoInstall(record, { isGameRunning: async () => false });
    expect(undone.undoneAt).toBeDefined();
    expect(await tree(mods)).toEqual(before);
    expect(existsSync(record.backupDir)).toBe(false);
  });

  it('changes nothing while the game is running', async () => {
    const mods = join(tmp, 'Mods');
    await put(join(mods, 'WW_Tester.package'), 'v1');
    await put(join(tmp, 'x', 'WW_Tester.package'), 'v2');
    const plan = planInstall({
      id: 'p3', creatorKey: 'tester', name: 'Tester', downloadUrl: '', source: 'wickedcc', downloads: ['a.zip'],
      extractedDir: join(tmp, 'x'), extractedFiles: ['WW_Tester.package'], installedFiles: [await localFile(join(mods, 'WW_Tester.package'), mods)], modsRoots: [mods],
    });
    await expect(
      applyInstall({ plan, remove: [], backupRoot: join(tmp, 'b'), modsRoots: [mods], isGameRunning: async () => true }),
    ).rejects.toThrow(/Close The Sims 4/);
    expect(await readFile(join(mods, 'WW_Tester.package'), 'utf8')).toBe('v1');
  });

  it('leaves unticked files alone', async () => {
    const mods = join(tmp, 'Mods');
    await put(join(mods, 'WW_A.package'), 'a1');
    await put(join(tmp, 'x', '1-A.zip', 'WW_A.package'), 'a2');
    await put(join(tmp, 'x', '2-B.package', 'WW_B.package'), 'b');
    const plan = planInstall({
      id: 'p5', creatorKey: 'tester', name: 'Tester', downloadUrl: '', source: 'wickedcc', downloads: ['A.zip', 'B.package'],
      extractedDir: join(tmp, 'x'), extractedFiles: [join('1-A.zip', 'WW_A.package'), join('2-B.package', 'WW_B.package')],
      installedFiles: [await localFile(join(mods, 'WW_A.package'), mods)], modsRoots: [mods],
    });
    expect(plan.files.map((f) => f.kind)).toEqual(['replace', 'add']);

    await applyInstall({ plan, remove: [], skip: [join(mods, 'WW_B.package')], backupRoot: join(tmp, 'b'), modsRoots: [mods], isGameRunning: async () => false });
    expect(await tree(mods)).toEqual({ 'WW_A.package': 'a2' });

    const all = plan.files.map((f) => f.target);
    await expect(applyInstall({ plan, remove: [], skip: all, backupRoot: join(tmp, 'b'), modsRoots: [mods], isGameRunning: async () => false })).rejects.toThrow(/Nothing was selected/);
  });

  it('refuses to write outside the Mods folders', async () => {
    const mods = join(tmp, 'Mods');
    await mkdir(mods, { recursive: true });
    const plan = {
      id: 'p4', creatorKey: 'x', name: 'x', downloadUrl: '', source: 'wickedcc' as const, downloads: [], possiblyObsolete: [], skipped: [], warnings: [], upToDate: false,
      files: [{ source: join(tmp, 'a'), target: join(tmp, 'elsewhere.package'), kind: 'add' as const }],
    };
    await expect(applyInstall({ plan, remove: [], backupRoot: join(tmp, 'b'), modsRoots: [mods], isGameRunning: async () => false })).rejects.toThrow(/outside your Mods/);
  });
});
