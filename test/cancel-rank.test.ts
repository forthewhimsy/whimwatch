import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBatch } from '../src/core/batch.js';
import { runCheck } from '../src/core/check.js';
import { CancelledError, HostQueue } from '../src/core/fetcher.js';
import { SNIPPET_TUNING_TYPE } from '../src/core/scanner.js';
import type { RemoteInfo, SourceId } from '../src/shared/types.js';
import { laterSources, laterSourcesText, newestPage, rankRemotes, updatableRemotes } from '../src/shared/updatable.js';
import { buildDbpf, wwTuningXml } from './helpers/dbpf-builder.js';

const remote = (source: SourceId, updatedAt: string, extra: Partial<RemoteInfo> = {}): RemoteInfo => ({
  listing: { source, url: `https://${source}.example/${updatedAt}`, origin: 'directory' },
  checkedAt: 0,
  status: 'ok',
  updatedAt: Date.parse(updatedAt),
  downloadUrl: 'https://x',
  ...extra,
});

describe('source ranking', () => {
  it('prefers accessible, then newest day, then most files', () => {
    const wcc = remote('wickedcc', '2026-09-13T20:00:00Z', { fileCount: 1 });
    const ll = remote('loverslab', '2026-09-13T08:00:00Z');
    const patreon = remote('patreon', '2026-09-14T08:00:00Z', { locked: true });
    const signedIn = () => true;

    // Patreon is newest but locked; wicked.cc and LoversLab tie on the day, wicked.cc has a known count.
    expect(updatableRemotes([ll, wcc, patreon], signedIn)[0]).toBe(wcc);
    // Once LoversLab is known to offer three files, it wins the tie.
    expect(rankRemotes([wcc, ll], new Map([[ll.listing.url, 3]]))[0]).toBe(ll);
    // A newer day always wins over more files.
    const newer = remote('wickedcc', '2026-09-14T01:00:00Z', { fileCount: 1 });
    expect(rankRemotes([ll, newer], new Map([[ll.listing.url, 5]]))[0]).toBe(newer);
    // Not signed in: LoversLab isn't a candidate at all.
    expect(updatableRemotes([ll], () => false)).toEqual([]);
  });

  it('names the sources updated after one whose download matched the installed files', () => {
    const ll = remote('loverslab', '2026-03-19T12:00:00Z');
    const patreon = remote('patreon', '2026-09-14T12:00:00Z', { locked: true });
    const olderPatreon = remote('patreon', '2026-09-01T12:00:00Z');
    const sameDayWcc = remote('wickedcc', '2026-03-20T06:00:00Z');
    const failed = remote('wickedcc', '2026-09-10T12:00:00Z', { status: 'error' });

    const later = laterSources([ll, olderPatreon, patreon, sameDayWcc, failed], ll.listing.url);
    // One entry per site (the newest), nothing within a day of LoversLab, no failed checks.
    expect(later).toEqual([patreon]);
    expect(laterSourcesText(later)).toBe('Patreon was updated later, on Sep 14, 2026');

    const wcc = remote('wickedcc', '2026-09-02T12:00:00Z');
    expect(laterSourcesText(laterSources([ll, wcc, patreon], ll.listing.url))).toBe('Patreon (Sep 14, 2026) and wicked.cc (Sep 2, 2026) were updated later');
    expect(laterSources([ll, patreon], patreon.listing.url)).toEqual([]);
  });

  it('names the page an update comes from, skipping ones that failed to check', () => {
    const owned = remote('wickedcc', '2026-07-05T12:00:00Z', { title: 'Slipping Underwear' });
    const newest = remote('wickedcc', '2026-09-16T12:00:00Z', { title: 'Verbena Lace Lingerie' });
    const broken = remote('wickedcc', '2026-09-20T12:00:00Z', { status: 'error' });
    const undated = remote('patreon', '2026-09-18T12:00:00Z', { updatedAt: undefined });

    expect(newestPage([owned, newest, broken, undated])?.title).toBe('Verbena Lace Lingerie');
    expect(newestPage([])).toBeUndefined();
    expect(newestPage([broken, undated])).toBeUndefined();
  });

  it('calls a newer page of the same site another page of it, not the site itself', () => {
    // A creator with several wicked.cc pack pages: the one downloaded from, and a newer one.
    const owned = remote('wickedcc', '2026-07-05T12:00:00Z');
    const newerPack = remote('wickedcc', '2026-09-16T12:00:00Z');
    const patreon = remote('patreon', '2026-09-10T12:00:00Z');

    const later = laterSources([owned, newerPack, patreon], owned.listing.url);
    // "wicked.cc was updated later" under "Nothing new on this wicked.cc page" says nothing.
    expect(laterSourcesText(later, 'wickedcc')).toBe('another wicked.cc page (Sep 16, 2026) and Patreon (Sep 10, 2026) were updated later');
    // A different site is still named as itself.
    expect(laterSourcesText(laterSources([owned, patreon], owned.listing.url), 'wickedcc')).toBe('Patreon was updated later, on Sep 10, 2026');
    // Without the source that was checked, nothing changes for anyone else.
    expect(laterSourcesText(later)).toBe('wicked.cc (Sep 16, 2026) and Patreon (Sep 10, 2026) were updated later');
  });
});

describe('cancellation', () => {
  it('drops queued requests', async () => {
    const queue = new HostQueue(() => 0);
    let release!: () => void;
    const first = queue.run('https://a.test/1', () => new Promise<string>((r) => (release = () => r('done'))));
    const second = queue.run('https://a.test/2', async () => 'should not run');
    await new Promise((r) => setTimeout(r, 0)); // let the first request start
    queue.cancelPending();
    release();
    await expect(first).resolves.toBe('done');
    await expect(second).rejects.toBeInstanceOf(CancelledError);
    await expect(queue.run('https://a.test/3', async () => 'later')).resolves.toBe('later');
  });

  it('marks the cancelled batch item and the rest as cancelled', async () => {
    const final = await runBatch(
      [
        { key: 'a', name: 'A' },
        { key: 'b', name: 'B' },
      ],
      async () => {
        throw new CancelledError();
      },
      () => undefined,
      () => false,
    );
    expect(final.items.map((i) => i.state)).toEqual(['cancelled', 'cancelled']);
  });

  it('stops a check instead of recording cancelled requests as errors', async () => {
    const mods = await mkdtemp(join(tmpdir(), 'whimwatch-cancel-'));
    try {
      await writeFile(join(mods, 'WW_A.package'), buildDbpf([{ type: SNIPPET_TUNING_TYPE, data: wwTuningXml({ authors: ['Alpha'] }) }]));
      const abort = new AbortController();
      const fetcher = {
        get: async (url: string) => {
          abort.abort();
          void url;
          throw new CancelledError();
        },
        head: async () => ({ status: 200, url: '', body: '', headers: {} }),
      };
      await expect(runCheck({ dirs: [mods], fetcher, signal: abort.signal })).rejects.toBeInstanceOf(CancelledError);
    } finally {
      await rm(mods, { recursive: true, force: true });
    }
  });
});
