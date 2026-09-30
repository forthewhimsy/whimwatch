import { AlertTriangle, ArrowDownUp, ArrowUpCircle, Boxes, CheckCircle2, Download, Info, ShieldCheck } from 'lucide-react';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import type { BrowserSite } from '../../shared/api';
import { t } from '../../shared/i18n';
import type { CreatorResult } from '../../shared/types';
import { CreatorList, type Row } from './CreatorList';
import { useConfirm } from './dialog';
import { afterCheck, CORE_KEY, rowStatus, sortCreators, type SortOrder, updateCandidates } from './eligibility';
import { formatCount, SOURCE_LABEL, timeAgo } from './format';
import { OtherFilesDialog } from './OtherFiles';
import { PlayCard } from './PlayCard';
import type { UpdateTarget } from './UpdateDialog';
import { api, type AppModel } from './useApp';
import { Banner, Button, Spinner } from './ui';

type Filter = 'updates' | 'attention' | 'current' | 'all';

const FILTERS: { id: Filter; icon: typeof ArrowUpCircle; match: (c: CreatorResult) => boolean }[] = [
  { id: 'updates', icon: ArrowUpCircle, match: (c) => rowStatus(c) === 'update' },
  { id: 'attention', icon: AlertTriangle, match: (c) => ['verify', 'missing', 'failed'].includes(rowStatus(c)) },
  { id: 'current', icon: CheckCircle2, match: (c) => rowStatus(c) === 'current' },
  { id: 'all', icon: Boxes, match: () => true },
];

export function Home({
  app,
  query,
  onClearQuery,
  onUpdate,
  onUpdateAll,
  onReport,
}: {
  app: AppModel;
  query: string;
  onClearQuery: () => void;
  onUpdate: (target: UpdateTarget) => void;
  onUpdateAll: () => void;
  onReport: (form: 'bug_report' | 'site_changed') => void;
}) {
  const snapshot = app.snapshot!;
  const confirm = useConfirm();
  const result = snapshot.lastResult;
  const running = snapshot.running;
  const [sort, setSort] = useState<SortOrder>('newest');
  const [showOther, setShowOther] = useState(false);
  const verification = (state: 'needed' | 'passed'): BrowserSite[] =>
    (Object.keys(app.verification) as BrowserSite[]).filter((site) => app.verification[site] === state);

  // Rows keep their last status while a check runs; results replace them as each creator finishes.
  const rows = useMemo<Row[]>(() => {
    const previous = result?.creators ?? [];
    if (!running) return previous.map((creator) => ({ creator, pending: false }));
    const merged = new Map<string, Row>(previous.map((c) => [c.key, { creator: c, pending: true }]));
    for (const c of Object.values(app.live)) merged.set(c.key, { creator: c, pending: false });
    return [...merged.values()];
  }, [result, running, app.live]);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, rows.filter((r) => f.match(r.creator)).length])) as Record<Filter, number>,
    [rows],
  );

  // The filter follows the results only until the user picks one, and never changes mid-check.
  const [picked, setPicked] = useState<Filter>();
  const [settledFilter, setSettledFilter] = useState<Filter>(() => (counts.updates > 0 ? 'updates' : 'all'));
  const [wasRunning, setWasRunning] = useState(running);
  if (wasRunning !== running) {
    setWasRunning(running);
    if (!running && !picked) setSettledFilter(counts.updates > 0 ? 'updates' : 'all');
  }
  const filter = picked ?? settledFilter;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = FILTERS.find((f) => f.id === filter)!.match;
    const list = rows.filter(
      (r) => match(r.creator) && (!q || r.creator.name.toLowerCase().includes(q) || r.creator.files.some((f) => f.relPath.toLowerCase().includes(q))),
    );
    const byKey = new Map(list.map((r) => [r.creator.key, r]));
    return sortCreators(
      list.map((r) => r.creator),
      sort,
    ).map((c) => byKey.get(c.key)!);
  }, [rows, filter, query, sort]);

  const candidates = updateCandidates(result?.core, running ? [] : rows.map((r) => r.creator), snapshot);
  const updates = counts.updates + (result?.core.status === 'update-available' ? 1 : 0);
  /** Updates from the last Update all waiting for their files to be chosen. */
  const waiting = app.batch?.running ? 0 : (app.batch?.items.filter((i) => i.state === 'review').length ?? 0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onTabKey = (e: KeyboardEvent, index: number): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + FILTERS.length) % FILTERS.length;
    tabs.current[next]?.focus();
    setPicked(FILTERS[next]!.id);
  };

  const m = t().home;
  const markAllSeen = async (): Promise<void> => {
    const ok = await confirm({
      title: m.markAllTitle(updates),
      body: m.markAllBody,
      confirmLabel: t().common.markAsSeen,
    });
    if (ok) await app.run(() => api.dismissAll());
  };

  const checkedText = running
    ? m.checking
    : result
      ? (snapshot.firstCheckNotice ? m.firstChecked : m.checked)(timeAgo(result.finishedAt))
      : '';

  return (
    <main className="content" id="main">
      <div className="content-inner">
        {app.error && (
          <Banner tone="error" onClose={() => app.setError(undefined)}>
            {app.error}
          </Banner>
        )}
        {!running && snapshot.checkMessage?.tone === 'error' && (
          <Banner
            tone="error"
            title={m.checkDidntFinish}
            actions={
              <Button size="sm" onClick={() => onReport('site_changed')}>
                {m.reportSiteProblem}
              </Button>
            }
          >
            {snapshot.checkMessage.text}
          </Banner>
        )}

        <div className="counts" role="tablist" aria-label={m.showCreators}>
          {FILTERS.map((f, i) => {
            const IconComponent = f.icon;
            return (
              <button
                key={f.id}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                tabIndex={filter === f.id ? 0 : -1}
                className={`count-tab count-${f.id} ${filter === f.id ? 'active' : ''}`}
                onClick={() => setPicked(f.id)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                <span className="count-icon">
                  <IconComponent size={18} aria-hidden="true" />
                </span>
                <span className="count-text">
                  <span className="count-number">{formatCount(counts[f.id])}</span>
                  <span className="count-label">{m.filter[f.id]}</span>
                </span>
              </button>
            );
          })}
          <span className="spacer" />
          <span className="faint small">{checkedText}</span>
        </div>

        {result && <PlayCard core={result.core} game={result.game} app={app} onUpdate={() => onUpdate({ key: CORE_KEY, name: 'WickedWhims' })} />}

        {snapshot.firstCheckNotice && !running && counts.updates > 0 && (
          <section className="card first-check" aria-labelledby="first-check-title">
            <span className="tone-icon round accent">
              <Info size={20} aria-hidden="true" />
            </span>
            <div className="first-check-copy">
              <h2 id="first-check-title">{m.firstCheckTitle}</h2>
              <p className="muted">{m.firstCheckBody}</p>
            </div>
            <div className="first-check-actions">
              <Button variant="primary" onClick={() => app.run(() => api.dismissAll())}>
                {t().common.markAllAsSeen}
              </Button>
              <Button variant="quiet" onClick={() => app.run(() => api.dismissFirstCheckNotice())}>
                {m.reviewOneByOne}
              </Button>
            </div>
          </section>
        )}

        {verification('needed').map((site) => (
          <Banner
            key={site}
            tone="warn"
            title={m.verifyTitle(SOURCE_LABEL[site])}
            onClose={() => app.clearVerification(site)}
            actions={
              // The banner stays until the check is passed (or the user closes it), so a window
              // closed too early can be opened again.
              <Button size="sm" icon={ShieldCheck} onClick={() => app.run(() => api.showVerification(site))}>
                {t().common.verify}
              </Button>
            }
          >
            {m.verifyBody(running)}
          </Banner>
        ))}

        {verification('passed').map((site) => (
          <Banner
            key={`passed-${site}`}
            tone="ok"
            title={m.verifiedTitle(SOURCE_LABEL[site])}
            onClose={() => app.clearVerification(site)}
            actions={
              running ? undefined : (
                <Button size="sm" icon={ArrowUpCircle} onClick={() => app.run(() => api.startCheck())}>
                  {t().common.checkAgain}
                </Button>
              )
            }
          >
            {running ? m.verifiedRunning(SOURCE_LABEL[site]) : m.verifiedIdle(SOURCE_LABEL[site])}
          </Banner>
        ))}

        {rows.length > 0 || running ? (
          <>
            <div className="list-head">
              <h2>{m.listTitle[filter](visible.length)}</h2>
              <span className="spacer" />
              <label className="sort">
                <ArrowDownUp size={15} aria-hidden="true" />
                <span className="visually-hidden">{m.sortBy}</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as SortOrder)}>
                  <option value="newest">{m.sort.newest}</option>
                  <option value="outdated">{m.sort.outdated}</option>
                  <option value="name">{m.sort.name}</option>
                </select>
              </label>
              {filter === 'updates' && updates > 0 && !running && !app.batch?.running && (
                <Button variant="quiet" onClick={markAllSeen}>
                  {t().common.markAllAsSeen}
                </Button>
              )}
              {(candidates.eligible.length > 0 || app.batch?.running || waiting > 0) && (
                // Updates waiting for their files to be chosen can be looked at during a check; only installing waits.
                <Button variant="primary" icon={Download} onClick={onUpdateAll} disabled={running && !waiting} title={running && !waiting ? afterCheck() : undefined}>
                  {app.batch?.running ? m.updating : waiting ? t().updateAll.reviewTitle(waiting) : m.updateAll(candidates.eligible.length)}
                </Button>
              )}
            </div>
            {visible.length > 0 ? (
              <CreatorList rows={visible} app={app} onUpdate={onUpdate} />
            ) : query.trim() ? (
              <div className="empty card">
                <p>{filter !== 'all' ? m.noMatchHere(query.trim()) : m.noMatch(query.trim())}</p>
                {filter !== 'all' ? (
                  <Button onClick={() => setPicked('all')}>{m.searchAll}</Button>
                ) : (
                  <Button onClick={onClearQuery}>{m.clearSearch}</Button>
                )}
              </div>
            ) : running ? (
              <div className="empty card">
                <Spinner size={22} />
                <p>{m.appearAsChecked}</p>
              </div>
            ) : (
              <div className="empty card">
                <CheckCircle2 size={22} className="mint" aria-hidden="true" />
                <p>{m.empty[filter]}</p>
                {filter !== 'all' && counts.all > 0 && <Button onClick={() => setPicked('all')}>{m.showAll}</Button>}
              </div>
            )}
          </>
        ) : (
          !result && (
            <div className="empty card">
              <p>{m.noResults}</p>
              <Button variant="primary" onClick={() => app.run(() => api.startCheck())}>
                {t().common.checkNow}
              </Button>
            </div>
          )
        )}

        {result && result.unrecognizedCount > 0 && (
          <footer className="other-line faint small">
            {m.otherFiles(result.unrecognizedCount)}{' '}
            <button type="button" className="link-btn" onClick={() => setShowOther(true)}>
              {m.showThem}
            </button>
          </footer>
        )}
      </div>
      {showOther && result && <OtherFilesDialog app={app} count={result.unrecognizedCount} onClose={() => setShowOther(false)} />}
    </main>
  );
}
