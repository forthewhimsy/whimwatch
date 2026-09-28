import {
  BellOff,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  EyeOff,
  FileQuestion,
  Lock,
  LogIn,
  PackagePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';
import { type CreatorResult, type FileAnswer, type RemoteInfo, UPDATE_SITES, type UpdateSite } from '../../shared/types';
import { ownedRemotes } from '../../shared/updatable';
import {
  afterCheck,
  ignoredFilesFor,
  maybeUpdatesFor,
  type NewFile,
  newFilesFor,
  type NewPackAction,
  newPackAction,
  newPacksFor,
  rowAction,
  rowStatus,
  rowSummary,
  siteNames,
} from './eligibility';
import { formatVersion } from '../../shared/version';
import { formatShortDate, remoteSummary, pageLabel, shortTitle, SOURCE_LABEL, timeAgo } from './format';
import { rich } from './rich';
import { useToast } from './toast';
import type { UpdateTarget } from './UpdateDialog';
import { api, type AppModel } from './useApp';
import { useSiteToggle } from './useSiteToggle';
import { Button, Checkbox, Disclosure, IconButton, MenuButton, Spinner, StatusMarker } from './ui';

export interface Row {
  creator: CreatorResult;
  /** This check hasn't reached the creator yet (the row keeps its last status). */
  pending: boolean;
}

const SITE_BADGE = { wickedcc: 'wc', loverslab: 'LL', patreon: 'P', wwmod: 'WW' } as const;

export function CreatorList({ rows, app, onUpdate }: { rows: Row[]; app: AppModel; onUpdate: (target: UpdateTarget) => void }) {
  const [open, setOpen] = useState<string>();
  const [addingFor, setAddingFor] = useState<string>();
  return (
    <ul className="creator-list card">
      {rows.map(({ creator, pending }) => (
        <CreatorRow
          key={creator.key}
          creator={creator}
          pending={pending}
          expanded={open === creator.key}
          onToggle={() => setOpen(open === creator.key ? undefined : creator.key)}
          adding={addingFor === creator.key}
          onAdding={(on) => {
            setAddingFor(on ? creator.key : undefined);
            if (on) setOpen(creator.key);
          }}
          app={app}
          onUpdate={onUpdate}
        />
      ))}
    </ul>
  );
}

function CreatorRow({
  creator: c,
  pending,
  expanded,
  onToggle,
  adding,
  onAdding,
  app,
  onUpdate,
}: {
  creator: CreatorResult;
  pending: boolean;
  expanded: boolean;
  onToggle: () => void;
  adding: boolean;
  onAdding: (on: boolean) => void;
  app: AppModel;
  onUpdate: (target: UpdateTarget) => void;
}) {
  const snapshot = app.snapshot!;
  const status = rowStatus(c);
  const action = rowAction(c, snapshot);
  const progress = app.updates[c.key];
  const busy = progress !== undefined && progress.stage !== 'done' && progress.stage !== 'error';
  const sources = [...new Set(c.remotes.map((r) => SOURCE_LABEL[r.listing.source]))];
  const packs = newPacksFor(c, snapshot);
  const files = newFilesFor(c, snapshot);
  const maybe = maybeUpdatesFor(c, snapshot);
  const m = t();

  return (
    <li className={`creator ${expanded ? 'expanded' : ''}`}>
      <div className="creator-head">
        <button type="button" className="creator-toggle" aria-expanded={expanded} onClick={onToggle}>
          <span className="creator-name">{c.name}</span>
          <span className="creator-sub faint">
            {/* Never a status marker and never the Update button: a pack you don't have isn't an
                update. It sits on the creator's own line, where it can't be read as one. */}
            {packs.length + files.length > 0 && !pending && (
              <span className="tag new-packs-tag">
                <PackagePlus size={12} aria-hidden="true" /> {m.creator.newPacks(packs.length + files.length)}
              </span>
            )}
            {/* Asks rather than tells: neither an update nor a new pack until the user says. */}
            {maybe.length > 0 && !pending && (
              <span className="tag new-packs-tag">
                <FileQuestion size={12} aria-hidden="true" /> {m.creator.maybeTag(maybe.length)}
              </span>
            )}
            {m.common.files(c.files.length)}
            {sources.length > 0 && ` · ${sources.join(', ')}`}
          </span>
        </button>
        <span className={`creator-summary ${pending ? 'faint' : ''}`}>{pending ? m.summary.checkingNow : rowSummary(c, (at) => timeAgo(at))}</span>
        <StatusMarker status={status} checking={pending && app.snapshot?.running} />
        <span className="creator-action">
          {action.kind === 'update' && (
            <Button size="sm" icon={Download} onClick={() => onUpdate({ key: c.key, name: c.name })}
              disabled={busy || snapshot.running}
              title={snapshot.running ? afterCheck() : undefined}
            >
              {m.common.update}
            </Button>
          )}
          {action.kind === 'sign-in' && (
            <Button size="sm" icon={LogIn} onClick={() => app.run(() => api.signIn(action.site))}>
              {m.common.signInTo(SOURCE_LABEL[action.site])}
            </Button>
          )}
          {action.kind === 'open' && (
            <Button size="sm" icon={ExternalLink} onClick={() => app.run(() => api.openExternal(action.url))} onContextMenu={linkMenu(app, action.url)}>
              {m.common.openPage}
            </Button>
          )}
          {action.kind === 'checking' && (
            <Button size="sm" disabled>
              <Spinner size={14} /> {m.settings.checkingEllipsis}
            </Button>
          )}
          {action.kind === 'recheck' && (
            // A check reads the page signed in anyway, and this can't start during one.
            <Button
              size="sm"
              icon={RefreshCw}
              disabled={snapshot.running}
              title={snapshot.running ? afterCheck() : undefined}
              onClick={() => app.run(() => api.recheckPatreon(c.key))}
            >
              {m.common.checkAgain}
            </Button>
          )}
          {action.kind === 'verify' && (
            <Button size="sm" icon={ShieldCheck} onClick={() => app.run(() => api.showVerification(action.site))}>
              {m.common.verify}
            </Button>
          )}
          {action.kind === 'add-page' && (
            <Button size="sm" icon={Plus} onClick={() => onAdding(true)}>
              {m.creator.addPage}
            </Button>
          )}
        </span>
        <IconButton label={expanded ? m.creator.collapse(c.name) : m.creator.expand(c.name)} icon={expanded ? ChevronDown : ChevronRight} size={16} onClick={onToggle} aria-expanded={expanded} />
      </div>

      {progress && (busy || progress.stage === 'error') && !expanded && (
        <p className={`creator-progress small ${progress.stage === 'error' ? 'error-text' : 'muted'}`}>{progress.message}</p>
      )}

      {expanded && <CreatorDetails creator={c} app={app} adding={adding} onAdding={onAdding} onUpdate={onUpdate} />}
    </li>
  );
}

function CreatorDetails({
  creator: c,
  app,
  adding,
  onAdding,
  onUpdate,
}: {
  creator: CreatorResult;
  app: AppModel;
  adding: boolean;
  onAdding: (on: boolean) => void;
  onUpdate: (target: UpdateTarget) => void;
}) {
  const snapshot = app.snapshot!;
  const hideTitles = snapshot.settings.hidePageTitles;
  const progress = app.updates[c.key];
  const busy = progress !== undefined && progress.stage !== 'done' && progress.stage !== 'error';
  const seenUndo = c.status === 'up-to-date' && c.dismissedAt !== undefined && (c.remoteUpdatedAt ?? 0) > c.localUpdatedAt + 86_400_000;
  const muted = c.mutedSources ?? [];
  // Sites turned off for everyone that have a page for this creator (ones turned off just here show in the checkboxes).
  const offEverywhere = muted.filter((s) => snapshot.settings.mutedSources.includes(s));
  const offHere = snapshot.creatorMutedSources[c.key] ?? [];
  const toggleSite = useSiteToggle(app);
  // Their pages and the ones for packs they don't have are listed apart, whether or not the second
  // list is switched on: they need different words and different buttons.
  const pages = ownedRemotes(c.remotes);
  const packs = newPacksFor(c, snapshot);
  const files = newFilesFor(c, snapshot);
  const maybe = maybeUpdatesFor(c, snapshot);
  const ignored = ignoredFilesFor(c, snapshot);
  // Pages the user added that nothing has read yet: reading one straight away can fail (signed out, a
  // challenge), and then only the next check will. Shown, so adding a page never looks like nothing.
  const unread = snapshot.unreadLinks?.[c.key] ?? [];
  // Pages removed with "Not this creator's page" or "Not interested": listed so either can be taken
  // back after its toast is gone. Only their addresses are kept.
  const removed = snapshot.rejectedLinks[c.key] ?? [];
  // What they said archives on these pages are: listed, so an answer can be taken back once its toast is gone.
  const answers = snapshot.fileAnswers?.[c.key] ?? [];
  const toast = useToast();
  const m = t().creator;
  const showPageAgain = async (url: string): Promise<void> => {
    const done = await app.run(() => api.unrejectLink(c.key, url));
    if (!done) return;
    // No "Check now": that checks every creator, a lot of traffic to bring back one page.
    toast({ text: m.shownNextCheck });
  };
  const hiddenPacks = c.remotes.length - pages.length;
  const askAgain = async (a: FileAnswer): Promise<void> => {
    const done = await app.run(() => api.setFileKind(c.key, a.name, null));
    if (!done) return;
    toast({ text: m.willAskAgain, action: { label: t().common.undo, run: () => void app.run(() => api.setFileKind(c.key, a.name, a.kind)) } });
  };

  return (
    <div className="creator-body">
      {/* Only while something is happening, or when it failed. A finished update's message
          stays in app.updates for the rest of the run, and "Already up to date with wicked.cc"
          left under a row that still says "Update ready" reads as a contradiction. */}
      {progress && (busy || progress.stage === 'error') && (
        <p className={`small ${progress.stage === 'error' ? 'error-text' : 'muted'}`} role="status">
          {progress.message}
        </p>
      )}
      <div className="section-label">
        {m.downloadPages}
        {hideTitles && c.remotes.some((r) => r.title) && (
          <span className="faint hint-inline">
            <EyeOff size={14} aria-hidden="true" /> {m.titlesHidden}
          </span>
        )}
      </div>
      {c.remotes.length === 0 && !muted.length && !unread.length ? (
        <p className="muted small">{m.noPages}</p>
      ) : (
        pages.length > 0 && (
          <div className="source-grid">
            {pages.map((r) => (
              <SourceCard key={r.listing.url} remote={r} creator={c} app={app} hideTitle={hideTitles} />
            ))}
          </div>
        )
      )}
      {unread.length > 0 && (
        <ul className="file-list">
          {unread.map((url) => (
            <li key={url}>
              <span className="small grow">{pageLabel(url, hideTitles)}</span>
              <span className="faint small">{m.addedNotRead}</span>
            </li>
          ))}
        </ul>
      )}

      {maybe.length > 0 && (
        <>
          <div className="section-label">{m.mightBeUpdates(maybe.length)}</div>
          <p className="muted small">{m.maybeHint(maybe.length)}</p>
          <div className="source-grid">
            {maybe.map((f) => (
              <MaybeUpdateCard key={`${f.remote.listing.url} ${f.name}`} file={f} creator={c} app={app} hideTitle={hideTitles} onUpdate={onUpdate} />
            ))}
          </div>
        </>
      )}

      {packs.length > 0 && (
        <>
          <div className="section-label">{m.packsYouDontHave}</div>
          <p className="muted small">{m.nothingMatches(packs.length)}</p>
          <div className="source-grid">
            {packs.map((r) => (
              <NewPackCard key={r.listing.url} remote={r} creator={c} app={app} hideTitle={hideTitles} onUpdate={onUpdate} />
            ))}
          </div>
        </>
      )}

      {files.length > 0 && (
        <>
          <div className="section-label">{m.newOnPages(files.length)}</div>
          <p className="muted small">{m.filesAdded(files.length)}</p>
          <div className="source-grid">
            {files.map((f) => (
              <NewFileCard key={`${f.remote.listing.url} ${f.name}`} file={f} creator={c} app={app} hideTitle={hideTitles} onUpdate={onUpdate} />
            ))}
          </div>
        </>
      )}
      {ignored.length > 0 && (
        <p className="muted small off-note">
          <BellOff size={14} aria-hidden="true" />
          <span>
            {ignored.length > 1 ? m.ignoredFiles(ignored.length) : hideTitles ? m.ignoredHiddenFile : m.ignoredFile(ignored[0]!.name)}{' '}
            <button
              type="button"
              className="link-btn accent"
              onClick={() => void app.run(async () => {
                for (const f of ignored) await api.setFileIgnored(c.key, f.name, false);
              })}
            >
              {m.showIgnored(ignored.length)}
            </button>
          </span>
        </p>
      )}
      {answers.length > 0 && (
        <Disclosure summary={m.answers(answers.length)} className="removed-pages">
          <ul className="file-list">
            {answers.map((a) => (
              <li key={a.name}>
                {/* The name is the answer's subject; with page titles hidden it's on hover, as a hidden title is. */}
                <span className="small grow" title={a.name}>
                  {hideTitles ? m.newFileOnPage(SOURCE_LABEL.loverslab) : a.name}
                </span>
                <span className="faint small">{a.kind === 'update' ? m.saidUpdate : m.saidPack}</span>
                <button type="button" className="link-btn accent small" onClick={() => void askAgain(a)}>
                  {m.askAgain}
                </button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {removed.length > 0 && (
        <Disclosure summary={m.pagesHidden(removed.length)} className="removed-pages">
          <p className="muted small">{m.youRemoved(removed.length)}</p>
          <ul className="file-list">
            {removed.map((url) => (
              <li key={url}>
                <span className="small grow">{pageLabel(url, hideTitles)}</span>
                <button type="button" className="link-btn accent small" onClick={() => void showPageAgain(url)}>
                  {m.showAgain}
                </button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {hiddenPacks > 0 && packs.length === 0 && (
        <p className="muted small off-note">
          <PackagePlus size={14} aria-hidden="true" />
          <span>{rich(m.hiddenPacks(hiddenPacks), { setting: <em>{t().settings.newPacks}</em> })}</span>
        </p>
      )}
      {offEverywhere.length > 0 && (
        <p className="muted small off-note">
          <BellOff size={14} aria-hidden="true" />
          <span>{m.offEverywhere(siteNames(offEverywhere))}</span>
        </p>
      )}

      <fieldset className="creator-sites">
        <legend className="muted small">{m.checkFor(c.name)}</legend>
        {UPDATE_SITES.map((site) => {
          const everywhere = snapshot.settings.mutedSources.includes(site);
          return (
            <label key={site} className={`site-check small ${everywhere ? 'faint' : ''}`} title={everywhere ? m.offForEveryone : undefined}>
              <Checkbox
                label={m.checkSiteFor(SOURCE_LABEL[site], c.name)}
                checked={!everywhere && !offHere.includes(site)}
                disabled={everywhere}
                onChange={() => void toggleSite(site, offHere.includes(site), c.key)}
              />
              {SOURCE_LABEL[site]}
            </label>
          );
        })}
      </fieldset>

      {adding && <AddPage creator={c} app={app} onDone={() => onAdding(false)} />}

      <div className="creator-foot">
        {!adding && (
          <Button variant="quiet" size="sm" icon={Plus} onClick={() => onAdding(true)}>
            {m.addDownloadPage}
          </Button>
        )}
        <Disclosure summary={m.yourFiles(c.files.length)} className="files-disclosure">
          <ul className="file-list">
            {c.files.map((f) => (
              <li key={f.path}>
                <button type="button" className="link-btn mono" title={`${t().common.showInFolder}\n${f.path}`} onClick={() => app.run(() => api.showFile(f.path))}>
                  {f.relPath}
                </button>
                <span className="faint small">{formatShortDate(f.mtimeMs)}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
        <span className="spacer" />
        {c.status === 'update-available' && c.remoteUpdatedAt !== undefined && (
          <Button size="sm" onClick={() => app.run(() => api.dismiss(c.key, c.remoteUpdatedAt!))} title={m.markSeenTitle}>
            {t().common.markAsSeen}
          </Button>
        )}
        {seenUndo && (
          <Button variant="quiet" size="sm" icon={RotateCcw} onClick={() => app.run(() => api.undismiss(c.key))}>
            {t().common.undoMarkAsSeen}
          </Button>
        )}
      </div>
    </div>
  );
}

function SourceCard({ remote: r, creator, app, hideTitle }: { remote: RemoteInfo; creator: CreatorResult; app: AppModel; hideTitle: boolean }) {
  const toast = useToast();
  const toggleSite = useSiteToggle(app);
  const label = SOURCE_LABEL[r.listing.source];
  const updateSite = r.listing.source === 'wwmod' ? undefined : r.listing.source;
  const m = t();

  const stopChecking = async (s: UpdateSite): Promise<void> => {
    if (!(await toggleSite(s, false, creator.key))) return;
    toast({
      text: m.creator.stoppedChecking(label, creator.name),
      action: { label: m.common.undo, run: () => void toggleSite(s, true, creator.key) },
    });
  };
  const site = r.listing.source === 'loverslab' || r.listing.source === 'patreon' ? r.listing.source : undefined;
  const problem = r.status !== 'ok';
  const shownTitle = !r.title || hideTitle ? m.common.sitePage(label) : r.title;

  const remove = async (): Promise<void> => {
    const done = await app.run(() => api.rejectLink(creator.key, r.listing.url));
    if (!done) return;
    toast({
      text: m.creator.removedPage(label, creator.name),
      action: { label: m.common.undo, run: () => void app.run(() => api.undoRejectLink(creator.key, r.listing.url)) },
    });
  };

  return (
    <div className={`source-card ${problem ? 'problem' : ''}`}>
      <span className="site-badge" aria-hidden="true">
        {SITE_BADGE[r.listing.source]}
      </span>
      <div className="source-text">
        <span className="source-title">
          {label}
          {r.locked && <Lock size={13} className="faint" aria-label={m.creator.patronsOnly} />}
        </span>
        <span className={`source-sub ${problem ? 'warn-text' : 'faint'}`} title={hideTitle && r.title ? r.title : undefined}>
          {problem ? remoteSummary(r) : shownTitle}
        </span>
      </div>
      <div className="source-meta">
        {!problem && (
          <>
            <span className="faint small">{formatShortDate(r.updatedAt)}</span>
            {/* Sites put whatever they like in the version field — LoversLab hands back things like
                "80_updated_1016_anims - 03/19/25" — so it sits on its own line and is the thing that
                gives way, rather than squeezing the site's name and page title down to nothing. */}
            {r.version && <span className="faint small source-version">{formatVersion(r.version)}</span>}
          </>
        )}
        {r.listing.origin === 'discovered' && <span className="tag">{m.creator.suggested}</span>}
        {r.listing.origin === 'manual' && <span className="tag">{m.creator.addedByYou}</span>}
      </div>
      {r.status === 'needs-verification' && site && (
        <Button size="sm" onClick={() => app.run(() => api.showVerification(site))}>
          {m.common.verify}
        </Button>
      )}
      <IconButton
        label={m.creator.openSitePage(label)}
        icon={ExternalLink}
        size={16}
        onClick={() => app.run(() => api.openExternal(r.listing.url))}
        onContextMenu={linkMenu(app, r.listing.url)}
      />
      <MenuButton
        label={m.creator.moreForSitePage(label)}
        items={[
          { label: m.creator.openPrivately, icon: Copy, onSelect: () => void app.run(() => api.showLinkMenu(r.listing.url)) },
          ...(updateSite ? [{ label: m.creator.dontCheckFor(label, creator.name), icon: BellOff, onSelect: () => void stopChecking(updateSite) }] : []),
          { label: m.creator.notTheirPage, icon: Trash2, danger: true, onSelect: () => void remove() },
        ]}
      />
    </div>
  );
}

/**
 * One pack the user doesn't have. Three things can be done with it and none of
 * them is "update": get it, look at it, or never hear about it again.
 */
function NewPackCard({
  remote: r,
  creator,
  app,
  hideTitle,
  onUpdate,
}: {
  remote: RemoteInfo;
  creator: CreatorResult;
  app: AppModel;
  hideTitle: boolean;
  onUpdate: (target: UpdateTarget) => void;
}) {
  const toast = useToast();
  const snapshot = app.snapshot!;
  const label = SOURCE_LABEL[r.listing.source];
  const m = t();
  const name = !r.title || hideTitle ? m.common.sitePage(label) : r.title;
  const progress = app.updates[creator.key];
  const busy = progress !== undefined && progress.stage !== 'done' && progress.stage !== 'error';
  // A patrons-only post would 403: offer the page, not a button that fails.
  const action = newPackAction(r, snapshot);

  const notInterested = async (): Promise<void> => {
    const done = await app.run(() => api.rejectLink(creator.key, r.listing.url));
    if (!done) return;
    toast({
      text: m.creator.wontMention(hideTitle || !r.title ? m.creator.thatPack : shortTitle(r.title, 40)),
      action: { label: m.common.undo, run: () => void app.run(() => api.undoRejectLink(creator.key, r.listing.url)) },
    });
  };

  return (
    <div className="source-card new-pack">
      <span className="site-badge" aria-hidden="true">
        {SITE_BADGE[r.listing.source]}
      </span>
      <div className="source-text">
        {/* The pack's own name, so nine of a creator's pages aren't nine identical cards. */}
        <span className="source-title" title={name}>
          {name}
          {/* Unreachable while classifyRemotes only reads wicked.cc and `locked` is Patreon's alone.
              Kept with `action` below so that extending classification to Patreon offers the page
              rather than a download button that 403s, which is the point of both. */}
          {r.locked && <Lock size={13} className="faint" aria-label={m.creator.patronsOnly} />}
        </span>
        <span className="source-sub faint">{m.creator.posted(formatShortDate(r.updatedAt))}</span>
      </div>
      <NewPackButton
        action={action}
        creatorKey={creator.key}
        remote={r}
        app={app}
        busy={busy}
        onGet={() => onUpdate({ key: creator.key, name: creator.name, listingUrl: r.listing.url, packName: r.title })}
      />
      <MenuButton
        label={m.creator.moreFor(name)}
        items={[
          ...(action.kind !== 'open' ? [{ label: m.common.openPage, icon: ExternalLink, onSelect: () => void app.run(() => api.openExternal(r.listing.url)) }] : []),
          { label: m.creator.openPrivately, icon: Copy, onSelect: () => void app.run(() => api.showLinkMenu(r.listing.url)) },
          { label: m.creator.notInterested, icon: BellOff, danger: true, onSelect: () => void notInterested() },
        ]}
      />
    </div>
  );
}

/**
 * A file the user doesn't have on a page that also holds their pack (RemoteInfo.newFiles). Unlike
 * a new pack's page, "Not interested" can't remove the page, which would stop following their pack
 * too: it sets this one file aside by name.
 */
function NewFileCard({
  file,
  creator,
  app,
  hideTitle,
  onUpdate,
}: {
  file: NewFile;
  creator: CreatorResult;
  app: AppModel;
  hideTitle: boolean;
  onUpdate: (target: UpdateTarget) => void;
}) {
  const toast = useToast();
  const snapshot = app.snapshot!;
  const r = file.remote;
  const label = SOURCE_LABEL[r.listing.source];
  const m = t();
  // A file name says what's in it, so it follows "Hide page titles" like a page title does.
  const name = hideTitle ? m.creator.newFileOnPage(label) : file.name;
  const progress = app.updates[creator.key];
  const busy = progress !== undefined && progress.stage !== 'done' && progress.stage !== 'error';
  const action = newPackAction(r, snapshot);

  const notInterested = async (): Promise<void> => {
    const done = await app.run(() => api.setFileIgnored(creator.key, file.name, true));
    if (!done) return;
    toast({
      text: m.creator.wontMention(hideTitle ? m.creator.thatFile : shortTitle(file.name, 40)),
      action: { label: m.common.undo, run: () => void app.run(() => api.setFileIgnored(creator.key, file.name, false)) },
    });
  };

  return (
    <div className="source-card new-pack">
      <span className="site-badge" aria-hidden="true">
        {SITE_BADGE[r.listing.source]}
      </span>
      <div className="source-text">
        <span className="source-title" title={name}>
          {name}
        </span>
        <span className="source-sub faint">{m.creator.posted(formatShortDate(file.updatedAt))}</span>
      </div>
      <NewPackButton
        action={action}
        creatorKey={creator.key}
        remote={r}
        app={app}
        busy={busy}
        // The page holds their pack and its variants too: download this one file, nothing else.
        onGet={() => onUpdate({ key: creator.key, name: creator.name, listingUrl: r.listing.url, packName: hideTitle ? undefined : file.name, fileName: file.name })}
      />
      <MenuButton
        label={m.creator.moreFor(name)}
        items={[
          ...(action.kind !== 'open' ? [{ label: m.common.openPage, icon: ExternalLink, onSelect: () => void app.run(() => api.openExternal(r.listing.url)) }] : []),
          { label: m.creator.openPrivately, icon: Copy, onSelect: () => void app.run(() => api.showLinkMenu(r.listing.url)) },
          { label: m.creator.notInterested, icon: BellOff, danger: true, onSelect: () => void notInterested() },
        ]}
      />
    </div>
  );
}

/**
 * An archive on a page of theirs, newer than their files, that could be their pack re-uploaded or a
 * pack of its own (RemoteInfo.newFiles, `archive`). Its name is what tells them apart, and only the
 * user can read it that way: they say which. An update opens the Update window, as the row's button
 * would; a pack joins "New on a page of theirs".
 */
function MaybeUpdateCard({
  file,
  creator,
  app,
  hideTitle,
  onUpdate,
}: {
  file: NewFile;
  creator: CreatorResult;
  app: AppModel;
  hideTitle: boolean;
  onUpdate: (target: UpdateTarget) => void;
}) {
  const toast = useToast();
  const snapshot = app.snapshot!;
  const r = file.remote;
  const label = SOURCE_LABEL[r.listing.source];
  const m = t();
  // Hidden like a page title, but the name is the whole question: it's on hover, as a hidden title is.
  const name = hideTitle ? m.creator.newFileOnPage(label) : file.name;
  const progress = app.updates[creator.key];
  const busy = progress !== undefined && progress.stage !== 'done' && progress.stage !== 'error';

  const choose = async (kind: 'update' | 'pack'): Promise<void> => {
    const done = await app.run(() => api.setFileKind(creator.key, file.name, kind));
    if (!done) return;
    toast({
      // With packs they don't have hidden, a pack isn't listed anywhere: don't say it is.
      text: kind === 'update' ? m.creator.countedAsUpdate : snapshot.settings.showNewPacks ? m.creator.listedAsPack : m.creator.notCountedAsUpdate,
      action: { label: m.common.undo, run: () => void app.run(() => api.setFileKind(creator.key, file.name, null)) },
    });
    // Straight to the update, as the row's Update button would; after a check, when that's greyed out.
    // Signed out, the window could only fail: the row's own button says what's needed instead.
    if (kind === 'update' && !snapshot.running && newPackAction(r, snapshot).kind === 'get') onUpdate({ key: creator.key, name: creator.name });
  };

  const notInterested = async (): Promise<void> => {
    const done = await app.run(() => api.setFileIgnored(creator.key, file.name, true));
    if (!done) return;
    toast({
      text: m.creator.wontMention(hideTitle ? m.creator.thatFile : shortTitle(file.name, 40)),
      action: { label: m.common.undo, run: () => void app.run(() => api.setFileIgnored(creator.key, file.name, false)) },
    });
  };

  return (
    <div className="source-card new-pack">
      <span className="site-badge" aria-hidden="true">
        {SITE_BADGE[r.listing.source]}
      </span>
      <div className="source-text">
        <span className="source-title" title={file.name}>
          {name}
        </span>
        <span className="source-sub faint">{m.creator.posted(formatShortDate(file.updatedAt))}</span>
      </div>
      <Button size="sm" onClick={() => void choose('update')} disabled={busy}>
        {m.creator.itsAnUpdate}
      </Button>
      <Button size="sm" variant="quiet" onClick={() => void choose('pack')} disabled={busy}>
        {m.creator.itsAPack}
      </Button>
      <MenuButton
        label={m.creator.moreFor(name)}
        items={[
          { label: m.common.openPage, icon: ExternalLink, onSelect: () => void app.run(() => api.openExternal(r.listing.url)) },
          { label: m.creator.openPrivately, icon: Copy, onSelect: () => void app.run(() => api.showLinkMenu(r.listing.url)) },
          { label: m.creator.notInterested, icon: BellOff, danger: true, onSelect: () => void notInterested() },
        ]}
      />
    </div>
  );
}

/**
 * The button on a card for something new on a page: Get it, or what stands in its way. Signed out,
 * it signs in (the card redraws as Get it once that's done); for anything else, the page to open.
 */
function NewPackButton({
  action,
  creatorKey,
  remote,
  app,
  busy,
  onGet,
}: {
  action: NewPackAction;
  creatorKey: string;
  remote: RemoteInfo;
  app: AppModel;
  busy: boolean;
  onGet: () => void;
}) {
  const running = app.snapshot?.running;
  const m = t();
  if (action.kind === 'get') {
    return (
      <Button size="sm" icon={Download} disabled={busy || running} title={running ? afterCheck() : undefined} onClick={onGet}>
        {m.creator.getIt}
      </Button>
    );
  }
  if (action.kind === 'checking') {
    return (
      <Button size="sm" disabled>
        <Spinner size={14} /> {m.settings.checkingEllipsis}
      </Button>
    );
  }
  if (action.kind === 'recheck') {
    return (
      <Button
        size="sm"
        icon={RefreshCw}
        disabled={running}
        title={running ? afterCheck() : undefined}
        onClick={() => app.run(() => api.recheckPatreon(creatorKey, remote.listing.url))}
      >
        {m.common.checkAgain}
      </Button>
    );
  }
  if (action.kind === 'sign-in') {
    return (
      <Button size="sm" icon={LogIn} onClick={() => app.run(() => api.signIn(action.site))}>
        {m.common.signInTo(SOURCE_LABEL[action.site])}
      </Button>
    );
  }
  // Patrons-only, or no download to be had: a download button here would only ever fail.
  return (
    <Button size="sm" icon={ExternalLink} onClick={() => app.run(() => api.openExternal(remote.listing.url))} onContextMenu={linkMenu(app, remote.listing.url)}>
      {m.common.openPage}
    </Button>
  );
}

function AddPage({ creator, app, onDone }: { creator: CreatorResult; app: AppModel; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (await app.run(() => api.addLink(creator.key, url.trim()))) {
      setUrl('');
      onDone();
    }
  };

  return (
    <form className="add-page" onSubmit={submit}>
      <label className="visually-hidden" htmlFor={`add-${creator.key}`}>
        {t().creator.downloadPageFor(creator.name)}
      </label>
      <input
        id={`add-${creator.key}`}
        ref={input}
        type="url"
        placeholder={t().creator.pastePage}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onDone();
          }
        }}
      />
      <Button type="submit" size="sm" disabled={!url.trim()}>
        {t().creator.add}
      </Button>
      <Button variant="quiet" size="sm" onClick={onDone}>
        {t().common.cancel}
      </Button>
    </form>
  );
}

/** Right-click on any link button: open in a private window, or copy. */
export function linkMenu(app: AppModel, url: string) {
  return (e: { preventDefault: () => void }): void => {
    e.preventDefault();
    void app.run(() => api.showLinkMenu(url));
  };
}
