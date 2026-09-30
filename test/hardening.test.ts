import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbpfError, withPackage } from '../src/core/dbpf.js';
import { DownloadUnavailableError, fetchAllowed, fileNameFrom } from '../src/core/downloads.js';
import { queueKey } from '../src/core/fetcher.js';
import { chooseRemote } from '../src/core/source-choice.js';
import { defaultState, SaveQueue, saveState, writeJsonAtomic } from '../src/core/store.js';
import { VerificationGate } from '../src/main/verification.js';
import type { RemoteInfo, SourceId } from '../src/shared/types.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'whimwatch-hardening-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmp, { recursive: true, force: true });
});

const remote = (source: SourceId, updatedAt: string, extra: Partial<RemoteInfo> = {}): RemoteInfo => ({
  listing: { source, url: `https://${source}.example/${source}`, origin: 'directory' },
  checkedAt: 0,
  status: 'ok',
  updatedAt: Date.parse(updatedAt),
  downloadUrl: 'https://x',
  ...extra,
});

describe('source choice', () => {
  const wicked = remote('wickedcc', '2026-09-01T10:00:00Z', { fileCount: 1 });
  const patreon = remote('patreon', '2026-09-10T10:00:00Z');
  const lovers = remote('loverslab', '2026-09-01T09:00:00Z');

  it('never picks a sign-in source for automatic installs', async () => {
    const countFiles = vi.fn(async () => 3);
    const signedIn = () => true;
    expect(await chooseRemote([wicked, patreon, lovers], { signedIn, countFiles })).toBe(patreon);
    expect(await chooseRemote([wicked, patreon, lovers], { signedIn, countFiles, publicOnly: true })).toBe(wicked);
    // Public-only never even asks LoversLab/Patreon how many files they have.
    expect(countFiles).not.toHaveBeenCalled();
  });

  it('breaks same-day ties by file count and honours an explicit choice', async () => {
    const countFiles = vi.fn(async (r: RemoteInfo) => (r.listing.source === 'loverslab' ? 3 : 0));
    expect(await chooseRemote([wicked, lovers], { signedIn: () => true, countFiles })).toBe(lovers);
    expect(await chooseRemote([wicked, lovers], { signedIn: () => true, countFiles, listingUrl: wicked.listing.url })).toBe(wicked);
    expect(await chooseRemote([lovers], { signedIn: () => false, countFiles })).toBeUndefined();
  });
});

describe('state saving', () => {
  it('survives overlapping saves without failures or corrupt files', async () => {
    const path = join(tmp, 'state.json');
    const queue = new SaveQueue();
    const saves = Array.from({ length: 100 }, (_, i) => queue.run(() => saveState(path, { ...defaultState(), dirs: [String(i).repeat(i * 50)] })));
    const results = await Promise.allSettled(saves);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    // The last save wins and the file is valid JSON; no temp files are left behind.
    expect(JSON.parse(await readFile(path, 'utf8')).dirs[0]).toBe('99'.repeat(99 * 50));
    expect((await readdir(tmp)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it("keeps a creator's new files being added without asking across restarts", async () => {
    const { loadState } = await import('../src/core/store.js');
    const path = join(tmp, 'adds.json');
    const state = defaultState();
    state.linkPrefs.moonberry = { rejected: [], manual: [], addNewFiles: true };
    await saveState(path, state);
    const loaded = await loadState(path);
    expect(loaded.linkPrefs.moonberry?.addNewFiles).toBe(true);
    expect(loaded.linkPrefs.amberlily?.addNewFiles).toBeUndefined();
  });

  it('keeps sites turned off, for everyone and per creator, across restarts', async () => {
    const { loadState } = await import('../src/core/store.js');
    const path = join(tmp, 'sites.json');
    const state = defaultState();
    state.settings.mutedSources = ['loverslab'];
    state.linkPrefs.pineglen = { rejected: [], manual: [], mutedSources: ['patreon', 'wickedcc'] };
    await saveState(path, state);
    const loaded = await loadState(path);
    expect(loaded.settings.mutedSources).toEqual(['loverslab']);
    expect(loaded.linkPrefs.pineglen?.mutedSources).toEqual(['patreon', 'wickedcc']);

    // A state file from before the setting existed turns nothing off.
    const { mutedSources: _dropped, ...oldSettings } = defaultState().settings;
    await writeFile(path, JSON.stringify({ ...defaultState(), settings: oldSettings }));
    expect((await loadState(path)).settings.mutedSources).toEqual([]);
  });

  it('uses unique temp files even without the queue', async () => {
    const path = join(tmp, 'direct.json');
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(path, { i })));
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(typeof JSON.parse(await readFile(path, 'utf8')).i).toBe('number');
  });
});

describe('request queue', () => {
  it('shares one queue between a site and its www host', () => {
    expect(queueKey('https://loverslab.com/files/file/1-x/')).toBe(queueKey('https://www.loverslab.com/files/file/2-y/'));
    expect(queueKey('https://www.patreon.com/api/posts')).toBe('patreon.com');
    expect(queueKey('https://files.wicked.cc/x.zip')).not.toBe(queueKey('https://wicked.cc/'));
  });
});

describe('human checks', () => {
  it('holds a site back until the check is passed, and tells the user once', () => {
    const gate = new VerificationGate();
    expect(gate.isArmed('patreon')).toBe(false);

    // One check can hit the same challenge on dozens of pages; the user hears about it once.
    expect(gate.arm('patreon')).toBe(true);
    expect(gate.arm('patreon')).toBe(false);
    expect(gate.isArmed('patreon')).toBe(true);
    expect(gate.isArmed('loverslab')).toBe(false);

    gate.clear('patreon');
    expect(gate.isArmed('patreon')).toBe(false);
    expect(gate.arm('patreon')).toBe(true);

    gate.arm('loverslab');
    gate.clear();
    expect(gate.isArmed('patreon')).toBe(false);
    expect(gate.isArmed('loverslab')).toBe(false);
  });

  it('says it again after the user waves the notice away without passing the check', () => {
    const gate = new VerificationGate();
    gate.arm('patreon');
    expect(gate.arm('patreon')).toBe(false);

    // Closing the banner doesn't let the site through; it just means saying so again, since every
    // page of that site is still going nowhere.
    gate.remind('patreon');
    expect(gate.isArmed('patreon')).toBe(true);
    expect(gate.arm('patreon')).toBe(true);
    expect(gate.arm('patreon')).toBe(false);
  });
});

describe('download redirects', () => {
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

  it('refuses a redirect to another site or to plain HTTP', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirect('https://evil.example/payload.zip')));
    await expect(fetchAllowed('https://wicked.cc/animations/x/download/1', {})).rejects.toBeInstanceOf(DownloadUnavailableError);

    vi.stubGlobal('fetch', vi.fn(async () => redirect('http://files.wicked.cc/file.zip')));
    await expect(fetchAllowed('https://wicked.cc/animations/x/download/1', {})).rejects.toThrow(/not HTTPS/);
  });

  it('follows allowed redirects and sends headers on every hop', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes('/download/') ? redirect('https://files.wicked.cc/file/wickedcc/X.zip') : new Response('zip', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchAllowed('https://wicked.cc/animations/x/download/1', { Referer: 'https://wicked.cc/animations/x' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ headers: { Referer: 'https://wicked.cc/animations/x' }, redirect: 'manual' });
  });

  it('keeps malformed file names instead of throwing', () => {
    expect(fileNameFrom("attachment; filename*=UTF-8''bad%E0%A4%A.zip", 'https://x/y')).toBe('bad%E0%A4%A.zip');
  });
});

describe('package reader bounds', () => {
  it('rejects headers that point past the end of the file', async () => {
    const header = Buffer.alloc(96);
    header.write('DBPF', 0, 'latin1');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(5, 36); // 5 entries…
    header.writeUInt32LE(0x7fffffff, 44); // …in a 2 GB index
    header.writeUInt32LE(96, 64);
    const path = join(tmp, 'evil.package');
    await writeFile(path, header);
    await expect(withPackage(path, async () => undefined)).rejects.toBeInstanceOf(DbpfError);
  });
});

describe('scan cache and state migration', () => {
  it('moves the old inline scan cache out and keeps only a count of other files', async () => {
    const { loadScanCache, loadState } = await import('../src/core/store.js');
    const statePath = join(tmp, 'state.json');
    const legacy = {
      ...defaultState(),
      scanCache: { '/mods/a.package': { size: 1, mtimeMs: 1, kind: 'other', authors: {} } },
      lastResult: { startedAt: 0, finishedAt: 0, dirs: [], core: { status: 'unknown' }, creators: [], unrecognized: [{}, {}, {}] },
    };
    await writeFile(statePath, JSON.stringify(legacy));
    const state = await loadState(statePath);
    expect(state.lastResult?.unrecognizedCount).toBe(3);
    expect('unrecognized' in (state.lastResult ?? {})).toBe(false);
    expect('scanCache' in state).toBe(false);
    expect(Object.keys(await loadScanCache(join(tmp, 'scan-cache.json'), statePath))).toEqual(['/mods/a.package']);
  });

  it('rescans only changed paths and rebuilds the file list from the cache', async () => {
    const { filesFromCache, rescanPaths, scanDirs } = await import('../src/core/scanner.js');
    const mods = join(tmp, 'Mods');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(mods);
    await writeFile(join(mods, 'keep.package'), 'not really a package');
    await writeFile(join(mods, 'old.package'), 'x');
    const { cache } = await scanDirs([mods]);

    await rm(join(mods, 'old.package'));
    await writeFile(join(mods, 'new.package'), 'y');
    const next = await rescanPaths([join(mods, 'old.package'), join(mods, 'new.package')], [mods], cache);
    expect(Object.keys(next).sort()).toEqual([join(mods, 'keep.package'), join(mods, 'new.package')]);
    expect(filesFromCache(next)?.map((f) => f.relPath).sort()).toEqual(['keep.package', 'new.package']);
    // Caches written by older versions have no roots, so callers fall back to a full scan.
    expect(filesFromCache({ '/x.package': { size: 1, mtimeMs: 1, kind: 'other', authors: {} } as never })).toBeUndefined();
  });
});

describe('packaging', () => {
  it('ships only the build output on every platform', async () => {
    // A platform's `files` list replaces the top-level one; with only exclusions it packages the whole project.
    // Windows checkouts can have CRLF line endings.
    const config = (await readFile(join(import.meta.dirname, '..', 'electron-builder.yml'), 'utf8')).replace(/\r\n/g, '\n');
    const lists = [...config.matchAll(/^( *)files:\n((?:\1 +- .*\n)+)/gm)].map((m) => m[2]!.split('\n').map((l) => l.trim().replace(/^- /, '')).filter(Boolean));
    expect(lists.length).toBe(4); // top level, win, mac, linux
    for (const list of lists) {
      expect(list).toContain('out/**');
      expect(list.filter((p) => !p.startsWith("'!") && !p.startsWith('!'))).toEqual(['out/**', 'package.json']);
    }
  });
});

describe('defaults', () => {
  it('never checks or installs anything the user didn\'t ask for', () => {
    const { settings } = defaultState();
    expect(settings.checkOnLaunch).toBe(false);
    expect(settings.autoInstall).toBe(false);
  });
});

describe('app window content security policy', () => {
  it('lets the packaged window run only its own files', async () => {
    const { PRODUCTION_CSP, DEVELOPMENT_CSP } = await import('../scripts/csp.js');
    const directives = Object.fromEntries(PRODUCTION_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]));
    expect(directives).toMatchObject({
      'default-src': "'none'",
      'script-src': "'self'",
      'style-src': "'self'",
      'connect-src': "'none'",
      'object-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'",
      'frame-src': "'none'",
    });
    expect(PRODUCTION_CSP).not.toMatch(/unsafe-|data:|\*|https?:/);
    // Development relaxes only what Vite's dev server needs.
    expect(DEVELOPMENT_CSP).not.toContain('unsafe-eval');
    expect(DEVELOPMENT_CSP).toContain("object-src 'none'");
  });
});

describe('help and feedback links', () => {
  it('open the repository forms that exist, with only harmless pre-filled fields', async () => {
    const { docsUrl, newIssueUrl, securityReportUrl } = await import('../src/shared/config.js');
    const { existsSync } = await import('node:fs');
    for (const form of ['bug_report', 'site_changed', 'creator_link', 'feature_request'] as const) {
      expect(existsSync(join(import.meta.dirname, '..', '.github', 'ISSUE_TEMPLATE', `${form}.yml`))).toBe(true);
    }
    const url = new URL(newIssueUrl('bug_report', { os: 'Windows · WhimWatch 0.1.0' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/forthewhimsy/whimwatch/issues/new');
    expect(Object.fromEntries(url.searchParams)).toEqual({ template: 'bug_report.yml', os: 'Windows · WhimWatch 0.1.0' });
    expect(docsUrl()).toBe('https://github.com/forthewhimsy/whimwatch#readme');
    expect(securityReportUrl()).toBe('https://github.com/forthewhimsy/whimwatch/security/advisories/new');
  });
});
