import { formatShortDate } from './dates.js';
import { t } from './i18n/index.js';
import { SOURCE_LABEL } from './labels.js';
import type { RemoteInfo, SourceId } from './types.js';

/** Timezones and upload delays make same-day dates unreliable, so allow a day. */
export const TOLERANCE_MS = 24 * 60 * 60 * 1000;

export function isNewer(remote: number, local: number, seenAt?: number): boolean {
  if (seenAt !== undefined && seenAt >= remote) return false;
  return remote > local + TOLERANCE_MS;
}

/**
 * The creator's pages that are newer than the files that came from them — their pending updates.
 *
 * A page whose name matched files of yours is compared against those files (RemoteInfo.yoursAt), so
 * an update to one pack is no longer hidden by a newer file from a different one. A page that
 * matched nothing of yours is compared against your newest file from the creator, as before, and a
 * page marked as seen on its own (RemoteInfo.seenAt) is hidden without hiding the creator's others.
 */
export function outdatedRemotes(remotes: RemoteInfo[], localUpdatedAt: number, dismissedAt?: number): RemoteInfo[] {
  return ownedRemotes(remotes).filter((r) => {
    // Either mark hides the page, so a later "Mark all as seen" still clears one that carries an
    // older mark of its own. Taking the page's own date alone let a stale per-page mark shadow it.
    const seen = Math.max(r.seenAt ?? 0, dismissedAt ?? 0) || undefined;
    return r.status === 'ok' && r.updatedAt !== undefined && isNewer(r.updatedAt, r.yoursAt ?? localUpdatedAt, seen);
  });
}

/**
 * Where an update comes from when the user didn't name a page: the pages that are behind, or every
 * page of theirs when none is. Both the row's Update button and the download must agree on this —
 * offering an update the main process then declines to produce is worse than offering none.
 */
export function updateSources(remotes: RemoteInfo[], localUpdatedAt: number, dismissedAt?: number): RemoteInfo[] {
  const behind = outdatedRemotes(remotes, localUpdatedAt, dismissedAt);
  return behind.length ? behind : ownedRemotes(remotes);
}

/**
 * Pages that can carry an update: packs the user has, plus every page it
 * couldn't be told about. A pack they don't have is new content, not a newer
 * version of anything, so it never decides a status or gets downloaded by
 * "Update all" — only by asking for that pack by name.
 */
export function ownedRemotes(remotes: RemoteInfo[]): RemoteInfo[] {
  return remotes.filter((r) => r.owned !== 'no');
}

/** The creator's pages for packs the user doesn't have, newest first. */
export function newPacks(remotes: RemoteInfo[]): RemoteInfo[] {
  return remotes.filter((r) => r.owned === 'no' && r.status === 'ok').sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * The source an update would be downloaded from: the newest successful
 * listing that offers a download the user can access (wicked.cc always;
 * LoversLab/Patreon only when signed in).
 */
export function updatableRemote(remotes: RemoteInfo[], signedIn: (site: 'loverslab' | 'patreon') => boolean): RemoteInfo | undefined {
  return updatableRemotes(remotes, signedIn)[0];
}

/** Every source the update could be downloaded from right now, best first (see rankRemotes). */
export function updatableRemotes(remotes: RemoteInfo[], signedIn: (site: 'loverslab' | 'patreon') => boolean): RemoteInfo[] {
  return rankRemotes(remotes
    .filter(
      (r) =>
        r.status === 'ok' &&
        r.downloadUrl !== undefined &&
        (r.listing.source === 'wickedcc' ||
          (r.listing.source === 'loverslab' && signedIn('loverslab')) ||
          (r.listing.source === 'patreon' && signedIn('patreon') && !r.locked)),
    ));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (t?: number): number => (t === undefined ? -1 : Math.floor(t / DAY_MS));

/** Sources updated on the same calendar day (UTC) as `a`. */
export function sameDay(a: RemoteInfo, b: RemoteInfo): boolean {
  return day(a.updatedAt) === day(b.updatedAt);
}

/**
 * The page a creator's "there's something new" comes from: their newest checked page. With one page
 * per pack, this is usually the pack that's new, which may well be one the user doesn't have.
 */
export function newestPage(remotes: RemoteInfo[]): RemoteInfo | undefined {
  let newest: RemoteInfo | undefined;
  for (const r of ownedRemotes(remotes)) {
    if (r.status !== 'ok' || r.updatedAt === undefined) continue;
    if (!newest || r.updatedAt > (newest.updatedAt ?? 0)) newest = r;
  }
  return newest;
}

/**
 * Sites updated more than a day after the listing at `listingUrl`, newest first, one entry per site.
 * When that listing's download matches the installed files, these are why the creator still shows
 * an update.
 */
export function laterSources(remotes: RemoteInfo[], listingUrl: string): RemoteInfo[] {
  const checked = remotes.find((r) => r.listing.url === listingUrl)?.updatedAt;
  if (checked === undefined) return [];
  const newest = new Map<SourceId, RemoteInfo & { updatedAt: number }>();
  for (const r of ownedRemotes(remotes)) {
    if (r.status !== 'ok' || r.updatedAt === undefined || r.updatedAt <= checked + DAY_MS) continue;
    const kept = newest.get(r.listing.source);
    if (!kept || r.updatedAt > kept.updatedAt) newest.set(r.listing.source, { ...r, updatedAt: r.updatedAt });
  }
  return [...newest.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * "Patreon was updated later, on Sep 14, 2026" or "Patreon (Sep 14, 2026) and wicked.cc (Sep 2, 2026)
 * were updated later". With `checkedSource`, a page of that same site reads as "another wicked.cc page":
 * creators with several pages on one site are common, and "wicked.cc was updated later" under
 * "Nothing new on wicked.cc" says nothing useful.
 */
export function laterSourcesText(later: RemoteInfo[], checkedSource?: SourceId): string {
  const m = t().updater;
  const name = (r: RemoteInfo): string => (r.listing.source === checkedSource ? m.anotherPage(SOURCE_LABEL[r.listing.source]) : SOURCE_LABEL[r.listing.source]);
  const [only] = later;
  if (!only) return '';
  if (later.length === 1) return m.laterOne(name(only), formatShortDate(only.updatedAt));
  return m.laterMany(later.map((r) => m.laterWithDate(name(r), formatShortDate(r.updatedAt))));
}

/**
 * Orders downloadable sources: most recent day first, then most files
 * (`fileCounts` by listing URL, else RemoteInfo.fileCount), then exact time.
 * Unknown counts rank below known ones.
 */
export function rankRemotes(remotes: RemoteInfo[], fileCounts?: Map<string, number>): RemoteInfo[] {
  const count = (r: RemoteInfo): number => fileCounts?.get(r.listing.url) ?? r.fileCount ?? 0;
  return [...remotes].sort(
    (a, b) => day(b.updatedAt) - day(a.updatedAt) || count(b) - count(a) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
}
