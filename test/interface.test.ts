import { describe, expect, it } from 'vitest';
import { runBatch } from '../src/core/batch.js';
import type { AppSnapshot } from '../src/shared/api.js';
import type { CoreResult, CreatorResult, InstallRecord, RemoteInfo, SeenEvent } from '../src/shared/types.js';
import { newPackAction, rowAction, rowStatus, rowSummary, sortCreators, updateCandidates } from '../src/renderer/src/eligibility.js';
import { acceleratorFromKey, acceleratorKeys, formatCount, pageLabel, shortTitle, timeAgo } from '../src/renderer/src/format.js';
import { t } from '../src/shared/i18n/index.js';
import { gameHealth } from '../src/renderer/src/health.js';
import { plainTitle } from '../src/shared/labels.js';
import { dayLabel, fileCounts, historyItems, isUndone, matchesFilter } from '../src/renderer/src/history.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 14, 15, 0).getTime();

const remote = (source: RemoteInfo['listing']['source'], extra: Partial<RemoteInfo> = {}): RemoteInfo => ({
  listing: { source, url: `https://${source}.test/page`, origin: 'directory' },
  status: 'ok',
  checkedAt: NOW,
  updatedAt: NOW - 3 * DAY,
  downloadUrl: `https://${source}.test/download`,
  ...extra,
});

const creator = (name: string, status: CreatorResult['status'], remotes: RemoteInfo[], extra: Partial<CreatorResult> = {}): CreatorResult => ({
  key: name.toLowerCase(),
  name,
  files: [],
  localUpdatedAt: NOW - 60 * DAY,
  remotes,
  remoteUpdatedAt: remotes.find((r) => r.status === 'ok')?.updatedAt,
  status,
  ...extra,
});

const snapshot = (signedIn: { loverslab?: boolean; patreon?: boolean } = {}): AppSnapshot =>
  ({
    accounts: [
      { site: 'loverslab', label: 'LoversLab', signedIn: Boolean(signedIn.loverslab) },
      { site: 'patreon', label: 'Patreon', signedIn: Boolean(signedIn.patreon) },
    ],
  }) as AppSnapshot;

describe('creator rows', () => {
  it('show one status, and split "needs a look" into what actually needs doing', () => {
    expect(rowStatus(creator('A', 'update-available', [remote('wickedcc')]))).toBe('update');
    expect(rowStatus(creator('B', 'needs-verification', [remote('loverslab', { status: 'needs-verification' })]))).toBe('verify');
    expect(rowStatus(creator('C', 'unknown', []))).toBe('missing');
    expect(rowStatus(creator('D', 'unknown', [remote('patreon', { status: 'error', updatedAt: undefined })]))).toBe('failed');
  });

  it("keep creators only found on turned-off sites out of \"Need a look\"", () => {
    const off = creator('E', 'unknown', [], { mutedSources: ['loverslab', 'patreon'] });
    expect(rowStatus(off)).toBe('off');
    expect(rowAction(off, snapshot())).toEqual({ kind: 'none' });
    expect(rowSummary(off, (t) => timeAgo(t, NOW))).toBe('LoversLab and Patreon are turned off');
    // Another site still has a page: that one decides the status.
    expect(rowStatus(creator('F', 'up-to-date', [remote('wickedcc')], { mutedSources: ['patreon'] }))).toBe('current');
  });

  it('keep a creator with no pages out of "Need a look" once every site is turned off for them', () => {
    const none = creator('G', 'unknown', [], { allSitesOff: true });
    expect(rowStatus(none)).toBe('off');
    expect(rowAction(none, snapshot())).toEqual({ kind: 'none' });
    expect(rowSummary(none, (t) => timeAgo(t, NOW))).toBe('Every site is turned off');
  });

  it('offer the one button that helps', () => {
    const snap = snapshot();
    expect(rowAction(creator('A', 'update-available', [remote('wickedcc')]), snap)).toEqual({ kind: 'update' });
    expect(rowAction(creator('B', 'update-available', [remote('patreon')]), snap)).toEqual({ kind: 'sign-in', site: 'patreon' });
    expect(rowAction(creator('C', 'update-available', [remote('patreon', { locked: true })]), snapshot({ patreon: true }))).toEqual({
      kind: 'open',
      url: 'https://patreon.test/page',
    });
    expect(rowAction(creator('D', 'needs-verification', [remote('loverslab', { status: 'needs-verification' })]), snap)).toEqual({ kind: 'verify', site: 'loverslab' });
    expect(rowAction(creator('E', 'unknown', []), snap)).toEqual({ kind: 'add-page' });
    expect(rowAction(creator('F', 'up-to-date', [remote('wickedcc')]), snap)).toEqual({ kind: 'none' });
  });

  it("offer, on a card for something new, Get it or what's in its way, as the row does", () => {
    const out = snapshot();
    expect(newPackAction(remote('wickedcc'), out)).toEqual({ kind: 'get' });
    // Signed out, and that's all that's missing: the card says so, and turns into Get it once signed in.
    expect(newPackAction(remote('loverslab'), out)).toEqual({ kind: 'sign-in', site: 'loverslab' });
    expect(newPackAction(remote('patreon'), out)).toEqual({ kind: 'sign-in', site: 'patreon' });
    expect(newPackAction(remote('loverslab'), snapshot({ loverslab: true }))).toEqual({ kind: 'get' });
    // Signed out, every patrons-only post reads as locked: signing in is what may unlock it.
    expect(newPackAction(remote('patreon', { locked: true, lockedSignedOut: true }), out)).toEqual({ kind: 'sign-in', site: 'patreon' });
    // Read again just after signing in: "Checking…", on the card and on the row.
    const rechecking = { ...snapshot({ patreon: true }), rechecking: ['https://patreon.test/page'] } as AppSnapshot;
    expect(newPackAction(remote('patreon', { locked: true, lockedSignedOut: true }), rechecking)).toEqual({ kind: 'checking' });
    expect(rowAction(creator('P', 'update-available', [remote('patreon', { locked: true, lockedSignedOut: true })]), rechecking)).toEqual({ kind: 'checking' });
    // Signed in, but the lock is still the signed-out one (its re-read never ran): nothing reads it
    // again unasked, so the button offers to.
    const stale = remote('patreon', { locked: true, lockedSignedOut: true });
    expect(newPackAction(stale, snapshot({ patreon: true }))).toEqual({ kind: 'recheck' });
    expect(rowAction(creator('Q', 'update-available', [stale]), snapshot({ patreon: true }))).toEqual({ kind: 'recheck' });
    // Signed in and still locked: not a patron. The page to open.
    expect(newPackAction(remote('patreon', { locked: true }), snapshot({ patreon: true }))).toEqual({ kind: 'open' });
    expect(newPackAction(remote('loverslab', { downloadUrl: undefined }), out)).toEqual({ kind: 'open' });
    expect(newPackAction(remote('loverslab', { status: 'error' }), out)).toEqual({ kind: 'open' });
  });

  it('say when, not two dates to compare', () => {
    const ago = (t: number): string => timeAgo(t, NOW);
    // "Update posted", not "New release": the page needing one is often an older pack you never
    // caught up with, and calling a 2024 release "new" would read as a bug.
    expect(rowSummary(creator('A', 'update-available', [remote('wickedcc')]), ago)).toBe('Update posted 3 days ago');
    const seen = creator('B', 'up-to-date', [remote('wickedcc')], { dismissedAt: NOW - 3 * DAY });
    expect(rowSummary(seen, ago)).toBe('Marked as seen');
    expect(rowSummary(creator('C', 'needs-verification', [remote('loverslab', { status: 'needs-verification' })]), ago)).toBe('LoversLab wants a human check');
  });

  it('sort by newest release, most out of date, or name', () => {
    const list = [
      creator('Bee', 'update-available', [remote('wickedcc', { updatedAt: NOW - 5 * DAY })], { localUpdatedAt: NOW - 400 * DAY }),
      creator('Ant', 'update-available', [remote('wickedcc', { updatedAt: NOW - 1 * DAY })], { localUpdatedAt: NOW - 20 * DAY }),
    ];
    expect(sortCreators(list, 'newest').map((c) => c.name)).toEqual(['Ant', 'Bee']);
    expect(sortCreators(list, 'outdated').map((c) => c.name)).toEqual(['Bee', 'Ant']);
    expect(sortCreators(list, 'name').map((c) => c.name)).toEqual(['Ant', 'Bee']);
  });

  it('say why an update is left out of Update all, and how to fix it', () => {
    const { eligible, ineligible } = updateCandidates(undefined, [creator('A', 'update-available', [remote('wickedcc')]), creator('B', 'update-available', [remote('loverslab')])], snapshot());
    expect(eligible.map((c) => c.name)).toEqual(['A']);
    expect(ineligible).toEqual([{ key: 'b', name: 'B', reason: 'Sign in to LoversLab', signIn: 'loverslab' }]);
  });
});

describe('page titles', () => {
  it('are plain text: styled letters back to ordinary ones, zero-width spaces gone, emoji kept', () => {
    expect(plainTitle('🍦\u200B𝑴𝒐𝒐𝒏𝒃𝒆𝒓𝒓𝒚\u200B🍦  Juniper   Petal ')).toBe('🍦Moonberry🍦 Juniper Petal');
    expect(plainTitle('𝐓𝐡𝐨𝐫𝐧𝐰𝐨𝐨𝐝 v2')).toBe('Thornwood v2');
    // Joined emoji stay one symbol: the joiner between them is kept.
    expect(plainTitle('👩\u200D💻 Juniper Petal')).toBe('👩\u200D💻 Juniper Petal');
  });
});

describe('removed pages', () => {
  it('are told apart by their address, or by site alone with page titles hidden', () => {
    expect(pageLabel('https://wicked.cc/animations/moonberry/juniper-petal', false)).toBe('wicked.cc · moonberry/juniper-petal');
    expect(pageLabel('https://www.loverslab.com/files/file/3528-moonberry-thornwood/', false)).toBe('LoversLab · moonberry-thornwood');
    expect(pageLabel('https://www.patreon.com/posts/velvet-set-12345', false)).toBe('Patreon · posts/velvet-set-12345');
    // The address names the pack as plainly as a title would.
    expect(pageLabel('https://wicked.cc/animations/moonberry/juniper-petal', true)).toBe('A wicked.cc page');
    expect(pageLabel('not an address', false)).toBe('A page');
  });
});

describe('game health', () => {
  const core: CoreResult = { status: 'up-to-date', latestVersion: '186a', supportedGameVersions: ['1.127.41', '1.126.78'] };

  it('is a quiet "ready" when the game is supported', () => {
    expect(gameHealth({ version: '1.127.41.1030', modsEnabled: true, scriptModsEnabled: true }, core, [])).toMatchObject({ tone: 'ok', title: 'Ready to play' });
  });

  it('shows your version next to the supported one after a patch, and never mixes them up', () => {
    const health = gameHealth({ version: '1.128.10.1020' }, core, []);
    expect(health).toMatchObject({ tone: 'warn', title: 'Careful! Unsupported update detected', yourGame: '1.128.10', supportedUpTo: '1.127.41' });
  });

  it('puts "won\'t load" first, and hidden warnings stay hidden until the version changes', () => {
    const health = gameHealth({ version: '1.128.10.1020', scriptModsEnabled: false }, core, []);
    expect(health.tone).toBe('error');
    expect(health.warnings.map((w) => w.id)).toEqual(['script-mods-off:1.128.10.1020', 'game-newer:1.128.10']);
    const hidden = gameHealth({ version: '1.128.10.1020', scriptModsEnabled: false }, core, health.warnings.map((w) => w.id));
    expect(hidden).toMatchObject({ tone: 'neutral', hidden: 2 });
  });
});

describe('history', () => {
  const record = (id: string, at: number, extra: Partial<InstallRecord> = {}): InstallRecord => ({
    id,
    creatorKey: id,
    name: id,
    at,
    backupDir: `/b/${id}`,
    operations: [{ kind: 'replace', target: 'x' }],
    ...extra,
  });

  it('groups one Update all run into one entry, newest first, with marks as seen', () => {
    const seen: SeenEvent = { id: 's', at: NOW - 1000, kind: 'all', entries: [{ key: 'a', name: 'A', dismissedAt: 1 }] };
    const items = historyItems(
      [record('old', NOW - 5 * DAY), record('b1', NOW - 2000, { batchId: 'run' }), record('b2', NOW - 1500, { batchId: 'run', operations: [{ kind: 'add', target: 'y' }] }), record('solo', NOW - 3 * DAY, { batchId: 'one' })],
      [seen],
    );
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['seen:s', 'batch:run', 'install:solo', 'install:old']);
    const batch = items[1]!;
    expect(batch.kind === 'batch' && fileCounts(batch.records)).toEqual({ replaced: 1, added: 1, removed: 0 });
    expect(items.filter((i) => matchesFilter(i, 'seen'))).toHaveLength(1);
    expect(isUndone(items[0]!)).toBe(false);
  });

  it('labels days the way people talk about them', () => {
    expect(dayLabel(NOW - 60_000, NOW)).toBe('Today');
    expect(dayLabel(NOW - DAY, NOW)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 8, 11, 9).getTime(), NOW)).toBe('Friday, Sep 11');
    expect(dayLabel(new Date(2026, 7, 2).getTime(), NOW)).toBe('August');
    expect(dayLabel(new Date(2025, 11, 2).getTime(), NOW)).toBe('December 2025');
  });
});

describe('wording and shortcuts', () => {
  it('spells out times and groups thousands', () => {
    expect(timeAgo(NOW - 20_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 3 * 3600_000, NOW)).toBe('3 hours ago');
    expect(timeAgo(NOW - 12 * 60_000, NOW)).toBe('12 minutes ago');
    expect(timeAgo(NOW - DAY, NOW)).toBe('yesterday');
    expect(timeAgo(NOW - 16 * DAY, NOW)).toBe('2 weeks ago');
    // Whole units only: a release 6 years and 7 months back is "6 years ago", never 7.
    expect(timeAgo(NOW - (6 * 365 + 207) * DAY, NOW)).toBe('6 years ago');
    expect(timeAgo(NOW - 350 * DAY, NOW)).toBe('11 months ago');
    expect(timeAgo(NOW - 1.9 * DAY, NOW)).toBe('yesterday');
    expect(formatCount(3812)).toBe('3,812');
    expect(t().common.files(1)).toBe('1 file');
    expect(t().otherFiles.matches(2)).toBe('2 matches');
  });

  it('shortens a long page name without cutting a character in half', () => {
    expect(shortTitle('Sorbet Set')).toBe('Sorbet Set');
    expect(shortTitle('  Marigold Dress ~UNDRESSABLE  ')).toBe('Marigold Dress ~UNDRESSABLE');
    // 33 characters and the ellipsis: the cap counts what's shown.
    expect(shortTitle('Verbena Lace Lingerie REMAKE ~UNDRESSABLE')).toBe('Verbena Lace Lingerie REMAKE ~UND…');
    // Emoji are whole characters, not two halves of one.
    expect(shortTitle('Eve V10.2 ✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦', 12)).toBe('Eve V10.2 ✦…');
  });

  it('turns key presses into shortcuts, and refuses ones that would block typing', () => {
    const key = (code: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>>) => ({
      key: '',
      code,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    });
    expect(acceleratorFromKey(key('KeyH', { ctrlKey: true, shiftKey: true }), 'win32')).toBe('CommandOrControl+Shift+H');
    expect(acceleratorFromKey(key('KeyH', { metaKey: true }), 'darwin')).toBe('CommandOrControl+H');
    expect(acceleratorFromKey(key('KeyH', { shiftKey: true }), 'win32')).toBeUndefined();
    expect(acceleratorFromKey(key('Space', { ctrlKey: true }), 'win32')).toBeUndefined();
    expect(acceleratorFromKey(key('F9', {}), 'linux')).toBe('F9');
    expect(acceleratorKeys('CommandOrControl+Shift+H', 'win32')).toEqual(['Ctrl', 'Shift', 'H']);
    expect(acceleratorKeys('CommandOrControl+Shift+H', 'darwin')).toEqual(['⌘', '⇧', 'H']);
  });
});

describe('Update all results', () => {
  it('carry the run id and each pack\'s file counts for the summary and Undo all', async () => {
    const final = await runBatch(
      [{ key: 'a', name: 'A' }],
      async () => ({ message: 'Installed', replaced: 2, added: 1 }),
      () => undefined,
      () => false,
      'run-1',
    );
    expect(final.batchId).toBe('run-1');
    expect(final.items[0]).toMatchObject({ state: 'done', replaced: 2, added: 1, message: 'Installed' });
  });
});
