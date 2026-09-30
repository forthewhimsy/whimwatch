import { Ban, CheckCircle2, Circle, Download, History, Info, ListChecks, LogIn, MinusCircle, RotateCcw, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { BatchItem, BatchItemState, BrowserSite, ReviewChoice } from '../../shared/api';
import { t } from '../../shared/i18n';
import { Dialog, useConfirm } from './dialog';
import { afterCheck, type Candidate, type Ineligible } from './eligibility';
import { SOURCE_LABEL } from './format';
import { useToast } from './toast';
import { api, type AppModel } from './useApp';
import { FileLine, toggle } from './UpdateDialog';
import { Banner, Button, Checkbox, Disclosure, Spinner } from './ui';

const STATE_ICON: Record<Exclude<BatchItemState, 'working'>, typeof Circle> = {
  queued: Circle,
  review: ListChecks,
  done: CheckCircle2,
  failed: XCircle,
  cancelled: MinusCircle,
};

/**
 * Picks which updates to install, shows progress, then sums up. Closing it
 * while it runs doesn't stop anything ("Run in background"). Updates that add
 * files the user doesn't have wait for them to choose those files (the review),
 * and closing it then leaves them waiting.
 */
export function UpdateAllDialog({
  app,
  eligible,
  ineligible,
  onClose,
  onShowHistory,
}: {
  app: AppModel;
  eligible: Candidate[];
  ineligible: Ineligible[];
  onClose: () => void;
  onShowHistory: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const batch = app.batch;
  const reviewing = batch?.items.filter((i) => i.state === 'review') ?? [];
  const [started, setStarted] = useState(Boolean(batch?.running || reviewing.length));
  const [unticked, setUnticked] = useState<string[]>([]);
  /** Files unticked in the review, by creator key; until touched, the ones skipped before. */
  const [reviewSkips, setReviewSkips] = useState<Record<string, string[]>>({});
  const [always, setAlways] = useState<string[]>([]);
  const selected = eligible.filter((c) => !unticked.includes(c.key));

  const start = async (): Promise<void> => {
    const ok = await app.run(async () => {
      await api.updateAll(selected.map((c) => c.key));
      return true;
    });
    if (ok) setStarted(true);
  };

  const phase = !started || !batch ? 'pick' : batch.running ? 'running' : reviewing.length ? 'review' : 'done';
  const finished = batch?.items.filter((i) => i.state === 'done' || i.state === 'failed').length ?? 0;
  const installed = batch?.items.filter((i) => i.state === 'done' && i.replaced !== undefined) ?? [];
  const failed = batch?.items.filter((i) => i.state === 'failed') ?? [];
  // Left for later or never started: not current, so "everything you picked is current" would be wrong.
  const notDone = batch?.items.some((i) => i.state === 'cancelled') ?? false;
  const signInSites = [...new Set(ineligible.flatMap((i) => (i.signIn ? [i.signIn] : [])))];
  const m = t().updateAll;

  const undoAll = async (): Promise<void> => {
    if (!batch?.batchId) return;
    const ok = await confirm({
      title: m.undoTitle(installed.length),
      body: m.undoBody,
      confirmLabel: t().common.undoAll,
      cancelLabel: t().common.dontUndo,
    });
    if (!ok) return;
    if (await app.run(() => api.undoBatch(batch.batchId!))) {
      toast({ text: m.undid(installed.length) });
      onClose();
    }
  };

  if (phase === 'pick') {
    const allTicked = unticked.length === 0;
    return (
      <Dialog
        title={m.title}
        subtitle={m.intro}
        onClose={onClose}
        width={600}
        footer={
          <>
            <span className="spacer" />
            <Button variant="quiet" onClick={onClose}>
              {t().common.cancel}
            </Button>
            <Button variant="primary" icon={Download} onClick={start} disabled={!selected.length || app.snapshot?.running}
              title={app.snapshot?.running ? afterCheck() : undefined}
            >
              {m.updateN(selected.length)}
            </Button>
          </>
        }
      >
        <div className="list-head compact">
          <span className="section-label">{m.willUpdate(selected.length)}</span>
          <span className="spacer" />
          <button type="button" className="link-btn accent" onClick={() => setUnticked(allTicked ? eligible.map((c) => c.key) : [])}>
            {allTicked ? m.selectNone : m.selectAll}
          </button>
        </div>
        <ul className="pick-list">
          {eligible.map((c) => (
            <li key={c.key}>
              <label className="pick-line">
                <Checkbox
                  checked={!unticked.includes(c.key)}
                  onChange={() => setUnticked((prev) => (prev.includes(c.key) ? prev.filter((k) => k !== c.key) : [...prev, c.key]))}
                  label={m.updateOne(c.name)}
                />
                <span className="pick-name">{c.name}</span>
                <span className="faint">{t().common.from(c.source)}</span>
              </label>
            </li>
          ))}
        </ul>
        {ineligible.length > 0 && <LeftOut ineligible={ineligible} sites={signInSites} app={app} />}
      </Dialog>
    );
  }

  if (phase === 'review') {
    const skipsOf = (item: BatchItem): string[] => reviewSkips[item.key] ?? item.review?.startUnticked ?? [];
    const addsOf = (item: BatchItem): string[] => item.review?.files.filter((f) => f.kind === 'add').map((f) => f.target) ?? [];
    // Add all: every new file ticked, leaving what they unticked among the replacements as it is.
    const addAll = (item: BatchItem): void =>
      setReviewSkips((prev) => ({ ...prev, [item.key]: skipsOf(item).filter((target) => !addsOf(item).includes(target)) }));
    const choices: ReviewChoice[] = reviewing
      .filter((item) => item.review?.files.some((f) => !skipsOf(item).includes(f.target)))
      .map((item) => ({ key: item.key, skip: skipsOf(item), always: always.includes(item.key) }));
    const finished = batch!.items.filter((i) => i.state !== 'review');
    const finish = (chosen: ReviewChoice[]): Promise<unknown> => app.run(() => api.finishReview(chosen));
    const u = t().update;
    return (
      <Dialog
        title={m.reviewTitle(reviewing.length)}
        subtitle={m.reviewIntro}
        onClose={onClose}
        width={640}
        footer={
          <>
            <Button variant="quiet" onClick={() => finish([])}>
              {m.notNow}
            </Button>
            <span className="spacer" />
            <Button
              variant="primary"
              icon={Download}
              onClick={() => finish(choices)}
              disabled={!choices.length || app.snapshot?.running}
              title={app.snapshot?.running ? afterCheck() : undefined}
            >
              {m.installN(choices.length)}
            </Button>
          </>
        }
      >
        {finished.length > 0 && (
          <Disclosure summary={m.othersN(finished.length)}>
            <BatchList items={finished} app={app} summary />
          </Disclosure>
        )}
        <div className="review-list">
          {reviewing.map((item) => {
            const files = item.review?.files ?? [];
            const skip = skipsOf(item);
            const adds = files.filter((f) => f.kind === 'add');
            return (
              <section key={item.key} className="file-changes" aria-label={item.name}>
                <div className="review-head">
                  <span className="pick-name">{item.name}</span>
                  {item.source && <span className="faint">{t().common.from(item.source)}</span>}
                  <span className="spacer" />
                  {adds.some((f) => skip.includes(f.target)) && (
                    <button type="button" className="link-btn accent" onClick={() => addAll(item)}>
                      {m.addAll}
                    </button>
                  )}
                </div>
                {(
                  [
                    [files.filter((f) => f.kind === 'replace'), u.replacesYours],
                    [adds, u.newFiles],
                  ] as const
                ).map(
                  ([list, heading]) =>
                    list.length > 0 && (
                      <div key={list[0]!.kind} className="file-section">
                        <div className="section-label">{heading(list.length)}</div>
                        {list.map((f) => (
                          <FileLine
                            key={f.target}
                            kind={f.kind}
                            path={f.target}
                            replaces={f.replaces}
                            checked={!skip.includes(f.target)}
                            onToggle={() => setReviewSkips((prev) => ({ ...prev, [item.key]: toggle(skip, f.target) }))}
                            note={item.review?.startUnticked?.includes(f.target) ? u.skippedBefore : undefined}
                          />
                        ))}
                      </div>
                    ),
                )}
                <label className="pick-line review-always">
                  <Checkbox checked={always.includes(item.key)} onChange={() => setAlways((prev) => toggle(prev, item.key))} label={m.alwaysAdd(item.name)} />
                  <span className="small">{m.alwaysAdd(item.name)}</span>
                </label>
              </section>
            );
          })}
        </div>
      </Dialog>
    );
  }

  if (phase === 'running') {
    return (
      <Dialog
        title={m.updatingNofM(Math.min(finished + 1, batch!.items.length), batch!.items.length)}
        subtitle={batch!.stopRequested ? m.stopping : m.keepUsing}
        onClose={onClose}
        width={600}
        footer={
          <>
            <Button variant="quiet" onClick={() => app.run(() => api.stopUpdateAll())} disabled={batch!.stopRequested}>
              {m.stopAfterThis}
            </Button>
            <Button variant="quiet" onClick={() => app.run(() => api.cancelUpdateAll())}>
              {m.cancelNow}
            </Button>
            <span className="spacer" />
            <Button variant="primary" onClick={onClose}>
              {m.background}
            </Button>
          </>
        }
      >
        <BatchList items={batch!.items} app={app} />
      </Dialog>
    );
  }

  const title = installed.length
    ? failed.length
      ? m.packsUpdatedFailed(installed.length, failed.length)
      : m.packsUpdated(installed.length)
    : failed.length
      ? m.nothingUpdated
      : m.finished;
  const keepDays = app.snapshot?.settings.keepBackupsDays ?? 0;

  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={600}
      className="done-dialog"
      footer={
        <>
          {installed.length > 0 && batch?.batchId && (
            <Button variant="quiet" icon={RotateCcw} onClick={undoAll}>
              {t().common.undoAll}
            </Button>
          )}
          <span className="spacer" />
          <Button
            icon={History}
            onClick={() => {
              onClose();
              onShowHistory();
            }}
          >
            {m.viewHistory}
          </Button>
          <Button variant="primary" onClick={onClose} data-autofocus>
            {m.done}
          </Button>
        </>
      }
    >
      <div className="done-hero">
        <span className={`tone-icon round big ${installed.length ? 'mint' : 'amber'}`}>
          {installed.length ? <CheckCircle2 size={26} aria-hidden="true" /> : <Ban size={24} aria-hidden="true" />}
        </span>
        {installed.length > 0 && (
          <p className="muted">
            {notDone ? '' : failed.length ? m.restCurrent : m.allCurrent} {keepDays > 0 ? m.backedUpDays(keepDays) : m.backedUpUntilDeleted}
          </p>
        )}
      </div>
      <BatchList items={batch!.items} app={app} summary />
      {ineligible.length > 0 && <LeftOut ineligible={ineligible} sites={signInSites} app={app} />}
    </Dialog>
  );
}

function BatchList({ items, app, summary }: { items: BatchItem[]; app: AppModel; summary?: boolean }) {
  const m = t().updateAll;
  return (
    <ul className="batch-list">
      {items.map((item) => {
        const IconComponent = item.state === 'working' ? undefined : STATE_ICON[item.state];
        const detail =
          item.state === 'working'
            ? (app.updates[item.key]?.message ?? m.starting)
            : item.state === 'queued'
              ? m.waiting
              : item.state === 'cancelled'
                ? (item.message ?? m.notStarted)
                : summary && item.state === 'done' && item.replaced !== undefined
                  ? [item.replaced && m.replacedN(item.replaced), item.added && (item.addedNames?.length ? m.addedNames(item.addedNames) : m.addedN(item.added))]
                      .filter(Boolean)
                      .join(' · ') || m.installed
                  : item.message;
        return (
          <li key={item.key} className={`batch-item state-${item.state}`}>
            <span className="batch-icon">{IconComponent ? <IconComponent size={18} aria-hidden="true" /> : <Spinner size={18} />}</span>
            <span className="batch-name">
              {item.name}
              {item.source && <span className="faint"> {t().common.from(item.source)}</span>}
            </span>
            <span className={`batch-detail small ${item.state === 'failed' ? 'error-text' : 'faint'}`}>{detail}</span>
            <span className="visually-hidden">{m.state[item.state]}</span>
          </li>
        );
      })}
    </ul>
  );
}

function LeftOut({ ineligible, sites, app }: { ineligible: Ineligible[]; sites: BrowserSite[]; app: AppModel }) {
  return (
    <Banner
      tone="info"
      title={t().updateAll.leftOut(ineligible.length)}
      actions={sites.map((site) => (
        <Button key={site} size="sm" icon={LogIn} onClick={() => app.run(() => api.signIn(site))}>
          {t().common.signInTo(SOURCE_LABEL[site])}
        </Button>
      ))}
    >
      <ul className="plain-list small">
        {ineligible.map((c) => (
          <li key={c.key}>
            <strong>{c.name}</strong> <span className="muted">· {c.reason}</span>
          </li>
        ))}
      </ul>
      <p className="faint small">
        <Info size={12} aria-hidden="true" /> {t().updateAll.doItYourself}
      </p>
    </Banner>
  );
}
