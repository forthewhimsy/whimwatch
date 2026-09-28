import { describe, expect, it } from 'vitest';
import {
  applyFileKinds,
  currentByDate,
  datePageByFiles,
  dropInstalledFiles,
  fileKindKey,
  startUnticked,
  updateExclusions,
  updateSkipped,
  versionless,
  wasSkipped,
  withoutVersion,
} from '../src/core/pack-files.js';
import { chooserDownloads, DownloadUnavailableError } from '../src/core/downloads.js';
import type { AppSnapshot } from '../src/shared/api.js';
import type { CreatorResult, LocalFile, RemoteInfo } from '../src/shared/types.js';
import { ignoredFilesFor, maybeUpdatesFor, newFilesFor } from '../src/renderer/src/eligibility.js';

const at = (iso: string): number => Date.parse(iso);
const page: RemoteInfo = {
  listing: { source: 'loverslab', url: 'https://www.loverslab.com/files/file/3528-moonberry-animations/', origin: 'directory' },
  status: 'ok',
  checkedAt: 0,
  // Moved by an edit: none of the files below is this new.
  updatedAt: at('2026-09-18T11:16:48Z'),
};
const local = (name: string): LocalFile => ({ path: `/mods/${name}`, root: '/mods', relPath: name, size: 1, mtimeMs: at('2026-09-14T05:36:12Z'), kind: 'ww-animation', authors: {} });
const listed = [
  { href: 'r=1', name: 'WW_Moonberry_Animations.package', updatedAt: at('2026-07-30T13:30:28Z') },
  { href: 'r=2', name: 'WW_Moonberry_Juniper_Petal.package', updatedAt: at('2026-09-11T11:55:39Z') },
  // Put up alongside their pack: a variant they chose not to install, not news.
  { href: 'r=3', name: 'WW_Moonberry_Animations_NoSound.package', updatedAt: at('2026-07-30T13:31:00Z') },
];

describe("dating a LoversLab page by its files", () => {
  it("uses their pack's own file date, and keeps newer files they don't have apart", () => {
    expect(datePageByFiles(page, listed, [local('ww_moonberry_animations.package')])).toEqual({
      ...page,
      updatedAt: at('2026-07-30T13:30:28Z'),
      newFiles: [{ name: 'WW_Moonberry_Juniper_Petal.package', updatedAt: at('2026-09-11T11:55:39Z') }],
      // Their pack is current, so the no-sound edition of that upload is one they left out.
      variants: ['WW_Moonberry_Animations_NoSound.package'],
    });
  });

  it('counts their own file under a new version number as their update, not a new pack', () => {
    const versions = [
      { href: 'r=1', name: 'WW_Moonberry_v1.package', updatedAt: at('2026-07-30T13:30:28Z') },
      { href: 'r=2', name: 'WW_Moonberry_V2.package', updatedAt: at('2026-09-11T11:55:39Z') },
    ];
    const dated = datePageByFiles(page, versions, [local('WW_Moonberry_v1.package')]);
    expect(dated).toEqual({ ...page, updatedAt: at('2026-09-11T11:55:39Z') });
    expect(versionless('WW_Moonberry_v1.2.package')).toBe(versionless('WW_Moonberry_V2.package'));
    // A different pack of theirs isn't a version of this one.
    expect(versionless('WW_Moonberry_Juniper_Petal.package')).not.toBe(versionless('WW_Moonberry_Animations.package'));
  });

  it('never takes a name with no letters, or a file from another page, for a version of theirs', () => {
    const numbered = [
      { href: 'r=1', name: 'WW_Moonberry_Animations.package', updatedAt: at('2026-07-30T13:30:28Z') },
      { href: 'r=2', name: '01.package', updatedAt: at('2026-09-11T11:55:39Z') },
      { href: 'r=3', name: 'Thornwood_2.package', updatedAt: at('2026-09-11T11:55:39Z') },
    ];
    // Their Thornwood_1 comes from another page of the creator's, so it says nothing about this one.
    const dated = datePageByFiles(page, numbered, [local('WW_Moonberry_Animations.package'), local('02.package'), local('Thornwood_1.package')]);
    expect(dated.updatedAt).toBe(at('2026-07-30T13:30:28Z'));
    expect(dated.newFiles?.map((f) => f.name)).toEqual(['01.package', 'Thornwood_2.package']);
  });

  it("leaves new and unwanted files out of an update, but not one they've installed since", () => {
    const listPage = { ...datePageByFiles(page, listed, [local('WW_Moonberry_Animations.package')]), chooserUrl: `${page.listing.url}?do=download` };
    const ignored = ['ww_moonberry_thornwood.package', 'ww_moonberry_velvet.package'];
    // Velvet was said no to, then installed from the page by hand: it's theirs now.
    expect(updateExclusions(listPage, ignored, [local('WW_Moonberry_Velvet.package')])).toEqual(['WW_Moonberry_Juniper_Petal.package', 'ww_moonberry_thornwood.package']);
    // Saved without a list (an older version, or markup that hid it): still given, for the download to
    // apply if the button leads to a list after all.
    expect(updateExclusions({ ...listPage, chooserUrl: undefined }, ignored, [])).toEqual(['WW_Moonberry_Juniper_Petal.package', ...ignored]);
    // Not a LoversLab page: nothing to pick from.
    expect(updateExclusions({ ...listPage, listing: { ...listPage.listing, source: 'wickedcc' } }, ignored, [])).toEqual([]);
  });

  it("changes nothing when no file on the list is theirs by name", () => {
    expect(datePageByFiles(page, listed, [local('Moonberry.zip')])).toBe(page);
    expect(datePageByFiles(page, [{ href: 'r=1', name: 'WW_Moonberry_Animations.package' }], [local('WW_Moonberry_Animations.package')])).toBe(page);
  });

  it('drops a new file once it is in their folders, whoever it is filed under', () => {
    const dated = datePageByFiles(page, listed, [local('WW_Moonberry_Animations.package')]);
    expect(dropInstalledFiles(dated, [local('WW_Moonberry_Juniper_Petal.package')]).newFiles).toBeUndefined();
    expect(dropInstalledFiles(dated, [local('Something_Else.package')])).toBe(dated);
  });

  it('offers new files with new packs, minus the ones they said no to', () => {
    const creator = { key: 'moonberry', remotes: [datePageByFiles(page, listed, [local('WW_Moonberry_Animations.package')])] } as CreatorResult;
    const snapshot = (showNewPacks: boolean, ignored: string[] = []): AppSnapshot => ({ settings: { showNewPacks }, ignoredFiles: { moonberry: ignored } }) as unknown as AppSnapshot;
    expect(newFilesFor(creator, snapshot(true)).map((f) => f.name)).toEqual(['WW_Moonberry_Juniper_Petal.package']);
    expect(newFilesFor(creator, snapshot(true, ['ww_moonberry_juniper_petal.package']))).toEqual([]);
    expect(newFilesFor(creator, snapshot(false))).toEqual([]);

    // Said no to, and still on the page: listed so it can be shown again. A name no longer on
    // any page has nothing to bring back.
    const said = snapshot(true, ['ww_moonberry_juniper_petal.package', 'ww_moonberry_thornwood.package']);
    expect(ignoredFilesFor(creator, said).map((f) => f.name)).toEqual(['WW_Moonberry_Juniper_Petal.package']);
    expect(ignoredFilesFor(creator, snapshot(true))).toEqual([]);
    expect(ignoredFilesFor(creator, snapshot(false, ['ww_moonberry_juniper_petal.package']))).toEqual([]);
    // The same file on two of their pages is one file to bring back.
    const twoPages = { key: 'moonberry', remotes: [creator.remotes[0]!, { ...creator.remotes[0]!, listing: { ...page.listing, url: `${page.listing.url}?second` } }] } as CreatorResult;
    expect(ignoredFilesFor(twoPages, said)).toHaveLength(1);
  });
});

describe('remembering files the user left out', () => {
  it("notes a pack's variants only while their pack is current, never with an update pending", () => {
    // Current: their copy (Sep 14) is newer than their file on the list (Jul 30).
    expect(datePageByFiles(page, listed, [local('WW_Moonberry_Animations.package')]).variants).toEqual(['WW_Moonberry_Animations_NoSound.package']);
    // Update pending: the list is the new upload, where a file they lack may be a companion it needs.
    const reuploaded = listed.map((f) => ({ ...f, updatedAt: at('2026-09-20T10:00:00Z') }));
    expect(datePageByFiles(page, reuploaded, [local('WW_Moonberry_Animations.package')]).variants).toBeUndefined();
  });

  it('knows a left-out file again by its name, or its name under another version marker', () => {
    const skipped = ['ww_moonberry_animations_nosound.package', 'ww_moonberry_thornwood_v1.2.package', 'ww_moonberry_velvet-1.5.package'];
    expect(wasSkipped('WW_Moonberry_Animations_NoSound.package', skipped)).toBe(true);
    expect(wasSkipped('WW_Moonberry_Animations_NoSound_v2.package', skipped)).toBe(true);
    expect(wasSkipped('WW_Moonberry_Thornwood_v2.package', skipped)).toBe(true);
    expect(wasSkipped('WW_Moonberry_Velvet-2.0.package', skipped)).toBe(true);
  });

  it("never takes a companion file for one they left out: a wrong match would leave it out of the update", () => {
    // Another kind of file, even under the same name.
    expect(wasSkipped('WW_Moonberry_Animations.ts4script', ['ww_moonberry_animations.zip'])).toBe(false);
    expect(wasSkipped('WW_Moonberry_Animations.ts4script', ['ww_moonberry_animations_v1.package'])).toBe(false);
    // Numbered parts are different files, not versions of one.
    expect(wasSkipped('WW_Moonberry_Pose_02.package', ['ww_moonberry_pose_01.package'])).toBe(false);
    expect(wasSkipped('02.package', ['01.package'])).toBe(false);
    // "v" inside a word is not a version marker.
    expect(withoutVersion('WW_Velvet.package')).toBe('ww_velvet.package');
    // A marker from the middle of a name leaves one separator, not two.
    expect(withoutVersion('WW_Moonberry_v2_NoSound.package')).toBe(withoutVersion('WW_Moonberry_NoSound.package'));
  });

  it("never takes an old version of their own file for one they skipped, so their update isn't left out", () => {
    // The page keeps the old version beside the one they have, which is current.
    const kept = [
      { href: 'r=1', name: 'WW_Moonberry_Animations_v0.package', updatedAt: at('2026-06-01T10:00:00Z') },
      { href: 'r=2', name: 'WW_Moonberry_Animations_v1.package', updatedAt: at('2026-07-30T13:30:28Z') },
      { href: 'r=3', name: 'WW_Moonberry_Animations_NoSound.package', updatedAt: at('2026-07-30T13:31:00Z') },
    ];
    const theirs = [local('WW_Moonberry_Animations_v1.package')];
    expect(datePageByFiles(page, kept, theirs).variants).toEqual(['WW_Moonberry_Animations_NoSound.package']);

    // Their update arrives as v2. Even with v0 already on a saved skipped list, v2 starts ticked;
    // the no-sound edition, whose name only shares their pack's start, still starts unticked.
    const files = [
      { target: '/mods/WW_Moonberry_Animations_v2.package', kind: 'add' },
      { target: '/mods/WW_Moonberry_Animations_NoSound.package', kind: 'add' },
    ];
    const skipped = ['ww_moonberry_animations_v0.package', 'ww_moonberry_animations_nosound.package'];
    expect(startUnticked(files, skipped, theirs)).toEqual(['/mods/WW_Moonberry_Animations_NoSound.package']);
    expect(startUnticked(files, [], theirs)).toEqual([]);
  });

  it('adds what was left out and forgets what has been installed since', () => {
    const after = updateSkipped(undefined, ['WW_Moonberry_Animations_NoSound.package', 'WW_Moonberry_Thornwood.package'], []);
    expect(after).toEqual(['ww_moonberry_animations_nosound.package', 'ww_moonberry_thornwood.package']);
    // They installed the no-sound edition's next version: it isn't left out any more.
    expect(updateSkipped(after, [], ['WW_Moonberry_Animations_NoSound_v2.package'])).toEqual(['ww_moonberry_thornwood.package']);
    expect(updateSkipped(['ww_moonberry_thornwood.package'], [], ['WW_Moonberry_Thornwood.package'])).toBeUndefined();
    // Installed in the same go as it was left out (two copies on the page): theirs, not skipped.
    expect(updateSkipped(undefined, ['WW_Moonberry_Velvet.package'], ['ww_moonberry_velvet.package'])).toBeUndefined();
  });

  it('only ever remembers mod files', () => {
    // An install left a zip and a preview unticked: neither is worth remembering.
    expect(updateSkipped(undefined, ['WW_Moonberry_Extras.zip', 'preview.jpg', 'WW_Moonberry_NoSound.package'], [])).toEqual(['ww_moonberry_nosound.package']);
    // Nor does a check note them as variants.
    const withZip = [...listed, { href: 'r=4', name: 'WW_Moonberry_Animations_All.zip', updatedAt: at('2026-07-30T13:30:28Z') }];
    expect(datePageByFiles(page, withZip, [local('WW_Moonberry_Animations.package')]).variants).toEqual(['WW_Moonberry_Animations_NoSound.package']);
  });
});

describe('telling from dates alone that an update has nothing new', () => {
  // Their copy of the pack is from Sep 14; the list says when each file was posted.
  const theirs = [local('WW_Moonberry_Animations.package')];

  it("counts a file of theirs posted no later than their copy as current, so it isn't downloaded", () => {
    const list = [
      { href: 'r=1', name: 'WW_Moonberry_Animations.package', updatedAt: at('2026-07-30T13:30:28Z') },
      { href: 'r=2', name: 'WW_Moonberry_Juniper_Petal.package', updatedAt: at('2026-07-30T13:30:28Z') },
      { href: 'r=3', name: 'WW_Moonberry_Thornwood.package' },
    ];
    // Juniper Petal isn't theirs, and Thornwood has no date: neither is known to be current.
    expect(currentByDate(list, theirs)).toEqual(['ww_moonberry_animations.package']);
  });

  it('never counts a file posted after their copy, even by an hour', () => {
    const list = [{ href: 'r=1', name: 'WW_Moonberry_Animations.package', updatedAt: at('2026-09-14T06:36:12Z') }];
    expect(currentByDate(list, theirs)).toEqual([]);
    // A copy installed by hand keeps the creator's older build date, so it is downloaded and compared.
    expect(currentByDate(list, [{ ...theirs[0]!, mtimeMs: at('2026-09-01T00:00:00Z') }])).toEqual([]);
  });

  it("lets this creator's own copy decide, and another creator's only for a name this one lacks", () => {
    const list = [{ href: 'r=1', name: 'English.package', updatedAt: at('2026-09-10T00:00:00Z') }];
    const another = [{ ...local('English.package'), mtimeMs: at('2026-09-20T00:00:00Z') }];
    // Only another creator has an English.package: that copy is all there is to go on.
    expect(currentByDate(list, theirs, another)).toEqual(['english.package']);
    // This creator has their own, older one: theirs decides, whatever another creator holds.
    const own = [...theirs, { ...local('English.package'), mtimeMs: at('2026-09-01T00:00:00Z') }];
    expect(currentByDate(list, own, another)).toEqual([]);
  });
});

/**
 * The shape of two reports: a page whose main download is a dated zip, and loose files of the
 * creator's beside it that the user has. Matching those dated the page, and the zip, their pack
 * re-uploaded, was offered as a pack they don't have.
 */
describe('an archive on a page with their pack', () => {
  const zipPage: RemoteInfo = { ...page, updatedAt: at('2026-09-23T15:36:45Z') };
  const list = [
    { href: 'r=1', name: '[Amberlily]Props.package', updatedAt: at('2026-03-27T19:19:27Z') },
    { href: 'r=2', name: 'Amberlily Animations 23-09-2026 (Public).zip', updatedAt: at('2026-09-23T15:36:45Z') },
    { href: 'r=3', name: 'ExtraGlow Replacement for Juniper V6.package', updatedAt: at('2025-05-02T20:12:08Z') },
    { href: 'r=4', name: 'ExtraGlow Replacement for Juniper V7.package', updatedAt: at('2026-06-28T16:20:28Z') },
  ];
  const theirs = [
    { ...local('[Amberlily]Props.package'), mtimeMs: at('2026-09-14T05:39:22Z') },
    { ...local('WW_Amberlily_Animations_PATREON.package'), mtimeMs: at('2025-09-11T02:34:25Z') },
  ];
  const snapshot = { settings: { showNewPacks: true }, ignoredFiles: {} } as unknown as AppSnapshot;
  const creator = (remote: RemoteInfo): CreatorResult => ({ key: 'amberlily', remotes: [remote] }) as CreatorResult;
  const answer = (name: string, kind: 'update' | 'pack') => ({ [fileKindKey(name)]: { kind, name } });

  it('asks about it: neither an update nor a new pack', () => {
    const dated = datePageByFiles(zipPage, list, theirs);
    expect(dated.updatedAt).toBe(at('2026-03-27T19:19:27Z'));
    expect(dated.filesAt).toBe(at('2026-03-27T19:19:27Z'));
    const zip = dated.newFiles?.find((f) => f.name.endsWith('.zip'));
    expect(zip).toEqual({ name: 'Amberlily Animations 23-09-2026 (Public).zip', updatedAt: at('2026-09-23T15:36:45Z'), archive: true });
    expect(maybeUpdatesFor(creator(dated), snapshot).map((f) => f.name)).toEqual([zip!.name]);
    expect(newFilesFor(creator(dated), snapshot).map((f) => f.name)).not.toContain(zip!.name);
    // Not asked about, so not part of an update from the page either.
    expect(updateExclusions(dated, [], theirs)).toContain(zip!.name);
  });

  it('offers only the newest version of a file, and leaves every version out of an update', () => {
    // Both newer than their files here, as on the page in the report.
    const older = [{ ...theirs[0]!, mtimeMs: at('2024-11-10T00:00:00Z') }];
    const oldList = [{ ...list[0]!, updatedAt: at('2024-11-10T00:00:00Z') }, ...list.slice(2)];
    const dated = datePageByFiles(zipPage, oldList, older);
    expect(newFilesFor(creator(dated), snapshot).map((f) => f.name)).toEqual(['ExtraGlow Replacement for Juniper V7.package']);
    expect(updateExclusions(dated, [], older)).toEqual(['ExtraGlow Replacement for Juniper V6.package', 'ExtraGlow Replacement for Juniper V7.package']);
  });

  it('dates the page by it once called an update, and comes with the update', () => {
    const dated = datePageByFiles(zipPage, list, theirs);
    const update = applyFileKinds(dated, answer('Amberlily Animations 23-09-2026 (Public).zip', 'update'));
    expect(update.updatedAt).toBe(at('2026-09-23T15:36:45Z'));
    expect(maybeUpdatesFor(creator(update), snapshot)).toEqual([]);
    expect(updateExclusions(update, [], theirs)).not.toContain('Amberlily Animations 23-09-2026 (Public).zip');
    // Taken back: the page's date by its files again, and the question again.
    const undone = applyFileKinds(update, {});
    expect(undone.updatedAt).toBe(at('2026-03-27T19:19:27Z'));
    expect(maybeUpdatesFor(creator(undone), snapshot)).toHaveLength(1);
  });

  it('offers it with new packs once called a pack of its own', () => {
    const pack = applyFileKinds(datePageByFiles(zipPage, list, theirs), answer('Amberlily Animations 23-09-2026 (Public).zip', 'pack'));
    expect(pack.updatedAt).toBe(at('2026-03-27T19:19:27Z'));
    expect(newFilesFor(creator(pack), snapshot).map((f) => f.name)).toContain('Amberlily Animations 23-09-2026 (Public).zip');
    expect(maybeUpdatesFor(creator(pack), snapshot)).toEqual([]);
  });

  it('takes the same pack re-uploaded under a new date the way the user said', () => {
    const later = [...list.slice(0, 1), { href: 'r=5', name: 'Amberlily Animations 01-12-2026 (Public).zip', updatedAt: at('2026-12-01T10:00:00Z') }];
    const kinds = answer('Amberlily Animations 23-09-2026 (Public).zip', 'update');
    expect(applyFileKinds(datePageByFiles(zipPage, later, theirs), kinds).updatedAt).toBe(at('2026-12-01T10:00:00Z'));
  });

  /**
   * What an update from the page downloads, worked out as the updater does: its list, less what
   * updateExclusions keeps back and what's current by date. Nothing left is "you're up to date".
   */
  const downloads = (remote: RemoteInfo, listed: typeof list, got: Record<string, number> = {}): string[] => {
    const current = currentByDate(listed, theirs, [], got);
    try {
      return chooserDownloads(listed, undefined, [...updateExclusions(remote, [], theirs), ...current]).map((href) => listed.find((f) => f.href === href)!.name);
    } catch (err) {
      if (err instanceof DownloadUnavailableError && current.length) return [];
      throw err;
    }
  };

  it("downloads only the newest upload of a zip called an update, not its older ones", () => {
    const two = [
      list[0]!,
      { href: 'r=6', name: 'Thornwood 10-09-2026.zip', updatedAt: at('2026-09-10T10:00:00Z') },
      { href: 'r=7', name: 'Thornwood 12-09-2026.zip', updatedAt: at('2026-09-12T10:00:00Z') },
    ];
    const dated = datePageByFiles(zipPage, two, theirs);
    const update = applyFileKinds(dated, answer('Thornwood 12-09-2026.zip', 'update'));
    // Props is theirs, and their copy is newer than its listing.
    expect(downloads(update, two)).toEqual(['Thornwood 12-09-2026.zip']);
  });

  it("doesn't download again a zip they got with Get it, but does its next upload", () => {
    const got = { 'thornwood 10-09-2026.zip': at('2026-09-10T12:00:00Z') };
    const later = [list[0]!, { href: 'r=6', name: 'Thornwood 10-09-2026.zip', updatedAt: at('2026-09-10T10:00:00Z') }, { href: 'r=8', name: 'Thornwood 01-12-2026.zip', updatedAt: at('2026-12-01T10:00:00Z') }];
    const dated = applyFileKinds(datePageByFiles({ ...zipPage, updatedAt: at('2026-12-01T10:00:00Z') }, later, theirs, got), {}, got);
    expect(downloads(dated, later, got)).toEqual(['Thornwood 01-12-2026.zip']);
    // An update of another pack of theirs on the page leaves it out as well.
    const one = list.slice(0, 1).concat(later[1]!);
    expect(downloads(datePageByFiles(zipPage, one, theirs, got), one, got)).toEqual([]);
  });

  it('downloads a zip they got when it is uploaded again under the same name', () => {
    const got = { 'thornwood.zip': at('2026-09-10T12:00:00Z') };
    const page = { ...zipPage, updatedAt: at('2026-12-01T10:00:00Z') };
    const reuploaded = [list[0]!, { href: 'r=9', name: 'Thornwood.zip', updatedAt: at('2026-12-01T10:00:00Z') }];
    // The page is dated by the new upload, which is newer than when they got it: an update.
    expect(datePageByFiles(page, reuploaded, theirs, got).updatedAt).toBe(at('2026-12-01T10:00:00Z'));
    expect(downloads(datePageByFiles(page, reuploaded, theirs, got), reuploaded, got)).toEqual(['Thornwood.zip']);
    // The upload they got is not downloaded again.
    const same = [list[0]!, { href: 'r=9', name: 'Thornwood.zip', updatedAt: at('2026-09-10T10:00:00Z') }];
    expect(downloads(datePageByFiles(zipPage, same, theirs, got), same, got)).toEqual([]);
  });

  it("leaves out of an update the new packs posted on its page since their last update, not its companions", () => {
    const got = { 'thornwood.zip': at('2026-09-10T12:00:00Z') };
    const page = { ...zipPage, updatedAt: at('2026-12-01T10:00:00Z') };
    const reuploaded = [
      list[0]!,
      // Older than their files here: a variant as before, not a new pack.
      list[2]!,
      // Posted months before the re-upload, after their files: a new pack, and still one.
      list[3]!,
      { href: 'r=9', name: 'Thornwood.zip', updatedAt: at('2026-12-01T10:00:00Z') },
      // Put up with the re-upload: a companion it may need.
      { href: 'r=10', name: 'Thornwood Sounds.package', updatedAt: at('2026-12-01T10:05:00Z') },
    ];
    const dated = datePageByFiles(page, reuploaded, theirs, got);
    expect(dated.newFiles?.map((f) => f.name)).toEqual(['ExtraGlow Replacement for Juniper V7.package']);
    expect(downloads(dated, reuploaded, got)).toEqual(['ExtraGlow Replacement for Juniper V6.package', 'Thornwood.zip', 'Thornwood Sounds.package']);
  });

  it('keeps new packs out of the update when the re-uploaded zip is the only file of theirs on the page', () => {
    // Got as of the upload the list gave it.
    const got = { 'thornwood.zip': at('2026-09-10T10:00:00Z') };
    const page = { ...zipPage, updatedAt: at('2026-12-01T10:00:00Z') };
    const only = [
      { href: 'r=9', name: 'Thornwood.zip', updatedAt: at('2026-12-01T10:00:00Z') },
      { href: 'r=4', name: 'ExtraGlow Replacement for Juniper V7.package', updatedAt: at('2026-10-01T10:00:00Z') },
    ];
    const dated = datePageByFiles(page, only, theirs, got);
    expect(dated.newFiles?.map((f) => f.name)).toEqual(['ExtraGlow Replacement for Juniper V7.package']);
    expect(downloads(dated, only, got)).toEqual(['Thornwood.zip']);
  });

  it('keeps new packs out of the update when a single file of theirs was re-uploaded', () => {
    // Installed Sep 12, so that's the date on their copy; the list only shows the new upload.
    const single = [{ ...local('Juniper.package'), mtimeMs: at('2026-09-12T10:00:00Z') }];
    const page = { ...zipPage, updatedAt: at('2026-12-01T10:00:00Z') };
    const only = [
      { href: 'r=11', name: 'Juniper.package', updatedAt: at('2026-12-01T10:00:00Z') },
      { href: 'r=4', name: 'ExtraGlow Replacement for Juniper V7.package', updatedAt: at('2026-10-01T10:00:00Z') },
    ];
    expect(datePageByFiles(page, only, single).newFiles?.map((f) => f.name)).toEqual(['ExtraGlow Replacement for Juniper V7.package']);
  });

  it('keeps a new pack out of a later update when WhimWatch installed their file after the pack was posted', () => {
    // Monday: their file is uploaded. Wednesday: a new pack. Saturday: the update installs their file,
    // so its copy is dated Saturday, and the list gave it Monday's upload date.
    const copy = [{ ...local('Moonberry.package'), mtimeMs: at('2026-09-19T20:00:00Z') }];
    const uploadedAt = { 'moonberry.package': { upload: at('2026-09-14T10:00:00Z'), installed: at('2026-09-19T20:00:00Z') } };
    const page = { ...zipPage, updatedAt: at('2026-10-19T10:00:00Z') };
    // A month later, their file is uploaded again under the same name.
    const reuploaded = [
      { href: 'r=12', name: 'Moonberry.package', updatedAt: at('2026-10-19T10:00:00Z') },
      { href: 'r=4', name: 'ExtraGlow Replacement for Juniper V7.package', updatedAt: at('2026-09-16T10:00:00Z') },
    ];
    const dated = datePageByFiles(page, reuploaded, copy, {}, uploadedAt);
    expect(dated.newFiles?.map((f) => f.name)).toEqual(['ExtraGlow Replacement for Juniper V7.package']);
    const wanted = chooserDownloads(reuploaded, undefined, [...updateExclusions(dated, [], copy), ...currentByDate(reuploaded, copy)]);
    expect(wanted).toEqual(['r=12']);
    // Without the upload date, Saturday's copy is all there is to go by, and the pack reads as a companion.
    expect(datePageByFiles(page, reuploaded, copy).newFiles).toBeUndefined();
    // Nor once they've put another copy there by hand: its own date is what there is, not the old upload's.
    const byHand = [{ ...copy[0]!, mtimeMs: at('2026-10-01T09:00:00Z') }];
    expect(datePageByFiles(page, reuploaded, byHand, {}, uploadedAt).newFiles).toBeUndefined();
  });

  it('still remembers a variant left out when one of their copies carries an older build date', () => {
    const handInstalled = [
      { ...local('WW_Amberlily_Animations.package'), mtimeMs: at('2026-01-15T00:00:00Z') },
      { ...local('WW_Amberlily_Props.package'), mtimeMs: at('2026-09-14T00:00:00Z') },
    ];
    const upload = [
      { href: 'r=1', name: 'WW_Amberlily_Animations.package', updatedAt: at('2026-03-27T10:00:00Z') },
      { href: 'r=2', name: 'WW_Amberlily_Props.package', updatedAt: at('2026-03-27T10:00:00Z') },
      { href: 'r=3', name: 'WW_Amberlily_Animations_NoSound.package', updatedAt: at('2026-03-27T10:05:00Z') },
    ];
    expect(datePageByFiles(zipPage, upload, handInstalled).variants).toEqual(['WW_Amberlily_Animations_NoSound.package']);
  });

  it('drops the card for an archive got with Get it, and counts its later uploads as updates', () => {
    const dated = datePageByFiles(zipPage, list, theirs);
    const got = { 'amberlily animations 23-09-2026 (public).zip': at('2026-09-24T09:00:00Z') };
    expect(dropInstalledFiles(dated, theirs, Object.keys(got)).newFiles?.map((f) => f.name)).not.toContain('Amberlily Animations 23-09-2026 (Public).zip');
    // Next time the list is read, it's theirs: it dates the page and is nothing new.
    const again = datePageByFiles(zipPage, list, theirs, got);
    expect(again.updatedAt).toBe(at('2026-09-23T15:36:45Z'));
    expect(again.newFiles?.some((f) => f.archive)).toBeFalsy();
    // Its next upload, the same pack under a new date, is their update.
    const next = [...list, { href: 'r=6', name: 'Amberlily Animations 01-12-2026 (Public).zip', updatedAt: at('2026-12-01T10:00:00Z') }];
    expect(datePageByFiles({ ...zipPage, updatedAt: at('2026-12-01T10:00:00Z') }, next, theirs, got).updatedAt).toBe(at('2026-12-01T10:00:00Z'));
  });
});
