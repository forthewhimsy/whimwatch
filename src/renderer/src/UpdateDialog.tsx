import { ArrowRightLeft, BellOff, CheckCircle2, Download, ExternalLink, FolderOpen, Gamepad2, Info, Minus, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UpdatePlan } from '../../shared/api';
import { t } from '../../shared/i18n';
import type { UpdateSite } from '../../shared/types';
import { laterSources, newestPage, outdatedRemotes } from '../../shared/updatable';
import { formatVersion } from '../../shared/version';
import { Dialog, useConfirm } from './dialog';
import { CORE_KEY, downloadOptions } from './eligibility';
import { fileName, formatBytes, formatShortDate, shortTitle, SOURCE_LABEL, timeAgo } from './format';
import { rich } from './rich';
import { useToast } from './toast';
import { api, type AppModel } from './useApp';
import { useSiteToggle } from './useSiteToggle';
import { Banner, Button, Checkbox, Disclosure, Segmented, Spinner } from './ui';

export interface UpdateTarget {
  key: string;
  name: string;
  /** A page to install from. Set for a pack the user doesn't have, which is got from its own page. */
  listingUrl?: string;
  /** That page's name, so the dialog is about the pack rather than the creator. */
  packName?: string;
  /** A new file on a page of theirs: download just this one, not the page's other files. */
  fileName?: string;
}

/** Beyond this many "not in this download" files, the list is folded away rather than scrolled past. */
const OBSOLETE_SHOWN = 6;

/** Shows what an update will change, then installs it. */
export function UpdateDialog({ target, app, onClose }: { target: UpdateTarget; app: AppModel; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const toggleSite = useSiteToggle(app);
  const [plan, setPlan] = useState<UpdatePlan>();
  const [failed, setFailed] = useState<string>();
  const [remove, setRemove] = useState<string[]>([]);
  const [skip, setSkip] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  // A pack they don't have is got from the page they picked, and from nowhere else.
  const newPack = target.listingUrl !== undefined;
  // Sources as they were when the dialog opened; the newest is the default.
  const [options] = useState(() => (app.snapshot ? downloadOptions(target.key, app.snapshot, target.listingUrl) : []));
  // Undefined lets the app pick (newest, then most files); the plan reports what it chose.
  const [sourceUrl, setSourceUrl] = useState<string | undefined>(target.listingUrl);
  // Set by "Download and compare anyway", when the page's dates can't be trusted.
  const [compareAnyway, setCompareAnyway] = useState(false);
  const progress = app.updates[target.key];
  const snapshot = app.snapshot;
  const creator = snapshot?.lastResult?.creators.find((c) => c.key === target.key);
  const m = t().update;
  /** The pack's own name where the site gives one and page titles aren't hidden. */
  const packLabel = !target.packName || snapshot?.settings.hidePageTitles ? m.aPackFrom(target.name) : shortTitle(target.packName, 40);

  const chooseSource = (url: string): void => {
    if (url === (sourceUrl ?? plan?.downloadUrl)) return;
    setPlan(undefined);
    setFailed(undefined);
    setRemove([]);
    setSkip([]);
    setSourceUrl(url);
  };

  useEffect(() => {
    let cancelled = false;
    api.planUpdate(target.key, sourceUrl, target.fileName, compareAnyway).then(
      (p) => {
        if (cancelled) return;
        setPlan(p);
        // Files they left out before start unticked; everything else starts ticked.
        setSkip(p.startUnticked ?? []);
        setGameOpen(Boolean(p.gameRunning));
      },
      (err: Error) => !cancelled && setFailed(err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')),
    );
    return () => {
      cancelled = true;
    };
  }, [target.key, sourceUrl, target.fileName, compareAnyway]);

  // "Close the game to install": look again whenever the user comes back to the window, and every few seconds.
  useEffect(() => {
    if (!gameOpen) return;
    const recheck = (): void => void api.isGameRunning().then(setGameOpen, () => undefined);
    const timer = setInterval(recheck, 5000);
    window.addEventListener('focus', recheck);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', recheck);
    };
  }, [gameOpen]);

  const close = (): void => {
    // Stops any download in progress and throws away the downloaded files.
    if (!installing) void api.cancelUpdate(target.key);
    onClose();
  };

  const install = async (): Promise<void> => {
    if (!plan) return;
    setInstalling(true);
    const done = await app.run(() => api.applyUpdate(plan.id, { remove, skip }));
    setInstalling(false);
    if (!done) return;
    const record = [...done.installs].reverse().find((i) => i.creatorKey === target.key);
    toast({
      text: newPack ? m.added(packLabel) : m.updated(target.name),
      action: record ? { label: t().common.undo, run: () => void app.run(() => api.undoInstall(record.id)) } : undefined,
    });
    onClose();
  };

  const busy = !plan && !failed;
  const shownUrl = sourceUrl ?? plan?.downloadUrl ?? options[0]?.url;
  const shownLabel = options.find((o) => o.url === shownUrl)?.label ?? (plan ? SOURCE_LABEL[plan.source] : options[0]?.label);

  const replaceFiles = plan?.files.filter((f) => f.kind === 'replace' && !f.unchanged) ?? [];
  const addFiles = plan?.files.filter((f) => f.kind === 'add') ?? [];
  // Your files are all unchanged and it only adds new ones: usually a new pack on the same page.
  const onlyAdds = Boolean(plan?.onlyAdds && !newPack);
  const unchanged = plan?.files.filter((f) => f.unchanged) ?? [];
  const chosenReplace = replaceFiles.filter((f) => !skip.includes(f.target)).length;
  const chosenAdd = addFiles.filter((f) => !skip.includes(f.target)).length;
  const otherWarnings = plan?.warnings ?? [];
  const nothingChosen = chosenReplace + chosenAdd + remove.length === 0;
  /**
   * Only pages that are themselves behind. Ranked across every page, this named the creator's
   * newest *other* pack — and offered to stop following a pack the user owns and is up to date on.
   */
  const behindPages = creator ? outdatedRemotes(creator.remotes, creator.localUpdatedAt, creator.dismissedAt) : [];
  // Only for an update: "another page of theirs is newer" says nothing about a pack they were getting.
  const later = plan?.upToDate && !newPack ? laterSources(behindPages, plan.downloadUrl) : [];
  /**
   * A page of theirs that's newer than the one downloaded from — named, so it can be fetched,
   * opened or dropped rather than alluded to. Not the same page: matching the newest page and still
   * counting as an update means the dates differ, not the files.
   */
  const newest = plan?.upToDate && !newPack ? newestPage(behindPages) : undefined;
  const newerElsewhere = Boolean(newest && newest.listing.url !== plan?.downloadUrl && later.length > 0);
  const newestName = !newest?.title || snapshot?.settings.hidePageTitles ? undefined : shortTitle(newest.title, 40);
  const canGetNewest = newerElsewhere && options.some((o) => o.url === newest?.listing.url);

  const dropPage = async (r: NonNullable<typeof newest>): Promise<void> => {
    const done = await app.run(() => api.rejectLink(target.key, r.listing.url));
    if (!done) return;
    toast({
      text: m.removedPage(SOURCE_LABEL[r.listing.source], target.name),
      action: { label: t().common.undo, run: () => void app.run(() => api.undoRejectLink(target.key, r.listing.url)) },
    });
    close();
  };

  const stopChecking = async (site: UpdateSite): Promise<void> => {
    const label = SOURCE_LABEL[site];
    const ok = await confirm({
      title: m.stopTitle(label),
      body: m.stopBody(label),
      confirmLabel: m.stopConfirm(label),
    });
    if (ok) await toggleSite(site, false);
  };

  // "This replaces 1 file and adds 1." — the unit is named once.
  const changes = [
    [m.replaces, chosenReplace],
    [m.adds, chosenAdd],
    [m.removes, remove.length],
  ] as const;
  const summary = changes.filter(([, n]) => n > 0).map(([verb, n], i) => verb(n, i === 0));
  const leftAlone = unchanged.length + (plan?.skipped.length ?? 0);

  const packPage = newPack ? creator?.remotes.find((r) => r.listing.url === target.listingUrl) : undefined;
  /** The page the creator's "Update ready" is about: the one whose date the row is showing. */
  const behindPage = creator?.remotes.find((r) => r.owned !== 'no' && r.updatedAt === creator.remoteUpdatedAt);
  // A new file on a page of theirs has its own date; the page's is their pack's.
  const postedAt = target.fileName ? packPage?.newFiles?.find((f) => f.name === target.fileName)?.updatedAt : packPage?.updatedAt;
  const subtitle = newPack
    ? m.fromPosted(target.name, postedAt !== undefined ? formatShortDate(postedAt) : undefined)
    : target.key !== CORE_KEY && creator?.remoteUpdatedAt !== undefined
      ? // Against the files from this pack where the page named them, not the creator's newest file:
      // "you have files from Sep 17" under a pack you last updated in 2024 helps nobody.
      m.postedYouHave(timeAgo(creator.remoteUpdatedAt), formatShortDate(behindPage?.yoursAt ?? creator.localUpdatedAt))
      : undefined;

  return (
    <Dialog
      title={newPack ? m.getTitle(packLabel) : m.updateTitle(target.name)}
      subtitle={subtitle}
      onClose={close}
      dismissable={!installing}
      width={640}
      footer={
        <>
          {plan && !plan.upToDate && (
            <button type="button" className="link-btn accent" aria-expanded={showBackups} onClick={() => setShowBackups(!showBackups)}>
              <Info size={15} aria-hidden="true" /> {m.howBackups}
            </button>
          )}
          <span className="spacer" />
          <Button variant="quiet" onClick={close} disabled={installing}>
            {t().common.cancel}
          </Button>
          {plan?.upToDate && newPack ? (
            // Nothing to mark as seen: this page was never counted as an update in the first place.
            <Button variant="primary" onClick={close}>
              {t().common.close}
            </Button>
          ) : plan?.upToDate ? (
            <Button
              variant="primary"
              onClick={async () => {
                // Something newer of theirs is out there: hide that too, or this would say
                // "marked as seen" and leave the creator sitting on Update ready.
                const newest = newerElsewhere ? creator?.remoteUpdatedAt : undefined;
                const seen = await app.run(() => (newest !== undefined ? api.dismiss(target.key, newest) : api.markSeen(target.key, plan.downloadUrl)));
                if (seen) close();
              }}
            >
              {newerElsewhere ? t().common.markAllAsSeen : t().common.markAsSeen}
            </Button>
          ) : (
            <>
              {onlyAdds && (
                <Button
                  onClick={async () => {
                    const seen = await app.run(() => api.markSeen(target.key, plan!.downloadUrl));
                    if (seen) close();
                  }}
                  disabled={installing}
                >
                  {t().common.markAsSeen}
                </Button>
              )}
              <Button variant="primary" icon={gameOpen ? Gamepad2 : Download} onClick={install} disabled={!plan || installing || gameOpen || nothingChosen}>
                {installing ? m.installing : gameOpen ? m.closeGame : newPack ? m.installPack : onlyAdds ? m.installNew : m.installUpdate}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="source-bar">
        <span className="muted">{m.downloadFrom}</span>
        {options.length > 1 ? (
          <Segmented
            label={m.downloadFrom}
            value={shownUrl}
            onChange={chooseSource}
            options={options.map((o) => ({
              value: o.url,
              disabled: busy || installing,
              label: (
                <>
                  {/* The page's name where there is one: with a dozen pages on one site, the
                      site's name on every chip is the one thing that can't tell them apart. */}
                  <strong>{o.title ? shortTitle(o.title) : o.label}</strong>{' '}
                  <span className="faint">
                    {o.title && `${o.label} · `}
                    {formatShortDate(o.updatedAt)}
                    {o.version && ` · ${formatVersion(o.version)}`}
                  </span>
                </>
              ),
            }))}
          />
        ) : (
          <strong>{shownLabel ?? m.noSource}</strong>
        )}
        {shownUrl && (
          <button
            type="button"
            className="link-btn accent"
            title={`${shownUrl}\n${m.rightClickPrivate}`}
            onClick={() => app.run(() => api.openExternal(shownUrl))}
            onContextMenu={(e) => {
              e.preventDefault();
              void app.run(() => api.showLinkMenu(shownUrl));
            }}
          >
            {t().common.openPage} <ExternalLink size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {busy && (
        <div className="progress-block" role="status">
          <p className="row-center">
            <Spinner /> {progress?.message ?? m.preparing}
          </p>
          <ProgressBar received={progress?.received} total={progress?.total} />
          {!sourceUrl && options.length > 1 && <p className="faint small">{m.choosingNewest}</p>}
        </div>
      )}
      {failed && (
        <Banner tone="error" title={m.couldntPrepare}>
          {failed}
        </Banner>
      )}

      {gameOpen && plan && !plan.upToDate && (
        <Banner tone="error" title={m.gameOpenTitle}>
          {m.gameOpen}
        </Banner>
      )}

      {plan?.upToDate && (
        newerElsewhere ? (
          <Banner
            tone="info"
            title={m.nothingNewOn(shownLabel)}
            actions={
              newest &&
              (canGetNewest ? (
                // Downloads it and compares, which is the only way to know whether there's anything
                // in it the user doesn't already have. Saying so would be a guess.
                <Button size="sm" icon={Download} onClick={() => chooseSource(newest.listing.url)} disabled={busy || installing}>
                  {m.seeWhatsIn}
                </Button>
              ) : (
                <Button size="sm" icon={ExternalLink} onClick={() => app.run(() => api.openExternal(newest.listing.url))}>
                  {t().common.openPage}
                </Button>
              ))
            }
          >
            <p>
              {rich(m.newer, { page: <strong>{newestName ?? m.anotherPage(newest ? SOURCE_LABEL[newest.listing.source] : '')}</strong> })}
              {newest?.updatedAt !== undefined && ` (${formatShortDate(newest.updatedAt)})`}
            </p>
            {newest && (
              <p className="off-links">
                <button type="button" className="link-btn accent" onClick={() => void dropPage(newest)}>
                  <Trash2 size={14} aria-hidden="true" /> {m.removeThatPage}
                </button>
              </p>
            )}
            {/* Turning a whole site off only makes sense for one you're not already downloading
                from; for another page of this site, removing that page is the answer. */}
            {later.filter((r) => r.listing.source !== plan?.source).map((r) => {
              const site = r.listing.source as UpdateSite;
              return (
                <p key={r.listing.url} className="off-links">
                  <button type="button" className="link-btn accent" onClick={() => void toggleSite(site, false, target.key)}>
                    <BellOff size={14} aria-hidden="true" /> {t().creator.dontCheckFor(SOURCE_LABEL[site], target.name)}
                  </button>
                  <button type="button" className="link-btn accent" onClick={() => void stopChecking(site)}>
                    {m.stopEveryone(SOURCE_LABEL[site])}
                  </button>
                </p>
              );
            })}
          </Banner>
        ) : newPack ? (
          // Worth saying plainly: WhimWatch put this page under "packs you don't have" and was wrong.
          <Banner tone="ok" title={m.alreadyHavePackTitle}>
            {m.alreadyHavePack}
          </Banner>
        ) : (
          <Banner
            tone="ok"
            title={m.nothingToInstallTitle}
            actions={
              // Only dates were compared: a Mods folder copied or synced can have reset them.
              plan.byDate && (
                <Button
                  size="sm"
                  icon={Download}
                  onClick={() => {
                    setPlan(undefined);
                    setCompareAnyway(true);
                  }}
                >
                  {m.compareAnyway}
                </Button>
              )
            }
          >
            {plan.byDate ? m.byDate : m.sameFile} {m.markItSeen}
          </Banner>
        )
      )}

      {onlyAdds && (
        <Banner tone="info" title={m.onlyAddsTitle}>
          {m.onlyAdds(shownLabel, addFiles.length)}
        </Banner>
      )}

      {plan && !plan.upToDate && (
        <>
          <div className="plan-summary">
            <span className="tone-icon mint">
              <ShieldCheck size={20} aria-hidden="true" />
            </span>
            <div>
              <strong>{summary.length ? m.summary(summary) : m.nothingSelected}</strong>
              <p className="muted">
                {m.backedUp}
                {plan.downloads.length > 1 && ` ${m.downloadsFrom(plan.downloads.length, shownLabel ?? '')}`}
              </p>
            </div>
          </div>

          {showBackups && (
            <div className="explain small">
              {rich(m.backupExplain, { path: <code>{snapshot?.backupRoot}</code> })}{' '}
              {snapshot && snapshot.settings.keepBackupsDays > 0 ? m.backupsDeletedAfter(snapshot.settings.keepBackupsDays) : m.backupsKept}{' '}
              <button type="button" className="link-btn accent" onClick={() => app.run(() => api.openBackupFolder())}>
                <FolderOpen size={14} aria-hidden="true" /> {m.openBackups}
              </button>
            </div>
          )}

          {otherWarnings.map((w) => (
            <Banner key={w} tone="warn">
              {w}
            </Banner>
          ))}

          <div className="file-changes">
            {/* Headed apart, so the ticks read as "install this" and not as "you have this". Not
                "newer versions": the page picked can be older than the user's copy. The hint goes under
                the first heading only, since a tick under "Not in this download" removes a file. */}
            {(
              [
                [replaceFiles, m.replacesYours],
                [addFiles, m.newFiles],
              ] as const
            ).map(
              ([files, heading]) =>
                files.length > 0 && (
                  <div key={files[0]!.kind} className="file-section">
                    <div className="section-label">{heading(files.length)}</div>
                    {files === (replaceFiles.length ? replaceFiles : addFiles) && <p className="muted small">{m.tickedInstalled}</p>}
                    {files.map((f) => (
                      <FileLine
                        key={f.target}
                        kind={f.kind}
                        path={f.target}
                        checked={!skip.includes(f.target)}
                        onToggle={() => setSkip(toggle(skip, f.target))}
                        note={
                          plan?.startUnticked?.includes(f.target)
                            ? m.skippedBefore
                            : f.installedAt !== undefined
                              ? m.yours(formatShortDate(f.installedAt))
                              : undefined
                        }
                      />
                    ))}
                  </div>
                ),
            )}
            {/* Not for a pack they're getting: nothing installed can be an older version of a pack
                they never had, so every file the creator made would be listed for removal. */}
            {!newPack && plan.possiblyObsolete.length > 0 && (
              <div className="file-section">
                <div className="section-label">{m.notInDownload}</div>
                <p className="muted small">{m.notInDownloadHint}</p>
                {plan.possiblyObsolete.length > OBSOLETE_SHOWN ? (
                  // A creator with a page per pack has most of their files in here every time.
                  <Disclosure summary={m.showFiles(plan.possiblyObsolete.length)}>
                    {plan.possiblyObsolete.map((path) => (
                      <FileLine key={path} kind="remove" path={path} checked={remove.includes(path)} onToggle={() => setRemove(toggle(remove, path))} />
                    ))}
                  </Disclosure>
                ) : (
                  plan.possiblyObsolete.map((path) => (
                    <FileLine key={path} kind="remove" path={path} checked={remove.includes(path)} onToggle={() => setRemove(toggle(remove, path))} />
                  ))
                )}
              </div>
            )}
            {leftAlone > 0 && (
              <Disclosure
                className="left-alone"
                summary={m.leftAlone(leftAlone, [
                  ...(unchanged.length > 0 ? [m.alreadyIdentical(unchanged.length)] : []),
                  ...(plan.skipped.length > 0 ? [m.notModFiles(plan.skipped.length)] : []),
                ])}
              >
                <ul className="plain-list mono small">
                  {unchanged.map((f) => (
                    <li key={f.target} title={f.target}>
                      <CheckCircle2 size={13} aria-hidden="true" /> {fileName(f.target)}
                    </li>
                  ))}
                  {plan.skipped.map((name) => (
                    <li key={name} className="faint">
                      <Minus size={13} aria-hidden="true" /> {name}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </div>
          {installing && progress && <p className="muted small">{progress.message}</p>}
        </>
      )}
    </Dialog>
  );
}

const KIND = {
  replace: { icon: ArrowRightLeft, off: 'skip' },
  add: { icon: Plus, off: 'skip' },
  remove: { icon: Minus, off: 'keep' },
} as const;

function FileLine({ kind, path, checked, onToggle, note }: { kind: keyof typeof KIND; path: string; checked: boolean; onToggle: () => void; note?: string }) {
  const { icon: KindIcon } = KIND[kind];
  const label = t().update.kind[kind];
  const off = t().update.kind[KIND[kind].off];
  return (
    <label className={`file-line kind-${kind} ${checked ? '' : 'off'}`}>
      <Checkbox checked={checked} onChange={onToggle} label={`${label} ${fileName(path)}`} />
      <span className="kind-icon" aria-hidden="true">
        <KindIcon size={14} />
      </span>
      <span className="mono file-line-name" title={path}>
        {fileName(path)}
      </span>
      {note && <span className="faint small file-line-note">{note}</span>}
      <span className="kind-label">{checked ? label : off}</span>
    </label>
  );
}

const toggle = (list: string[], value: string): string[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

function ProgressBar({ received, total }: { received?: number; total?: number }) {
  const pct = received !== undefined && total ? Math.min(100, (received / total) * 100) : undefined;
  return (
    <div
      className={`bar ${pct === undefined ? 'indeterminate' : ''}`}
      role="progressbar"
      aria-valuenow={pct === undefined ? undefined : Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={received !== undefined ? t().update.received(formatBytes(received), total ? formatBytes(total) : undefined) : undefined}
    >
      <span style={pct === undefined ? undefined : { width: `${pct}%` }} />
    </div>
  );
}
