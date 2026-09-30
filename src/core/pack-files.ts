import { basename } from 'node:path';
import type { FileAnswer, LocalFile, NewFileInfo, RemoteInfo } from '../shared/types.js';
import { TOLERANCE_MS } from '../shared/updatable.js';
import { ARCHIVE_FILE } from './archive.js';
import type { ChooserFile } from './sources/loverslab.js';

/**
 * Dates a LoversLab page by its files instead of by the page.
 *
 * LoversLab moves an entry's date for any edit, and for a new file put on it: a creator adding a
 * Simlish edition of their pack to the same entry made every user of the pack look behind, and
 * installing "the update" added a pack they never asked for. The entry's file list dates each file
 * on its own, so the page is dated by the newest of the files the user has (matched by exact name,
 * as the installer matches them) and the files they don't have are kept aside as newFiles.
 *
 * Only files posted more than a day after theirs count as new: a variant uploaded with their pack (a
 * no-sound edition, say) is one they chose not to install, not news. A newer file that is one of
 * theirs under a new version number (Pack_v2 beside their Pack_v1) is their update, not a new pack,
 * so it dates the page: calling it new would hide a real update, which is worse than a false alarm.
 * With no file of theirs on the list by name (an entry offering a zip) nothing can be told, and the
 * page keeps its own date as before.
 *
 * A newer archive on the list is marked as one (NewFileInfo.archive) rather than taken for a new
 * pack: it is often the page's main download, the user's own pack re-zipped under a new date, and
 * nothing short of downloading it tells which. The user says (applyFileKinds). An archive they got
 * and installed (`got`, lower-case names) is theirs, as a file of theirs on the list is.
 */
export function datePageByFiles(
  remote: RemoteInfo,
  listed: ChooserFile[],
  yours: readonly LocalFile[],
  got: GotFiles = {},
  uploadedAt: UploadDates = {},
): RemoteInfo {
  const mine = new Set([...yours.map((f) => basename(f.path).toLowerCase()), ...Object.keys(got)]);
  const dated = listed.filter((f): f is ChooserFile & { updatedAt: number } => Boolean(f.name) && f.updatedAt !== undefined);
  const matched = dated.filter((f) => mine.has(f.name.toLowerCase()));
  if (!matched.length) return remote;
  const theirsAt = Math.max(...matched.map((f) => f.updatedAt));
  // Their copy of each of their files here, as of its upload where a list said (`uploadedAt`, for a
  // file WhimWatch installed from one, while it's still that copy), otherwise as of its date in their
  // folders. An archive they installed has no file of that name in their folders: its upload stands
  // in, so an upload of the same name since then is compared with that and not with itself.
  const copyAt = new Map<string, number>();
  const note = (name: string, at: number): void => void copyAt.set(name, Math.max(copyAt.get(name) ?? 0, at));
  for (const f of yours) {
    const name = basename(f.path).toLowerCase();
    note(name, uploadedFor(f, uploadedAt[name]) ?? f.mtimeMs);
  }
  for (const [name, at] of Object.entries(got)) note(name, at);
  // Their files the list has a newer upload of: an update pending, dated theirsAt.
  const current = matched.filter((f) => f.updatedAt <= (copyAt.get(f.name.toLowerCase()) ?? 0) + TOLERANCE_MS);
  const pending = current.length < matched.length;
  // Their files on this page, not all of theirs: a numbered file from another page of the creator's
  // shouldn't make a new pack here read as its update. A name of only digits has no stem to match.
  const stems = new Set(matched.map((f) => versionless(f.name)).filter(Boolean));
  // Posted after their files, and not with an update of theirs: new. With an update pending, files
  // posted within a day of it are its companions and come with it; files posted between their files
  // and it were new before it was posted and still are. Their current files' upload dates bound that
  // best. With none current (the file of theirs here is the one re-uploaded), their copies' dates do:
  // the upload the list gave an archive they got, or when a file in their folders was installed,
  // which can let files posted between an upload and its install through.
  const since = current.length
    ? Math.max(...current.map((f) => f.updatedAt))
    : Math.max(...matched.map((f) => copyAt.get(f.name.toLowerCase()) ?? 0));
  const isNew = (at: number): boolean =>
    at > theirsAt + TOLERANCE_MS || (pending && since > 0 && at > since + TOLERANCE_MS && at < theirsAt - TOLERANCE_MS);
  const later = dated.filter((f) => !mine.has(f.name.toLowerCase()) && isNew(f.updatedAt));
  const renamed = later.filter((f) => stems.has(versionless(f.name)));
  const updatedAt = Math.max(theirsAt, ...renamed.map((f) => f.updatedAt));
  const fresh = later.filter((f) => !renamed.includes(f));
  const newest = newestVersions(fresh);
  const newFiles = fresh.map(
    ({ name, updatedAt: at }): NewFileInfo => ({
      name,
      updatedAt: at,
      ...(ARCHIVE_FILE.test(name) && { archive: true as const }),
      ...(!newest.some((f) => f.name === name) && { superseded: true as const }),
    }),
  );
  // Their pack here is current (its newest file on the list is no newer than their newest copy), so
  // the files of that upload and before that they don't have are ones they left out. With an update
  // pending the list is the new upload, where a file they lack may be a companion the update needs:
  // say nothing. Whole pack, not file by file: a copy installed by hand often carries the creator's
  // older build date, and one such copy would stop a left-out no-sound edition being remembered.
  const packCurrent = theirsAt <= Math.max(...matched.map((f) => copyAt.get(f.name.toLowerCase()) ?? 0)) + TOLERANCE_MS;
  // An older version of their own file left on the page (…_v0 beside their …_v1) is not a variant
  // they skipped: remembered as one, it would start their next update (…_v2) unticked.
  const ownVersions = new Set(matched.map((f) => withoutVersion(f.name)));
  const variants = packCurrent
    ? dated.filter((f) => MOD_FILE.test(f.name) && !mine.has(f.name.toLowerCase()) && !later.includes(f) && !ownVersions.has(withoutVersion(f.name))).map((f) => f.name)
    : [];
  const { newFiles: _old, variants: _was, filesAt: _before, ...page } = remote;
  return {
    ...page,
    updatedAt,
    ...(newFiles.length && { newFiles }),
    ...(newFiles.some((f) => f.archive) && { filesAt: updatedAt }),
    ...(variants.length && { variants }),
  };
}

/**
 * The newest of each file's versions: V6 and V7 of a file are one thing the user doesn't have, not
 * two. Archives go by versionless, since theirs are told apart by dates in the name.
 */
function newestVersions<T extends { name: string; updatedAt: number }>(files: T[]): T[] {
  const key = (f: T): string => (ARCHIVE_FILE.test(f.name) ? versionless(f.name) || f.name.toLowerCase() : withoutVersion(f.name));
  const newest = new Map<string, T>();
  for (const f of files) {
    const kept = newest.get(key(f));
    if (!kept || f.updatedAt > kept.updatedAt) newest.set(key(f), f);
  }
  return files.filter((f) => newest.get(key(f)) === f);
}

/**
 * Applies what the user said the archives on a page are (see datePageByFiles), in place of a check:
 * one called an update dates the page, so it shows as Update ready; one called a pack is offered as
 * a new pack; one not yet asked about is neither. An archive whose versionless name matches one they
 * installed before is that pack's later upload, and so an update unless they said otherwise.
 * Re-applying is harmless, and a choice taken back restores the page's date by its files.
 */
export function applyFileKinds(remote: RemoteInfo, kinds: Readonly<Record<string, FileAnswer>> | undefined, got: GotFiles = {}): RemoteInfo {
  if (!remote.newFiles?.some((f) => f.archive)) return remote;
  const gotStems = new Set(Object.keys(got).map(versionless).filter(Boolean));
  const newFiles = remote.newFiles
    .filter((f) => got[f.name.toLowerCase()] === undefined)
    .map((f): NewFileInfo => {
      if (!f.archive) return f;
      const stem = versionless(f.name);
      const kind = kinds?.[stem]?.kind ?? (gotStems.has(stem) ? 'update' : undefined);
      const { kind: _was, ...file } = f;
      return kind ? { ...file, kind } : file;
    });
  const base = remote.filesAt ?? remote.updatedAt;
  const updates = newFiles.filter((f) => f.kind === 'update' && f.updatedAt !== undefined).map((f) => f.updatedAt!);
  const updatedAt = base === undefined ? undefined : Math.max(base, ...updates);
  const { newFiles: _old, ...page } = remote;
  return { ...page, ...(updatedAt !== undefined && { updatedAt }), ...(newFiles.length && { newFiles }) };
}

/**
 * Upload dates of mod files WhimWatch installed from a page's list, with when it installed each: see
 * CreatorLinkPrefs.uploadedAt.
 */
export type UploadDates = Readonly<Record<string, { upload: number; installed: number }>>;

/**
 * The upload date of the copy they have, while it's the one WhimWatch installed: the installer dates
 * the file with the install, so a copy put there by hand since carries another date, and its own
 * date is then all there is. Two seconds' leeway, for folders that store dates to the second or two.
 */
function uploadedFor(f: LocalFile, known: UploadDates[string] | undefined): number | undefined {
  return known && Math.abs(f.mtimeMs - known.installed) < 2000 ? known.upload : undefined;
}

/** Archives the user installed from their pages: lower-case name → when. See CreatorLinkPrefs.gotFiles. */
export type GotFiles = Readonly<Record<string, number>>;

/** The key a choice about an archive is kept under: see CreatorLinkPrefs.fileKinds. */
export function fileKindKey(name: string): string {
  return versionless(name) || name.toLowerCase();
}

/**
 * A file name without its extension, version and separators: "WW_Moonberry_v1.2.package" and
 * "WW_Moonberry_V2.package" come to the same thing. Numbers go too, so two numbered packs of one
 * name read as one pack's versions: a false "update" rather than a hidden one.
 */
export function versionless(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/\d+/g, '')
    .replace(/(^|[^a-z])v(?=[^a-z]|$)/g, '$1')
    .replace(/[^a-z]+/g, '');
}

/**
 * Takes the new files the user now has (installed with Get it) off the page, without waiting for a
 * check. An archive is never in their folders by name, so those they got are named in `got`.
 */
export function dropInstalledFiles(remote: RemoteInfo, files: readonly LocalFile[], got: readonly string[] = []): RemoteInfo {
  if (!remote.newFiles) return remote;
  const have = new Set([...files.map((f) => basename(f.path).toLowerCase()), ...got]);
  const newFiles = remote.newFiles.filter((f) => !have.has(f.name.toLowerCase()));
  if (newFiles.length === remote.newFiles.length) return remote;
  const { newFiles: _old, ...page } = remote;
  return newFiles.length ? { ...page, newFiles } : page;
}

/**
 * The files an update from this page leaves out, by name: its new packs and the ones the user said
 * no to, which are offered on their own (Get it) rather than slipped in with an update. A file they
 * said no to and then installed anyway is theirs now, so its own updates aren't held back. Given for
 * any LoversLab page, not only one the last check saw a list on: results saved by an older version,
 * or a page whose markup changed, still lead to a list once the download is followed, and it is
 * there, wherever it is met, that these are left out. On a page with one file they change nothing.
 * Archives they already got aren't left out by name: see currentByDate, which goes by their dates.
 */
export function updateExclusions(remote: RemoteInfo, ignored: readonly string[], installed: readonly LocalFile[]): string[] {
  if (remote.listing.source !== 'loverslab') return [];
  const have = new Set(installed.map((f) => basename(f.path).toLowerCase()));
  // An archive the user called an update is the update, and comes with it; its older uploads don't,
  // since the installer keeps whichever copy of a file is unpacked first.
  const kept = (remote.newFiles ?? []).filter((f) => f.kind !== 'update' || f.superseded);
  return [...kept.map((f) => f.name), ...ignored.filter((name) => !have.has(name.toLowerCase()))];
}

/** Only mod files are remembered as skipped: a zip, a preview or a readme is never installed anyway. */
const MOD_FILE = /\.(?:package|ts4script)$/i;

/**
 * A file name with its version marker taken out, for telling whether two names are one file's
 * versions: "_v2", "v1.2", or a dotted number at the end ("-2.0"). Nothing else is dropped, so
 * Pose_01 and Pose_02 stay two files, and the extension stays, so a script never passes for a
 * package. Stricter than versionless, which only dates pages: here a wrong match leaves a file an
 * update needs unticked, and Update all would leave it out.
 */
export function withoutVersion(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s_.-])v\d+(?:\.\d+)*(?=[\s_.-]|\.[a-z0-9]+$)/g, '$1')
    .replace(/[\s_-]\d+(?:\.\d+)+(?=\.[a-z0-9]+$)/, '')
    .replace(/[\s_.-]+(?=\.[a-z0-9]+$)/, '')
    // A marker taken from the middle leaves two separators ("pack__nosound"): make it one.
    .replace(/([\s_-])[\s_-]+/g, '$1');
}

/** How creators tell editions of one file apart: the public release, the patrons' early access… */
const EDITION = '(?:public|patreon|patron|free|ea|early[ _-]?access|exclusive|vip)';
const BRACKETED_EDITION = new RegExp(`\\s*[([]${EDITION}[)\\]]`, 'g');
const TRAILING_EDITION = new RegExp(`[\\s_.-]+${EDITION}(?=\\.[a-z0-9]+$)`);

/**
 * withoutVersion, with the edition taken out too: "X (Public).package" and "X_PATREON.package" are
 * one file's editions. A bare edition word only counts at the end of the name, so a pack called
 * "Free_Roam" keeps its name; in brackets it counts anywhere.
 */
export function withoutEdition(name: string): string {
  return withoutVersion(name)
    .replace(BRACKETED_EDITION, '')
    .replace(TRAILING_EDITION, '')
    .replace(/[\s_.-]+(?=\.[a-z0-9]+$)/, '')
    .replace(/([\s_-])[\s_-]+/g, '$1');
}

/**
 * Whether two differently named files are one file's versions or editions (Pack_v1 and Pack_v2, or
 * Pack_PATREON and Pack (Public)), so that installing one replaces the other rather than landing
 * beside it and loading twice. As strict as withoutVersion otherwise: a script and a package with
 * the same name are never one file.
 */
export function sameFile(a: string, b: string): boolean {
  return a.toLowerCase() !== b.toLowerCase() && withoutEdition(a) === withoutEdition(b);
}

/**
 * Whether a file is one the user left out before: the same name, or the same name with another
 * version marker (a variant re-uploaded as _v2). See withoutVersion for why it is strict.
 */
export function wasSkipped(name: string, skipped: readonly string[]): boolean {
  if (!MOD_FILE.test(name)) return false;
  const lower = name.toLowerCase();
  const bare = withoutVersion(name);
  return skipped.some((s) => s === lower || withoutVersion(s) === bare);
}

/**
 * The skipped list after the user acted: `left` (unticked, or seen as variants) is added, and
 * `installed` taken off, matching as wasSkipped does, since a file they now have isn't skipped any
 * more. Kept short; undefined when empty.
 */
export function updateSkipped(skipped: readonly string[] | undefined, left: readonly string[], installed: readonly string[]): string[] | undefined {
  const kept = (skipped ?? []).filter((s) => !installed.some((name) => wasSkipped(name, [s])));
  const added = left
    .filter((n) => MOD_FILE.test(n))
    .map((n) => n.toLowerCase())
    .filter((n) => !kept.includes(n) && !installed.some((i) => i.toLowerCase() === n));
  const next = [...kept, ...added].slice(-200);
  return next.length ? next : undefined;
}

/**
 * The added files (targets) an update starts unticked: ones the user left out before. Never a
 * version of a file they have, whatever the skipped list says: that is their update under a new
 * name (…_v2 beside their …_v1), and leaving it unticked would leave the update itself out, with
 * the page still saying "Update ready" after every Update all.
 */
export function startUnticked(files: readonly { target: string; kind: string }[], skipped: readonly string[], installed: readonly LocalFile[]): string[] {
  if (!skipped.length) return [];
  const theirs = new Set(installed.map((f) => withoutVersion(basename(f.path))));
  return files.filter((f) => f.kind === 'add' && wasSkipped(basename(f.target), skipped) && !theirs.has(withoutVersion(basename(f.target)))).map((f) => f.target);
}

/**
 * The files an update would put in that the user doesn't have, didn't leave out before, and so
 * hasn't seen: Update all asks about these rather than installing them unseen, since a pack's
 * update can bring anything with it (a custom erotic jumpscare loading screen, let's say).
 */
export function newFiles<T extends { target: string; kind: string; unchanged?: boolean }>(plan: { files: readonly T[]; startUnticked?: readonly string[] }): T[] {
  return plan.files.filter((f) => f.kind === 'add' && !f.unchanged && !plan.startUnticked?.includes(f.target));
}

/**
 * The files on a page's list the user already has, going by dates alone, so an update needn't
 * download them to find that out: listed under the name of a file of theirs, and posted no later
 * than their copy. No day's leeway, unlike page dates: a copy installed by hand usually carries the
 * creator's older build date, so it is simply downloaded and compared, as before. A file with no
 * date, or no copy of theirs, never counts. Lower-case names.
 *
 * An archive they installed (`got`) is theirs as of when they installed it: its upload from then or
 * before isn't downloaded again, and a newer upload under the same name is.
 */
export function currentByDate(listed: readonly ChooserFile[], own: readonly LocalFile[], elsewhere: readonly LocalFile[] = [], got: GotFiles = {}): string[] {
  const copies = new Map<string, number>();
  const note = (f: LocalFile): void => {
    const name = basename(f.path).toLowerCase();
    copies.set(name, Math.max(copies.get(name) ?? 0, f.mtimeMs));
  };
  own.forEach(note);
  // This creator's own copy decides. Others' files only count for a name this creator lacks (a file
  // sorted under another author), so a generic name held elsewhere can't stand in for theirs.
  const theirs = new Set(copies.keys());
  elsewhere.filter((f) => !theirs.has(basename(f.path).toLowerCase())).forEach(note);
  for (const [name, at] of Object.entries(got)) copies.set(name, Math.max(copies.get(name) ?? 0, at));
  return listed
    .filter((f) => f.name && f.updatedAt !== undefined && f.updatedAt <= (copies.get(f.name.toLowerCase()) ?? -Infinity))
    .map((f) => f.name.toLowerCase());
}
