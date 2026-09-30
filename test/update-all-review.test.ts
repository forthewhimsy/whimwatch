import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markUnchanged, planInstall } from '../src/core/installer.js';
import { newFiles } from '../src/core/pack-files.js';
import type { BatchState, UpdatePlan } from '../src/shared/api.js';
import { t } from '../src/shared/i18n/index.js';
import type { CreatorLinkPrefs } from '../src/core/check.js';
import type { CreatorResult, InstallRecord, LocalFile } from '../src/shared/types.js';

// The updater's Electron side (site browsers, downloads) isn't reached: plans are made here.
vi.mock('../src/main/browser.js', () => ({ sessionsToClear: () => [], siteSession: () => ({}) }));
vi.mock('../src/main/downloads.js', () => ({}));
vi.mock('../src/main/log.js', () => ({ clearLog: () => undefined }));
vi.mock('../src/main/privacy.js', () => ({ clearSiteBrowsingData: async () => undefined }));
const game = vi.hoisted(() => ({ running: false }));
/** Hooks for the stand-in controller: run after each install is recorded, and make saving "Always add" fail. */
let afterInstall: () => void;
let trustFails: boolean;
vi.mock('../src/core/process.js', () => ({ isGameRunning: async () => game.running }));

const { Updater } = await import('../src/main/updater.js');
type AppController = ConstructorParameters<typeof Updater>[0];

const DAY = 86_400_000;
const NOW = Date.now();

let tmp: string;
let mods: string;
let linkPrefs: Record<string, CreatorLinkPrefs>;
let batches: BatchState[];
let installs: InstallRecord[];
let skipped: { key: string; left: readonly string[]; installed: readonly string[] }[];
let creators: CreatorResult[];
/** What each creator's download holds: file name → contents. */
let downloads: Record<string, Record<string, string>>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'whimwatch-review-'));
  mods = join(tmp, 'Mods');
  await mkdir(mods);
  linkPrefs = {};
  batches = [];
  installs = [];
  skipped = [];
  creators = [];
  downloads = {};
  game.running = false;
  afterInstall = () => undefined;
  trustFails = false;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function installed(name: string, contents: string): Promise<LocalFile> {
  const path = join(mods, name);
  await writeFile(path, contents);
  return { path, root: mods, relPath: name, size: contents.length, mtimeMs: NOW - 30 * DAY, kind: 'ww-animation', authors: {} };
}

/** A creator with one file of theirs, whose wicked.cc page is newer and offers `download`. */
async function creator(name: string, have: Record<string, string>, download: Record<string, string>): Promise<void> {
  const key = name.toLowerCase();
  const files = await Promise.all(Object.entries(have).map(([file, contents]) => installed(file, contents)));
  downloads[key] = download;
  creators.push({
    key,
    name,
    files,
    localUpdatedAt: NOW - 30 * DAY,
    remoteUpdatedAt: NOW - DAY,
    status: 'update-available',
    remotes: [
      {
        listing: { source: 'wickedcc', url: `https://wicked.cc.test/${key}`, origin: 'directory' },
        status: 'ok',
        checkedAt: NOW,
        updatedAt: NOW - DAY,
        downloadUrl: `https://wicked.cc.test/${key}/download`,
      },
    ],
  });
}

function makeUpdater(): InstanceType<typeof Updater> {
  const controller = {
    currentState: {
      get lastResult() {
        return { startedAt: NOW, finishedAt: NOW, dirs: [mods], core: { status: 'up-to-date' }, creators, unrecognizedCount: 0 };
      },
      linkPrefs,
      dirs: [mods],
      installs,
    },
    backupRoot: join(tmp, 'backups'),
    pool: {},
    installedFiles: () => creators.flatMap((c) => c.files),
    isSignedIn: () => false,
    addsNewFiles: (key: string) => linkPrefs[key]?.addNewFiles === true,
    setAddNewFiles: async (key: string, on: boolean) => {
      if (trustFails) throw new Error('Unknown creator');
      linkPrefs[key] ??= { rejected: [], manual: [] };
      if (on) linkPrefs[key].addNewFiles = true;
      else delete linkPrefs[key].addNewFiles;
    },
    setBatch: (batch: BatchState) => void batches.push(batch),
    rememberSkipped: (key: string, left: readonly string[], had: readonly string[]) => void skipped.push({ key, left, installed: had }),
    recordInstall: async (record: InstallRecord) => {
      installs.push(record);
      afterInstall();
    },
    refreshLocalFiles: async () => undefined,
    markSeen: async () => undefined,
    statusOf: () => 'update-available',
    emit: () => undefined,
  } as unknown as AppController;
  const updater = new Updater(controller, join(tmp, 'work'));
  const plans = (updater as unknown as { plans: Map<string, { plan: UpdatePlan; workDir: string }> }).plans;
  // Stands in for downloading and unpacking: the creator's files, planned by the real installer.
  vi.spyOn(updater, 'plan').mockImplementation(async (key) => {
    const c = creators.find((x) => x.key === key)!;
    const workDir = join(tmp, 'work', `${c.key}-${plans.size}`);
    const extractedDir = join(workDir, 'files');
    await mkdir(extractedDir, { recursive: true });
    for (const [name, contents] of Object.entries(downloads[c.key]!)) await writeFile(join(extractedDir, name), contents);
    const plan = planInstall({
      id: basename(workDir),
      creatorKey: c.key,
      name: c.name,
      downloadUrl: c.remotes[0]!.listing.url,
      source: 'wickedcc',
      downloads: [`${c.key}.zip`],
      extractedDir,
      extractedFiles: Object.keys(downloads[c.key]!),
      installedFiles: c.files,
      modsRoots: [mods],
    });
    await markUnchanged(plan);
    plans.set(plan.id, { plan, workDir });
    return plan;
  });
  return updater;
}

const last = (): BatchState => batches.at(-1)!;
const item = (key: string) => last().items.find((i) => i.key === key)!;
const read = (name: string): Promise<string> => readFile(join(mods, name), 'utf8');

describe('Update all and files the user does not have', () => {
  beforeEach(async () => {
    await creator('Amberlily', { 'Amberlily_Poses.package': 'old' }, { 'Amberlily_Poses.package': 'new' });
    await creator(
      'Moonberry',
      { 'Moonberry_Animations.package': 'old' },
      { 'Moonberry_Animations.package': 'new', 'Moonberry_LoadingScreen.package': 'loading screen' },
    );
  });

  it('installs an update that only replaces files, and holds one that adds files for the user to choose', async () => {
    await makeUpdater().updateAll(['amberlily', 'moonberry']);

    expect(await read('Amberlily_Poses.package')).toBe('new');
    expect(item('amberlily')).toMatchObject({ state: 'done', replaced: 1, added: 0 });
    // Nothing of Moonberry's is touched until the user has seen the new file.
    expect(await read('Moonberry_Animations.package')).toBe('old');
    expect(existsSync(join(mods, 'Moonberry_LoadingScreen.package'))).toBe(false);
    expect(item('moonberry')).toMatchObject({ state: 'review', message: t().updater.batchNewFiles(1) });
    expect(item('moonberry').review?.files.map((f) => `${f.kind} ${basename(f.target)}`)).toEqual([
      'replace Moonberry_Animations.package',
      'add Moonberry_LoadingScreen.package',
    ]);
    expect(last().running).toBe(false);
  });

  it('installs only the ticked files, in the same run, and remembers the unticked one', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['amberlily', 'moonberry']);
    const loadingScreen = item('moonberry').review!.files.find((f) => f.kind === 'add')!.target;

    await updater.finishReview([{ key: 'moonberry', skip: [loadingScreen] }]);

    expect(await read('Moonberry_Animations.package')).toBe('new');
    expect(existsSync(loadingScreen)).toBe(false);
    expect(item('moonberry')).toMatchObject({ state: 'done', replaced: 1, added: 0 });
    expect(item('moonberry').review).toBeUndefined();
    // One run, so Undo all takes back both.
    expect(new Set(installs.map((i) => i.batchId))).toEqual(new Set([last().batchId]));
    expect(skipped.at(-1)).toEqual({ key: 'moonberry', left: ['Moonberry_LoadingScreen.package'], installed: [] });
    expect(linkPrefs.moonberry?.addNewFiles).toBeUndefined();
  });

  it('names the new files it added in the summary', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    await updater.finishReview([{ key: 'moonberry', skip: [] }]);

    expect(await read('Moonberry_LoadingScreen.package')).toBe('loading screen');
    expect(item('moonberry')).toMatchObject({ state: 'done', replaced: 1, added: 1, addedNames: ['Moonberry_LoadingScreen.package'] });
  });

  it('leaves the updates it is not told to install for later, with their downloads gone', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);

    // A key that isn't waiting is ignored, and the one that is waits no more.
    await updater.finishReview([{ key: 'amberlily', skip: [] }, { key: 'nobody' }, 'moonberry', null]);

    expect(item('moonberry')).toMatchObject({ state: 'cancelled', message: t().updater.leftForLater });
    expect(await read('Moonberry_Animations.package')).toBe('old');
    expect(await read('Amberlily_Poses.package')).toBe('old');
    expect(installs).toEqual([]);
    expect(existsSync(join(tmp, 'work', 'moonberry-0'))).toBe(false);
  });

  it('leaves an update with every file unticked for later rather than failing it', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    await updater.finishReview([{ key: 'moonberry', skip: item('moonberry').review!.files.map((f) => f.target) }]);

    expect(item('moonberry')).toMatchObject({ state: 'cancelled', message: t().updater.leftForLater });
    expect(installs).toEqual([]);
  });

  it('keeps everything waiting while the game is open', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    game.running = true;

    await expect(updater.finishReview([{ key: 'moonberry', skip: [] }])).rejects.toThrow(t().installer.closeGameUpdate);
    expect(item('moonberry').state).toBe('review');
  });

  it('leaves them all for later with Not now, even while the game is open', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    game.running = true;

    await updater.finishReview([]);
    expect(item('moonberry')).toMatchObject({ state: 'cancelled', message: t().updater.leftForLater });
    expect(await read('Moonberry_Animations.package')).toBe('old');
  });

  it('stops after the install under way when asked, leaving the rest for later', async () => {
    await creator('EchoSims', { 'EchoSims_Poses.package': 'old' }, { 'EchoSims_Poses.package': 'new', 'EchoSims_Extra.package': 'extra' });
    const updater = makeUpdater();
    await updater.updateAll(['moonberry', 'echosims']);
    afterInstall = () => updater.stopUpdateAll();

    await updater.finishReview([
      { key: 'moonberry', skip: [] },
      { key: 'echosims', skip: [] },
    ]);

    expect(item('moonberry').state).toBe('done');
    expect(item('echosims')).toMatchObject({ state: 'cancelled', message: t().updater.leftForLater });
    expect(await read('EchoSims_Poses.package')).toBe('old');
    // The window heard about the stop while it was running ("Stopping after the current one").
    expect(batches.some((b) => b.running && b.stopRequested)).toBe(true);
    expect(last()).toMatchObject({ running: false, stopRequested: false });
  });

  it('starts a review without a stop left over from the run before it', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    updater.stopUpdateAll();

    await updater.finishReview([{ key: 'moonberry', skip: [] }]);
    expect(item('moonberry').state).toBe('done');
  });

  it("doesn't call an install failed when only saving Always add fails", async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    trustFails = true;

    await updater.finishReview([{ key: 'moonberry', skip: [], always: true }]);
    expect(item('moonberry')).toMatchObject({ state: 'done', replaced: 1, added: 1 });
  });

  it('waits, rather than failing everything, while another update holds the lock', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    (updater as unknown as { busy: boolean }).busy = true;

    await expect(updater.finishReview([{ key: 'moonberry', skip: [] }])).rejects.toThrow(t().updater.anotherUpdate);
    expect(item('moonberry').state).toBe('review');
  });

  it('leaves them for later with Not now even while another update holds the lock', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    (updater as unknown as { busy: boolean }).busy = true;

    await updater.finishReview([]);
    expect(item('moonberry')).toMatchObject({ state: 'cancelled', message: t().updater.leftForLater });
  });

  it('says so when an update left for later is installed from its Update window', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    await updater.finishReview([]);

    const plan = await updater.plan('moonberry');
    await updater.apply(plan.id, { remove: [], skip: [] });
    expect(item('moonberry')).toMatchObject({ state: 'done', message: t().updater.batchInstalled(2, 'wicked.cc') });
    // Not one of the run's installs: its Undo all doesn't cover it.
    expect(item('moonberry').replaced).toBeUndefined();
  });

  it("adds a creator's new files without asking once told to, and says which", async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    await updater.finishReview([{ key: 'moonberry', skip: [], always: true }]);
    expect(linkPrefs.moonberry?.addNewFiles).toBe(true);

    // Their next update brings another new file: in it goes.
    downloads.moonberry = { 'Moonberry_Animations.package': 'newer', 'Moonberry_Extra.package': 'extra' };
    creators[1]!.files = [await installed('Moonberry_Animations.package', 'new'), await installed('Moonberry_LoadingScreen.package', 'loading screen')];
    await updater.updateAll(['moonberry']);

    expect(await read('Moonberry_Extra.package')).toBe('extra');
    expect(item('moonberry')).toMatchObject({ state: 'done', addedNames: ['Moonberry_Extra.package'] });
  });

  it('never installs new files on its own after a check, for a creator the user has not trusted', async () => {
    await makeUpdater().updateAll(['amberlily', 'moonberry'], { automatic: true, skipIfWarnings: true, publicOnly: true });

    expect(await read('Amberlily_Poses.package')).toBe('new');
    expect(await read('Moonberry_Animations.package')).toBe('old');
    expect(existsSync(join(mods, 'Moonberry_LoadingScreen.package'))).toBe(false);
    expect(item('moonberry')).toMatchObject({ state: 'failed', message: t().updater.batchNewFiles(1) });
  });

  it('forgets the waiting updates when a new run starts', async () => {
    const updater = makeUpdater();
    await updater.updateAll(['moonberry']);
    const first = last().batchId;
    await updater.updateAll(['amberlily']);

    expect(last().batchId).not.toBe(first);
    await updater.finishReview([{ key: 'moonberry', skip: [] }]);
    expect(await read('Moonberry_Animations.package')).toBe('old');
  });
});

describe('the files an update adds that the user has not seen', () => {
  const file = (target: string, kind: 'add' | 'replace', unchanged?: boolean) => ({ source: `/dl/${target}`, target, kind, unchanged });

  it('are the added ones, not replacements, identical files or ones skipped before', () => {
    expect(newFiles({ files: [file('/m/a.package', 'replace')] })).toEqual([]);
    expect(newFiles({ files: [file('/m/a.package', 'add', true)] })).toEqual([]);
    expect(newFiles({ files: [file('/m/b.package', 'add')], startUnticked: ['/m/b.package'] })).toEqual([]);
    expect(newFiles({ files: [file('/m/a.package', 'replace'), file('/m/c.package', 'add')] }).map((f) => f.target)).toEqual(['/m/c.package']);
  });
});
