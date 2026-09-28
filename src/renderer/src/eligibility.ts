import type { AppSnapshot, BrowserSite } from '../../shared/api';
import { t } from '../../shared/i18n';
import type { CoreResult, CreatorResult, RemoteInfo, SourceId } from '../../shared/types';
import { newPacks, ownedRemotes, updatableRemote, updatableRemotes, updateSources } from '../../shared/updatable';
import { SOURCE_LABEL } from './format';

export const CORE_KEY = '__wickedwhims__';

/**
 * Why installing is off while a check runs: an install then would be undone by the check's result,
 * built from the files as they were before it. A greyed-out button with no reason reads as broken.
 */
export const afterCheck = (): string => t().eligibility.afterCheck;

export interface Candidate {
  key: string;
  name: string;
  /** Where the update would come from, e.g. "wicked.cc". */
  source: string;
}

export interface Ineligible {
  key: string;
  name: string;
  reason: string;
  /** The site to sign in to, when that's the fix. */
  signIn?: BrowserSite;
}

type SignedIn = (site: BrowserSite) => boolean;

export const signedInCheck =
  (snapshot: AppSnapshot): SignedIn =>
  (site) =>
    snapshot.accounts.some((a) => a.site === site && a.signedIn);

/**
 * The page the row's Update button would download, chosen exactly as the main process chooses it —
 * otherwise the row offers an update the download then declines to produce.
 */
export function downloadableRemote(c: CreatorResult, snapshot: AppSnapshot): RemoteInfo | undefined {
  return updatableRemote(updateSources(c.remotes, c.localUpdatedAt, c.dismissedAt), signedInCheck(snapshot));
}

/** Pages for packs the user doesn't have, once they've asked to see them. */
export function newPacksFor(c: CreatorResult, snapshot: AppSnapshot): RemoteInfo[] {
  return snapshot.settings.showNewPacks ? newPacks(c.remotes) : [];
}

/** A file on one of their pages that they don't have: see RemoteInfo.newFiles. */
export interface NewFile {
  remote: RemoteInfo;
  name: string;
  updatedAt?: number;
}

/**
 * New files on pages that also hold a pack of theirs, leaving out the ones they said no to. Shown
 * with packs they don't have, and under the same setting: it's the same thing, one page along. An
 * archive only once the user has said it's a pack of its own (see maybeUpdatesFor).
 */
export function newFilesFor(c: CreatorResult, snapshot: AppSnapshot): NewFile[] {
  if (!snapshot.settings.showNewPacks) return [];
  const ignored = new Set(snapshot.ignoredFiles?.[c.key] ?? []);
  return c.remotes.flatMap((remote) =>
    (remote.newFiles ?? [])
      .filter((f) => !f.superseded && (!f.archive || f.kind === 'pack') && !ignored.has(f.name.toLowerCase()))
      .map((f) => ({ remote, ...f })),
  );
}

/**
 * Archives on pages that hold a pack of theirs, newer than their files, that the user hasn't said
 * are updates or packs of their own: only they can tell, from the name. Not under the new-packs
 * setting, since each may well be an update, and hiding one could hide an update.
 */
export function maybeUpdatesFor(c: CreatorResult, snapshot: AppSnapshot): NewFile[] {
  const ignored = new Set(snapshot.ignoredFiles?.[c.key] ?? []);
  return c.remotes.flatMap((remote) =>
    (remote.newFiles ?? []).filter((f) => f.archive && !f.kind && !f.superseded && !ignored.has(f.name.toLowerCase())).map((f) => ({ remote, ...f })),
  );
}

/**
 * Files the user said they weren't interested in that are still on one of the creator's pages, so
 * the choice can be taken back once its toast is gone. Names no longer on a page aren't listed:
 * there'd be nothing to bring back. Under the same setting as the files themselves.
 */
export function ignoredFilesFor(c: CreatorResult, snapshot: AppSnapshot): NewFile[] {
  if (!snapshot.settings.showNewPacks) return [];
  const ignored = new Set(snapshot.ignoredFiles?.[c.key] ?? []);
  const found = c.remotes.flatMap((remote) => (remote.newFiles ?? []).filter((f) => ignored.has(f.name.toLowerCase())).map((f) => ({ remote, ...f })));
  // One file on two pages is one file said no to, and one to bring back.
  return found.filter((f, i) => found.findIndex((g) => g.name.toLowerCase() === f.name.toLowerCase()) === i);
}

export type NewPackAction = { kind: 'get' } | { kind: 'sign-in'; site: BrowserSite } | { kind: 'checking' } | { kind: 'recheck' } | { kind: 'open' };

/**
 * Signed in to Patreon, but the page's lock is still the one seen while signed out (a sign-in whose
 * re-read didn't run, such as one cut short by quitting): whether they can get it isn't known yet.
 * Nothing reads it again unasked, so the button offers to (Check again).
 */
function staleLock(remote: RemoteInfo, signedIn: SignedIn): boolean {
  return remote.listing.source === 'patreon' && remote.status === 'ok' && remote.locked === true && remote.lockedSignedOut === true && signedIn('patreon');
}

/**
 * What a card for something new on a page offers, as the row does for an update: Get it when the
 * page can be downloaded from now; Sign in when that's all that's missing, so the card says so and
 * turns into Get it by itself once signed in; otherwise the page to open (a post for patrons they
 * aren't one of, or a page with no download link or that couldn't be read). Signed out of Patreon,
 * every patrons-only post reads as locked, so a lock says nothing until they sign in: Sign in. Just
 * after they have, the page is read again (recheckPatreonLocks), and says "Checking…" meanwhile.
 */
export function newPackAction(remote: RemoteInfo, snapshot: AppSnapshot): NewPackAction {
  const signedIn = signedInCheck(snapshot);
  if (updatableRemotes([remote], signedIn).length > 0) return { kind: 'get' };
  if (snapshot.rechecking?.includes(remote.listing.url)) return { kind: 'checking' };
  if (remote.status === 'ok' && remote.downloadUrl !== undefined) {
    if (remote.listing.source === 'loverslab' && !signedIn('loverslab')) return { kind: 'sign-in', site: 'loverslab' };
    if (remote.listing.source === 'patreon' && !signedIn('patreon')) return { kind: 'sign-in', site: 'patreon' };
  }
  if (staleLock(remote, signedIn)) return { kind: 'recheck' };
  return { kind: 'open' };
}

export interface DownloadOption {
  url: string;
  label: string;
  /** The page's own name, when the site gives one and page titles aren't hidden. */
  title?: string;
  updatedAt?: number;
  version?: string;
  fileCount?: number;
}

/**
 * Sources an update can be downloaded from right now, newest (the default)
 * first. With `only`, just that page: getting one new pack is about that pack,
 * and offering to swap it for another of the creator's would make no sense.
 */
export function downloadOptions(key: string, snapshot: AppSnapshot, only?: string): DownloadOption[] {
  const result = snapshot.lastResult;
  if (!result) return [];
  if (key === CORE_KEY) {
    const url = result.core.downloadPageUrl;
    return url?.includes('wicked.cc') ? [{ url, label: 'wicked.cc', updatedAt: result.core.releasedAt, version: result.core.latestVersion }] : [];
  }
  const creator = result.creators.find((c) => c.key === key);
  const pages = only ? (creator?.remotes ?? []).filter((r) => r.listing.url === only) : ownedRemotes(creator?.remotes ?? []);
  // The page the update is actually about goes first, because it is the one the download will come
  // from. Left in date order the switcher names the creator's newest pack until the plan lands, then
  // jumps to a different one — which reads as WhimWatch fetching the wrong thing.
  const behind = creator?.status === 'update-available' ? creator.remoteUpdatedAt : undefined;
  const ranked = updatableRemotes(pages, signedInCheck(snapshot));
  const ordered = behind === undefined ? ranked : [...ranked].sort((a, b) => Number(b.updatedAt === behind) - Number(a.updatedAt === behind));
  return (creator ? ordered : []).map((r) => ({
    url: r.listing.url,
    label: SOURCE_LABEL[r.listing.source],
    // A creator can have a dozen pages on one site, where "wicked.cc" twelve times tells you nothing.
    title: snapshot.settings.hidePageTitles ? undefined : r.title,
    updatedAt: r.updatedAt,
    version: r.version,
    fileCount: r.fileCount,
  }));
}

export function coreUpdatable(core: CoreResult): boolean {
  return Boolean(core.installed && core.status === 'update-available' && core.downloadPageUrl?.includes('wicked.cc'));
}

/** Why an available update can't be downloaded right now, and the fix when there is one. */
function blocker(c: CreatorResult, signedIn: SignedIn): { reason: string; signIn?: BrowserSite; url?: string } {
  const ok = updateSources(c.remotes, c.localUpdatedAt, c.dismissedAt).filter((r) => r.status === 'ok');
  const newest = [...ok].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const m = t();
  if (ok.some((r) => r.listing.source === 'loverslab') && !signedIn('loverslab')) return { reason: m.common.signInTo('LoversLab'), signIn: 'loverslab' };
  if (ok.some((r) => r.listing.source === 'patreon') && !signedIn('patreon')) return { reason: m.common.signInTo('Patreon'), signIn: 'patreon' };
  if (ok.some((r) => r.listing.source === 'patreon' && r.locked)) return { reason: m.eligibility.patronsOnly, url: newest?.listing.url };
  return { reason: m.eligibility.noDownloadLink, url: newest?.listing.url };
}

/** Splits available updates into ones "Update all" can install now and ones it can't (with why). */
export function updateCandidates(core: CoreResult | undefined, creators: CreatorResult[], snapshot: AppSnapshot) {
  const eligible: Candidate[] = [];
  const ineligible: Ineligible[] = [];
  if (core && coreUpdatable(core)) eligible.push({ key: CORE_KEY, name: 'WickedWhims', source: 'wicked.cc' });

  const signedIn = signedInCheck(snapshot);
  for (const c of creators) {
    if (c.status !== 'update-available') continue;
    const remote = updatableRemote(updateSources(c.remotes, c.localUpdatedAt, c.dismissedAt), signedIn);
    if (remote) {
      eligible.push({ key: c.key, name: c.name, source: SOURCE_LABEL[remote.listing.source] });
      continue;
    }
    const { reason, signIn } = blocker(c, signedIn);
    ineligible.push({ key: c.key, name: c.name, reason, signIn });
  }
  return { eligible, ineligible };
}

/** What a row shows: one status, never two markers for the same thing. */
export type RowStatus = 'update' | 'current' | 'verify' | 'missing' | 'failed' | 'off';


export function rowStatus(c: CreatorResult): RowStatus {
  switch (c.status) {
    case 'update-available':
      return 'update';
    case 'up-to-date':
      return 'current';
    case 'needs-verification':
      return 'verify';
    default:
      if (c.remotes.some((r) => r.status === 'error')) return 'failed';
      // Every page it has is on a site the user turned off, or every site is: nothing to fix.
      return c.allSitesOff || (c.mutedSources?.length && !c.remotes.length) ? 'off' : 'missing';
  }
}

/** The sites' names, for a message to list ("LoversLab and Patreon"). */
export function siteNames(sites: SourceId[]): string[] {
  return sites.map((s) => SOURCE_LABEL[s]);
}

export type RowAction =
  | { kind: 'update' }
  | { kind: 'sign-in'; site: BrowserSite }
  | { kind: 'open'; url: string }
  /** A Patreon page being read again after a sign-in (see newPackAction). */
  | { kind: 'checking' }
  /** A Patreon page whose lock was seen signed out, now signed in: read it again (see newPackAction). */
  | { kind: 'recheck' }
  | { kind: 'verify'; site: BrowserSite }
  | { kind: 'add-page' }
  | { kind: 'none' };

/** The one button a row offers. */
export function rowAction(c: CreatorResult, snapshot: AppSnapshot): RowAction {
  const status = rowStatus(c);
  if (status === 'update') {
    if (downloadableRemote(c, snapshot)) return { kind: 'update' };
    if (c.remotes.some((r) => snapshot.rechecking?.includes(r.listing.url))) return { kind: 'checking' };
    const signedIn = signedInCheck(snapshot);
    if (updateSources(c.remotes, c.localUpdatedAt, c.dismissedAt).some((r) => staleLock(r, signedIn))) return { kind: 'recheck' };
    const { signIn, url } = blocker(c, signedIn);
    if (signIn) return { kind: 'sign-in', site: signIn };
    return url ? { kind: 'open', url } : { kind: 'none' };
  }
  if (status === 'verify') {
    const site = c.remotes.find((r) => r.status === 'needs-verification')?.listing.source;
    return site === 'loverslab' || site === 'patreon' ? { kind: 'verify', site } : { kind: 'none' };
  }
  if (status === 'missing') return { kind: 'add-page' };
  return { kind: 'none' };
}

/** "New release 3 days ago", "Released 2 months ago"… (the middle column of a row). */
export function rowSummary(c: CreatorResult, timeAgo: (at: number) => string): string {
  const m = t().summary;
  switch (rowStatus(c)) {
    case 'update':
      // Not "New release": the page that needs updating is often an older pack of theirs you simply
      // never caught up with, and calling a 2024 release "new" reads as a bug.
      return c.remoteUpdatedAt !== undefined ? m.updatePosted(timeAgo(c.remoteUpdatedAt)) : m.updateAvailable;
    case 'current':
      if (c.dismissedAt !== undefined && c.remoteUpdatedAt !== undefined && c.remoteUpdatedAt > c.localUpdatedAt + 86_400_000) return m.markedAsSeen;
      return c.remoteUpdatedAt !== undefined ? m.released(timeAgo(c.remoteUpdatedAt)) : m.upToDate;
    case 'verify': {
      const site = c.remotes.find((r) => r.status === 'needs-verification')?.listing.source;
      return m.wantsHumanCheck(site && SOURCE_LABEL[site]);
    }
    case 'missing':
      return m.noDownloadPage;
    case 'failed': {
      const site = c.remotes.find((r) => r.status === 'error')?.listing.source;
      return m.couldntReach(site && SOURCE_LABEL[site]);
    }
    case 'off':
      return c.allSitesOff ? m.everySiteOff : m.sitesOff(siteNames(c.mutedSources ?? []));
  }
}

export type SortOrder = 'newest' | 'outdated' | 'name';

export function sortCreators(list: CreatorResult[], order: SortOrder): CreatorResult[] {
  const byName = (a: CreatorResult, b: CreatorResult): number => a.name.localeCompare(b.name);
  return [...list].sort((a, b) => {
    if (order === 'name') return byName(a, b);
    if (order === 'outdated') {
      // How far behind the furthest-behind pack is. The old creator-wide gap went negative for a
      // creator behind on an old pack but holding a newer file from a different one.
      const gap = (c: CreatorResult): number => c.behindBy ?? (c.remoteUpdatedAt ?? 0) - c.localUpdatedAt;
      return gap(b) - gap(a) || byName(a, b);
    }
    return (b.remoteUpdatedAt ?? 0) - (a.remoteUpdatedAt ?? 0) || byName(a, b);
  });
}
