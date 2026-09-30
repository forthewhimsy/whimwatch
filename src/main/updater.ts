import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ARCHIVE_FILE, extractDownload, MOD_FILE } from '../core/archive.js';
import { dirSize, hasLiveBackup, removeDir } from '../core/backups.js';
import { runBatch, StopBatchError } from '../core/batch.js';
import { CORE_KEY } from '../core/check.js';
import { chooserDownloads, DownloadUnavailableError } from '../core/downloads.js';
import { CancelledError, throwIfCancelled } from '../core/fetcher.js';
import { applyInstall, markUnchanged, planInstall, undoInstall } from '../core/installer.js';
import { currentByDate, newFiles, startUnticked, updateExclusions } from '../core/pack-files.js';
import { isGameRunning } from '../core/process.js';
import { chooseRemote } from '../core/source-choice.js';
import type { AppSnapshot, BatchItem, BatchState, StorageInfo, UpdateChoice, UpdatePlan, UpdateStage } from '../shared/api.js';
import { numberFormat } from '../shared/i18n/format.js';
import { englishMessage, t, translatedError } from '../shared/i18n/index.js';
import { SOURCE_LABEL } from '../shared/labels.js';
import type { CheckResult, LocalFile, RemoteInfo } from '../shared/types.js';
import { laterSources, laterSourcesText, updatableRemotes, updateSources } from '../shared/updatable.js';
import { sessionsToClear, siteSession } from './browser.js';
import type { AppController } from './controller.js';
import { downloadForRemote, loversLabFileList, type Offer, offerFileCount, resolveOffer } from './downloads.js';
import { clearLog } from './log.js';
import { clearSiteBrowsingData } from './privacy.js';

interface UpdateTarget {
  name: string;
  files: LocalFile[];
  remotes: RemoteInfo[];
  /** Where an update downloads from unless a page is named: the pages that are behind. */
  updateFrom?: RemoteInfo[];
  /** WickedWhims itself always comes from its wicked.cc page. */
  fixedRemote?: RemoteInfo;
}

interface InstallMeta {
  batchId?: string;
  automatic?: boolean;
}

interface PlanOptions {
  /** Automatic installs: never use LoversLab/Patreon accounts. */
  publicOnly?: boolean;
  /** Download and compare even what the page's dates say the user has ("Download and compare anyway"). */
  ignoreDates?: boolean;
  /** Download only the file of this name from the page's list (a new file on a page of theirs). */
  onlyFile?: string;
}

export class Updater {
  /**
   * Prepared updates, with the upload dates the page's list gave its files (lower-case names), so an
   * archive installed from it is remembered as of its upload rather than of the install.
   */
  private plans = new Map<string, { plan: UpdatePlan; workDir: string; uploaded?: Record<string, number> }>();
  /** Preparation in progress; asking again for the same update reuses it. */
  private preparing = new Map<string, Promise<UpdatePlan>>();
  private busy = false;
  private batchRunning = false;
  private stopRequested = false;
  /** Cancel switches for updates being prepared, by creator key. */
  private aborts = new Map<string, AbortController>();
  /** Updates from the last Update all that add files, waiting for the user to choose them: creator key → plan id. */
  private held = new Map<string, string>();
  /** The last Update all run, kept so the updates waiting in its review can be finished. */
  private batch?: BatchState;
  /** Creators in that run left for later from its review, so installing one from its Update window can say so there. */
  private setAside = new Set<string>();

  constructor(
    private readonly controller: AppController,
    /** Downloads being prepared; emptied on every start. */
    readonly tempRoot: string,
  ) {}

  async plan(key: unknown, listingUrl?: unknown, opts: PlanOptions = {}): Promise<UpdatePlan> {
    if (typeof key !== 'string') throw new Error('Expected a creator key');
    const url = typeof listingUrl === 'string' ? listingUrl : undefined;
    const id = `${key}|${url ?? ''}|${opts.publicOnly ? 'public' : 'any'}|${opts.onlyFile ?? ''}|${opts.ignoreDates ? 'compare' : 'dates'}`;
    const pending = this.preparing.get(id);
    if (pending) return pending;
    const promise = this.exclusive(() => this.prepare(key, url, opts)).finally(() => this.preparing.delete(id));
    this.preparing.set(id, promise);
    return promise;
  }

  async apply(planId: unknown, choice: unknown, meta: InstallMeta = {}): Promise<AppSnapshot> {
    const entry = typeof planId === 'string' ? this.plans.get(planId) : undefined;
    if (!entry) throw translatedError((m) => m.updater.notReady);
    const c = (choice ?? {}) as Partial<Record<keyof UpdateChoice, unknown>>;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
    return this.exclusive(() => this.install(entry, { remove: strings(c.remove), skip: strings(c.skip) }, meta));
  }

  async undo(id: unknown): Promise<AppSnapshot> {
    const record = this.controller.currentState.installs.find((i) => i.id === id);
    if (!record) throw new Error('Unknown update');
    return this.exclusive(async () => this.controller.replaceInstall(await undoInstall(record)));
  }

  /** Undoes every install from one run, newest first; stops at the first that can't be undone. */
  async undoBatch(batchId: unknown): Promise<AppSnapshot> {
    if (typeof batchId !== 'string') throw new Error('Unknown update');
    const records = this.controller.currentState.installs.filter((i) => i.batchId === batchId && hasLiveBackup(i)).reverse();
    if (!records.length) throw translatedError((m) => m.updater.nothingToUndo);
    return this.exclusive(async () => {
      let snapshot: AppSnapshot | undefined;
      for (const record of records) snapshot = await this.controller.replaceInstall(await undoInstall(record));
      return snapshot!;
    });
  }

  /**
   * "Update all": plans and installs each creator in turn with the defaults
   * (every downloaded file, nothing removed). Keeps going when one fails.
   * An update that adds files the user doesn't have isn't installed unseen: it waits, downloaded,
   * for them to choose its files (finishReview), unless they said to add that creator's new files.
   */
  async updateAll(keys: unknown, opts: PlanOptions & { skipIfWarnings?: boolean; automatic?: boolean } = {}): Promise<BatchState | undefined> {
    if (this.batchRunning) throw translatedError((m) => m.updater.alreadyUpdating);
    const requested = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
    const items = requested.flatMap((key) => {
      const target = this.target(key);
      // Same source the plan will choose: "Update all" never reaches for a pack they don't have.
      const likely = target?.fixedRemote ?? (target && updatableRemotes(target.updateFrom ?? [], this.signedIn(opts))[0]);
      return target && likely ? [{ key, name: target.name, source: SOURCE_LABEL[likely.listing.source] }] : [];
    });
    if (!items.length) return undefined;

    this.batchRunning = true;
    this.stopRequested = false;
    const batchId = randomUUID();
    try {
      // A new run replaces the last one, and with it any updates still waiting in its review.
      for (const key of [...this.held.keys()]) await this.discardPlans(key);
      this.setAside.clear();
      return (this.batch = await runBatch(
        items,
        async (key) => {
          try {
            const plan = await this.plan(key, undefined, opts);
            const m = t().updater;
            if (plan.gameRunning) throw translatedError((m) => m.updater.closeGameFirst, StopBatchError);
            if (plan.byDate) {
              // Only the page's dates say so, with nothing downloaded or compared: not enough to mark it
              // seen on the user's behalf, or to record that the files matched. The Update window asks.
              await this.discardPlans(key);
              return m.batchByDate(SOURCE_LABEL[plan.source]);
            }
            if (plan.upToDate) {
              await this.discardPlans(key);
              await this.controller.markSeen(key, plan.downloadUrl, { automatic: true });
              const label = SOURCE_LABEL[plan.source];
              if (this.controller.statusOf(key) !== 'update-available') return m.batchUpToDate(label);
              const later = laterSources(this.target(key)?.remotes ?? [], plan.downloadUrl);
              return later.length ? m.batchLater(label, laterSourcesText(later, plan.source), later.length) : m.batchNewerElsewhere(label);
            }
            if (plan.onlyAdds) {
              // Not installed on the user's behalf, since it's usually a new pack rather than an update
              // to theirs, and not marked as seen either: that would leave the row with no button and
              // the new files with no way back to them. The row stays, and its Update window asks.
              await this.discardPlans(key);
              const added = plan.files.filter((f) => f.kind === 'add').length;
              return m.batchOnlyAdds(SOURCE_LABEL[plan.source], added);
            }
            if (!plan.files.length) throw translatedError((m) => m.installer.noModFiles);
            if (opts.skipIfWarnings && plan.warnings.length) throw translatedError((m) => m.updater.needsALook(plan.warnings[0]!));
            const adds = newFiles(plan).length;
            if (adds && !this.controller.addsNewFiles(key)) {
              // Nobody is there to choose: left, with its row on Update ready, for the Update window.
              if (opts.automatic) throw translatedError((m) => m.updater.batchNewFiles(adds));
              this.held.set(key, plan.id);
              return {
                message: m.batchNewFiles(adds),
                review: { files: plan.files.filter((f) => !f.unchanged), ...(plan.startUnticked?.length && { startUnticked: plan.startUnticked }) },
              };
            }
            // Nobody is there to tick them: files left out before stay out.
            await this.apply(plan.id, { remove: [], skip: plan.startUnticked ?? [] }, { batchId, automatic: opts.automatic });
            return installedResult(plan, plan.startUnticked ?? []);
          } catch (err) {
            // Don't leave a failed item's downloads in temp until the next launch.
            await this.discardPlans(key);
            throw err;
          }
        },
        (state) => this.controller.setBatch(state),
        () => this.stopRequested,
        batchId,
      ));
    } finally {
      this.batchRunning = false;
    }
  }

  /**
   * Installs the updates waiting in Update all's review with the files the user ticked (`skip` is
   * what they unticked), in turn, as part of that run so Undo all covers them. Any not named, or
   * with nothing ticked, are left for later: their downloads go, and their rows stay on Update ready.
   * Stop after this one and Cancel now leave the rest for later too; an install itself can't be interrupted.
   */
  async finishReview(choices: unknown): Promise<void> {
    if (this.batchRunning) throw translatedError((m) => m.updater.alreadyUpdating);
    const batch = this.batch;
    const waiting = batch?.items.filter((i) => i.state === 'review') ?? [];
    if (!batch || !waiting.length) return;
    const chosen = new Map<string, { skip: string[]; always: boolean }>();
    for (const c of Array.isArray(choices) ? (choices as unknown[]) : []) {
      if (!c || typeof c !== 'object') continue;
      const { key, skip, always } = c as Record<string, unknown>;
      if (typeof key === 'string') chosen.set(key, { skip: Array.isArray(skip) ? skip.filter((p): p is string => typeof p === 'string') : [], always: always === true });
    }
    // What goes in: an update chosen, still downloaded, with something ticked.
    const jobs = new Map(
      waiting.flatMap((item) => {
        const planId = this.held.get(item.key);
        const entry = planId ? this.plans.get(planId) : undefined;
        const choice = chosen.get(item.key);
        const ticked = entry && choice ? entry.plan.files.some((f) => !f.unchanged && !choice.skip.includes(f.target)) : false;
        return entry && choice && ticked ? [[item, { entry, choice }] as const] : [];
      }),
    );
    // Every install would fail the same way: leave them all waiting. Not now installs nothing, so neither
    // holds it up. The lock is held by another update or by duplicate removal.
    if (jobs.size && this.isBusy()) throw translatedError((m) => m.updater.anotherUpdate);
    if (jobs.size && (await isGameRunning())) throw translatedError((m) => m.installer.closeGameUpdate);
    this.batchRunning = true;
    this.stopRequested = false;
    batch.running = true;
    try {
      for (const item of waiting) {
        const job = jobs.get(item);
        if (!job || this.stopRequested) {
          await this.discardPlans(item.key);
          Object.assign(item, { state: 'cancelled', message: t().updater.leftForLater, review: undefined });
          continue;
        }
        this.held.delete(item.key);
        Object.assign(item, { state: 'working', review: undefined });
        this.emitBatch();
        try {
          await this.exclusive(() => this.install(job.entry, { remove: [], skip: job.choice.skip }, { batchId: batch.batchId }));
          Object.assign(item, { state: 'done', ...installedResult(job.entry.plan, job.choice.skip) });
        } catch (err) {
          await this.discardPlans(item.key);
          Object.assign(item, { state: 'failed', message: (err as Error).message });
        }
        // Apart from the install: its files are in whether or not the choice could be saved.
        if (item.state === 'done' && job.choice.always) {
          await this.controller.setAddNewFiles(item.key, true).catch((err: Error) => console.warn('Could not save "Always add":', englishMessage(err)));
        }
        this.emitBatch();
      }
    } finally {
      batch.running = false;
      this.batchRunning = false;
      this.emitBatch();
    }
  }

  stopUpdateAll(): void {
    this.stopRequested = true;
  }

  isBusy(): boolean {
    return this.busy || this.batchRunning || this.preparing.size > 0;
  }

  /** Stops preparing an update and throws away its downloads (installs can't be interrupted). */
  async cancel(key: unknown): Promise<void> {
    if (typeof key !== 'string') return;
    this.aborts.get(key)?.abort();
    await this.discardPlans(key);
  }

  cancelUpdateAll(): void {
    this.stopRequested = true;
    for (const abort of this.aborts.values()) abort.abort();
  }

  /** Downloads never survive a restart (plans live in memory), so anything left is safe to delete. */
  async clearLeftoverDownloads(): Promise<void> {
    await removeDir(this.tempRoot);
  }

  async storage(): Promise<StorageInfo> {
    const webCache = await Promise.all((['loverslab', 'patreon'] as const).map((site) => siteSession(site).getCacheSize()));
    return {
      backups: await dirSize(this.controller.backupRoot),
      caches: (await dirSize(this.tempRoot)) + webCache.reduce((a, b) => a + b, 0),
    };
  }

  /** Leftover downloads, the log, and everything the LoversLab/Patreon browsers stored except sign-ins. */
  async clearCaches(): Promise<StorageInfo> {
    if (this.isBusy()) throw translatedError((m) => m.main.waitForUpdate);
    for (const key of [...this.held.keys()]) this.leaveForLater(key);
    this.plans.clear();
    clearLog();
    await removeDir(this.tempRoot);
    for (const site of ['loverslab', 'patreon'] as const) this.controller.pool.reset(site);
    await clearSiteBrowsingData(sessionsToClear(), true);
    return this.storage();
  }

  /** After a check: install wicked.cc updates that need no decisions (setting "install automatically"). */
  async autoInstall(result: CheckResult): Promise<void> {
    // The user is choosing files for the last Update all: a new run would throw that away.
    if (this.held.size) return;
    const keys = result.creators.filter((c) => c.status === 'update-available').map((c) => c.key);
    if (result.core.status === 'update-available') keys.unshift(CORE_KEY);
    const batch = await this.updateAll(keys, { publicOnly: true, skipIfWarnings: true, automatic: true }).catch((err: Error) => {
      console.warn('Automatic updates failed:', englishMessage(err));
      return undefined;
    });
    const installed = batch?.items.filter((i) => i.state === 'done' && i.replaced !== undefined).length ?? 0;
    if (batch?.batchId && installed) this.controller.emit({ type: 'auto-installed', batchId: batch.batchId, count: installed });
  }

  private async prepare(key: string, listingUrl: string | undefined, opts: PlanOptions): Promise<UpdatePlan> {
    const progress = this.progressFor(key);
    const abort = new AbortController();
    this.aborts.set(key, abort);
    const workDir = join(this.tempRoot, randomUUID());
    const pool = this.controller.pool;
    try {
      await this.controller.refreshLocalFiles();
      const target = this.target(key);
      // Offers found while comparing sources are reused, so the site isn't asked twice.
      const offers = new Map<string, Offer>();
      const remote =
        target?.fixedRemote ??
        (target &&
          (await chooseRemote(listingUrl ? target.remotes : (target.updateFrom ?? []), {
            signedIn: (site) => this.controller.isSignedIn(site),
            publicOnly: opts.publicOnly,
            listingUrl,
            signal: abort.signal,
            onCompare: () => progress('resolving', t().updater.comparing),
            countFiles: async (r) => {
              // The links stored here are bare, past filtering later: leave out what the update must
              // not bring (new packs, files the user said no to) before they are counted and kept.
              const skip = updateExclusions(r, this.controller.currentState.linkPrefs[String(key)]?.ignoredFiles ?? [], this.controller.installedFiles());
              const offer = await resolveOffer(r, pool, { probe: true, except: skip, signal: abort.signal });
              offers.set(r.listing.url, offer);
              return offerFileCount(offer);
            },
          })));
      if (!target || !remote) {
        throw translatedError((m) => (listingUrl ? m.updater.cantDownloadSource : opts.publicOnly ? m.updater.noPublicSource : m.updater.noSource));
      }
      await this.discardPlans(key);
      const label = SOURCE_LABEL[remote.listing.source];
      progress('resolving', t().updater.finding(label));
      if (opts.onlyFile && remote.listing.source !== 'loverslab') throw translatedError((m) => m.updater.onlyLoversLabFiles);
      // Installed files are looked for among everything scanned, not one creator's: a file got from
      // their page can be filed under another author (as a pack's Simlish edition was), or under
      // none at all (a script, or a package that names no author).
      const except = opts.onlyFile
        ? []
        : updateExclusions(remote, this.controller.currentState.linkPrefs[String(key)]?.ignoredFiles ?? [], this.controller.installedFiles());
      // A LoversLab page lists each file with its own upload date: files of theirs posted no later than
      // their copy aren't downloaded, and when that is all of them the update ends here, instead of a
      // long download that only shows the files were the same.
      let current: string[] = [];
      let offer: Offer | undefined;
      // A new file's date is on the page already; any other file's is on the list, where it's read.
      const uploaded: Record<string, number> = Object.fromEntries(
        (remote.newFiles ?? []).flatMap((f) => (f.updatedAt !== undefined ? [[f.name.toLowerCase(), f.updatedAt]] : [])),
      );
      if (opts.onlyFile) {
        offer = await resolveOffer(remote, pool, { probe: true, only: opts.onlyFile, signal: abort.signal });
      } else if (remote.listing.source === 'loverslab' && !opts.ignoreDates) {
        const { listed, button } = await loversLabFileList(remote, pool, abort.signal);
        // No list read (one file, or a list its markup hid): the button it found is the download, without
        // loading the page again. Should the button lead to a list, the download leaves `except` out.
        if (!listed && button) offer = { button };
        if (listed) {
          for (const f of listed) if (f.name && f.updatedAt !== undefined) uploaded[f.name.toLowerCase()] = f.updatedAt;
          current = currentByDate(listed, target.files, this.controller.installedFiles(), this.controller.currentState.linkPrefs[String(key)]?.gotFiles);
          let wanted: string[];
          try {
            wanted = chooserDownloads(listed, undefined, [...except, ...current]);
          } catch (err) {
            if (!(err instanceof DownloadUnavailableError) || !current.length) throw err;
            wanted = [];
          }
          if (!wanted.length) {
            const plan: UpdatePlan = {
              id: basename(workDir),
              creatorKey: key,
              name: target.name,
              downloadUrl: remote.listing.url,
              source: remote.listing.source,
              downloads: [],
              files: [],
              possiblyObsolete: [],
              skipped: [],
              warnings: [],
              upToDate: true,
              byDate: true,
            };
            this.plans.set(plan.id, { plan, workDir });
            progress('done', t().updater.upToDateByDate);
            return plan;
          }
          offer = { files: wanted };
        }
      }
      // No probe for the exclusions: the download applies them itself wherever it meets a list, and
      // probing a single-file entry's button would fetch the file twice.
      offer ??= offers.get(remote.listing.url);
      const downloads = await downloadForRemote(
        remote,
        join(workDir, 'download'),
        { fetcher: pool.fetcher(), pool },
        (received, total, file) => {
          const m = t().updater;
          const got = bytes(received);
          const size = total ? bytes(total) : undefined;
          const message = file.count > 1 ? m.downloadingFile(label, file.index + 1, file.count, got, size) : m.downloading(label, got, size);
          progress('downloading', message, received, total);
        },
        abort.signal,
        offer,
        except,
      );
      throwIfCancelled(abort.signal);

      progress('extracting', t().updater.unpacking);
      const extractedDir = join(workDir, 'files');
      const extractedFiles: string[] = [];
      const notMods: string[] = [];
      for (const [index, file] of downloads.entries()) {
        const name = basename(file);
        if (!ARCHIVE_FILE.test(name) && !MOD_FILE.test(name)) {
          notMods.push(name);
          continue;
        }
        // Keep each download's contents apart so same-named files inside different archives don't collide.
        const sub = downloads.length > 1 ? `${index + 1}-${name}` : '';
        extractedFiles.push(...(await extractDownload(file, join(extractedDir, sub), abort.signal)).map((f) => join(sub, f)));
      }
      throwIfCancelled(abort.signal);

      progress('extracting', t().updater.comparingInstalled);
      const plan = planInstall({
        id: basename(workDir),
        creatorKey: key,
        name: target.name,
        downloadUrl: remote.listing.url,
        source: remote.listing.source,
        downloads: downloads.map((d) => basename(d)),
        extractedDir,
        extractedFiles,
        installedFiles: target.files,
        modsRoots: this.controller.currentState.dirs,
      });
      plan.skipped.push(...notMods);
      await markUnchanged(plan, abort.signal);
      if (current.length) {
        // Left out of the download because theirs is as new: not "missing from this download", and
        // with nothing of theirs changed, what's left only adds files.
        plan.possiblyObsolete = plan.possiblyObsolete.filter((p) => !current.includes(basename(p).toLowerCase()));
        if (plan.files.length && plan.files.every((f) => f.kind === 'add' || f.unchanged)) plan.onlyAdds = true;
      }
      // Files left out before start unticked; not for Get it, where the one file was asked for.
      const skipped = opts.onlyFile ? [] : (this.controller.currentState.linkPrefs[String(key)]?.skippedFiles ?? []);
      const unticked = startUnticked(plan.files, skipped, this.controller.installedFiles());
      if (unticked.length) plan.startUnticked = unticked;
      if (await isGameRunning()) plan.gameRunning = true;
      this.plans.set(plan.id, { plan, workDir, uploaded });
      progress('done', plan.upToDate ? t().updater.upToDateWith(label) : t().updater.readyFrom(label));
      return plan;
    } catch (err) {
      const cancelled = abort.signal.aborted;
      progress('error', cancelled ? t().updater.cancelled : (err as Error).message);
      await rm(workDir, { recursive: true, force: true });
      throw cancelled ? new CancelledError() : err;
    } finally {
      if (this.aborts.get(key) === abort) this.aborts.delete(key);
    }
  }

  private async install(entry: { plan: UpdatePlan; workDir: string; uploaded?: Record<string, number> }, choice: UpdateChoice, meta: InstallMeta): Promise<AppSnapshot> {
    const { plan, workDir, uploaded } = entry;
    const progress = this.progressFor(plan.creatorKey);
    progress('installing', t().updater.installingEllipsis);
    try {
      const record = await applyInstall({
        plan,
        remove: choice.remove,
        skip: choice.skip,
        backupRoot: this.controller.backupRoot,
        modsRoots: this.controller.currentState.dirs,
      });
      this.plans.delete(plan.id);
      await rm(workDir, { recursive: true, force: true });
      // What they left unticked is remembered, so it starts unticked next time; what they
      // installed is forgotten, being theirs now.
      const added = plan.files.filter((f) => f.kind === 'add' && !f.unchanged);
      this.controller.rememberSkipped(
        plan.creatorKey,
        added.filter((f) => choice.skip.includes(f.target)).map((f) => basename(f.target)),
        added.filter((f) => !choice.skip.includes(f.target)).map((f) => basename(f.target)),
      );
      const newPack = this.isNewPackPage(plan);
      progress('done', newPack ? t().updater.added(plan.name) : t().updater.updated(plan.name));
      // Left for later in Update all's review, then installed from its Update window: say so there. Not
      // counted with the run's installs, since that run's Undo all doesn't cover it.
      const setAside = !meta.batchId && this.setAside.delete(plan.creatorKey) ? this.batch?.items.find((i) => i.key === plan.creatorKey) : undefined;
      if (setAside) {
        Object.assign(setAside, { state: 'done', message: installedResult(plan, choice.skip).message });
        this.emitBatch();
      }
      // A LoversLab archive has no file of its name in the Mods folder to say the user has it now. It's
      // theirs as of the upload the list dated, where it did; failing that, as of now.
      const got = plan.source === 'loverslab' ? plan.downloads.filter((d) => ARCHIVE_FILE.test(d)).map((d) => d.toLowerCase()) : [];
      const gotFiles = Object.fromEntries(got.map((name) => [name, uploaded?.[name] ?? record.at]));
      // Each mod file put in place, with its upload date where the list named it by that name.
      const placed = plan.files.filter((f) => !f.unchanged && !choice.skip.includes(f.target)).map((f) => basename(f.target).toLowerCase());
      const uploadedAt = Object.fromEntries(placed.map((name) => [name, uploaded?.[name] ?? null]));
      return await this.controller.recordInstall({
        ...record,
        source: plan.source,
        listingUrl: plan.downloadUrl,
        batchId: meta.batchId,
        automatic: meta.automatic || undefined,
        newPack: newPack || undefined,
        ...(got.length && { gotFiles }),
        ...(placed.length && { uploadedAt }),
      });
    } catch (err) {
      progress('error', (err as Error).message);
      throw err;
    }
  }

  /**
   * Whether this was installed from a page the last check marked as a pack the user didn't have.
   * Asked here rather than derived from the install's operations: an ordinary update that happens
   * to only add files is indistinguishable by its operations alone.
   */
  private isNewPackPage(plan: UpdatePlan): boolean {
    const creator = this.controller.currentState.lastResult?.creators.find((c) => c.key === plan.creatorKey);
    return creator?.remotes.some((r) => r.listing.url === plan.downloadUrl && r.owned === 'no') ?? false;
  }

  /** Drops earlier prepared downloads for a creator (e.g. after switching source). */
  private async discardPlans(creatorKey: string): Promise<void> {
    // Its download is going (the Update window preparing it again, say): the review can't install it now.
    this.leaveForLater(creatorKey);
    for (const [id, entry] of this.plans) {
      if (entry.plan.creatorKey !== creatorKey) continue;
      this.plans.delete(id);
      await rm(entry.workDir, { recursive: true, force: true });
    }
  }

  /** An update waiting in the review won't be installed from it: say so, and forget it. */
  private leaveForLater(creatorKey: string): void {
    if (!this.held.delete(creatorKey)) return;
    const item = this.batch?.items.find((i) => i.key === creatorKey && i.state === 'review');
    if (!item) return;
    Object.assign(item, { state: 'cancelled', message: t().updater.leftForLater, review: undefined });
    this.setAside.add(creatorKey);
    this.emitBatch();
  }

  /** Sends the last run's state to the window; mid-review, with whether Stop was pressed, as runBatch does. */
  private emitBatch(): void {
    const batch = this.batch;
    if (!batch) return;
    this.controller.setBatch({ ...batch, stopRequested: batch.running && this.stopRequested, items: batch.items.map((i) => ({ ...i })) });
  }

  private signedIn(opts: PlanOptions): (site: 'loverslab' | 'patreon') => boolean {
    return (site) => !opts.publicOnly && this.controller.isSignedIn(site);
  }

  private target(key: string): UpdateTarget | undefined {
    const result = this.controller.currentState.lastResult;
    if (!result) return undefined;
    if (key === CORE_KEY) {
      const core = result.core;
      if (!core.downloadPageUrl?.includes('wicked.cc')) return undefined;
      return {
        name: 'WickedWhims',
        files: core.installedFiles ?? (core.installed ? [core.installed] : []),
        remotes: [],
        fixedRemote: {
          listing: { source: 'wickedcc', url: core.downloadPageUrl, origin: 'directory' },
          checkedAt: result.finishedAt,
          status: 'ok',
          updatedAt: core.releasedAt,
        },
      };
    }
    const creator = result.creators.find((c) => c.key === key);
    return (
      creator && {
        name: creator.name,
        files: creator.files,
        remotes: creator.remotes,
        updateFrom: updateSources(creator.remotes, creator.localUpdatedAt, creator.dismissedAt),
      }
    );
  }

  private progressFor(creatorKey: string) {
    return (stage: UpdateStage, message: string, received?: number, total?: number): void =>
      this.controller.emit({ type: 'update-progress', progress: { creatorKey, stage, message, received, total } });
  }

  /** Runs `fn` while no update can start: for other changes to the Mods folders (removing duplicates). */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive(fn);
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw translatedError((m) => m.updater.anotherUpdate);
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
}

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${numberFormat({ maximumFractionDigits: 0 }).format(n / 1024)} KB`;
  const digits = n < 100 * 1024 * 1024 ? 1 : 0;
  return `${numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n / 1024 / 1024)} MB`;
}

/** What a batch item says once installed, `skip` being the files left out. */
function installedResult(plan: UpdatePlan, skip: readonly string[]): Pick<BatchItem, 'message' | 'replaced' | 'added' | 'addedNames'> {
  const m = t().updater;
  const changed = plan.files.filter((f) => !f.unchanged && !skip.includes(f.target));
  const added = changed.filter((f) => f.kind === 'add');
  // Files skipped before and still left out: said out loud, since the file is still one tick away.
  const leftOut = plan.startUnticked?.filter((target) => skip.includes(target)).length ?? 0;
  return {
    message: `${m.batchInstalled(changed.length, SOURCE_LABEL[plan.source])}${leftOut ? ` · ${m.batchLeftOut(leftOut)}` : ''}${
      plan.warnings.length ? ` (${plan.warnings[0]})` : ''
    }`,
    replaced: changed.filter((f) => f.kind === 'replace').length,
    added: added.length,
    ...(added.length && { addedNames: added.map((f) => basename(f.target)) }),
  };
}
