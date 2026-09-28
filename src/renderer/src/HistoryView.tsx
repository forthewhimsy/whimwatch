import { ArrowLeft, CopyMinus, Database, Download, EyeOff, FolderOpen, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { StorageInfo } from '../../shared/api';
import { list, t } from '../../shared/i18n';
import { useConfirm } from './dialog';
import { formatBytes, formatShortDate, formatTime, SOURCE_LABEL } from './format';
import {
  dayLabel,
  fileCounts,
  type HistoryFilter,
  type HistoryItem,
  historyItems,
  isNewPackInstall,
  isUndone,
  matchesFilter,
  undoRestoresFiles,
} from './history';
import { rich } from './rich';
import { useToast } from './toast';
import { api, type AppModel } from './useApp';
import { Button, Disclosure, IconButton, Segmented } from './ui';

/** Every change WhimWatch made, with undo: the safety net, out of Settings and in plain view. */
export function HistoryView({ app, onBack, onBackupSettings }: { app: AppModel; onBack: () => void; onBackupSettings: () => void }) {
  const snapshot = app.snapshot!;
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [storage, setStorage] = useState<StorageInfo>();
  const items = useMemo(() => historyItems(snapshot.installs, snapshot.seenHistory), [snapshot.installs, snapshot.seenHistory]);
  const shown = items.filter((i) => matchesFilter(i, filter));

  useEffect(() => {
    api.getStorage().then(setStorage, () => undefined);
  }, [snapshot.installs]);

  const groups: { label: string; items: HistoryItem[] }[] = [];
  for (const item of shown) {
    const label = dayLabel(item.at);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  const keep = snapshot.settings.keepBackupsDays;
  const m = t().history;

  return (
    <main className="content" id="main">
      <div className="content-inner narrow">
        <button type="button" className="back-link" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" /> {m.back}
        </button>
        <div className="page-head">
          <div>
            <h1>{t().common.history}</h1>
            <p className="muted">{m.intro}</p>
          </div>
          <div className="card backup-summary">
            <Database size={16} aria-hidden="true" />
            <span className="muted">
              {rich(m.backupsUse, { size: <strong>{storage ? formatBytes(storage.backups) : '…'}</strong> })} · {keep > 0 ? m.keptDays(keep) : m.keptUntilDeleted}
            </span>
            <Button variant="quiet" size="sm" onClick={onBackupSettings}>
              {t().common.change}
            </Button>
          </div>
        </div>

        <Segmented<HistoryFilter>
          label={m.show}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: m.filter.all },
            { value: 'updates', label: m.filter.updates },
            { value: 'seen', label: m.filter.seen },
            { value: 'undone', label: m.filter.undone },
          ]}
        />

        {groups.length === 0 ? (
          <div className="empty card">
            <p>{filter === 'all' ? m.empty : m.emptyFiltered}</p>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.label} className="history-group" aria-label={g.label}>
              <h2 className="section-label">{g.label}</h2>
              <ul className="card history-list">
                {g.items.map((item) => (
                  <HistoryEntry key={`${item.kind}-${item.id}`} item={item} app={app} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </main>
  );
}

function HistoryEntry({ item, app }: { item: HistoryItem; app: AppModel }) {
  const confirm = useConfirm();
  const toast = useToast();
  const undone = isUndone(item);
  const m = t().history;

  if (item.kind === 'seen') {
    const { event } = item;
    // One click on one creator can mark several of its packs, so count creators rather than marks.
    const names = [...new Set(event.entries.map((e) => e.name))];
    const title = names.length === 1 ? m.markedSeen(names[0]!) : m.markedSeenN(names.length);
    const detail = undone
      ? `${m.undoneOn(formatShortDate(event.undoneAt))} · ${m.updatesAgain}`
      : `${event.automatic ? m.downloadMatched : event.kind === 'all' ? m.markAll : m.hiddenUntilNewer} · ${formatTime(event.at)}`;
    return (
      <li className={`history-item ${undone ? 'undone' : ''}`}>
        <span className="history-icon">
          <EyeOff size={18} aria-hidden="true" />
        </span>
        <div className="history-text">
          <span className="history-title">
            {title} {undone && <span className="tag">{m.undone}</span>}
            {event.automatic && !undone && <span className="tag">{m.automatic}</span>}
          </span>
          <span className="faint small">{detail}</span>
          {event.entries.length > 1 && (
            <Disclosure summary={m.whichOnes} className="history-more">
              <p className="muted small">{event.entries.map((e) => e.name).join(', ')}</p>
            </Disclosure>
          )}
        </div>
        {!undone && (
          <Button size="sm" icon={RotateCcw} onClick={() => app.run(() => api.undoSeen(event.id))}>
            {t().common.undo}
          </Button>
        )}
      </li>
    );
  }

  const records = item.kind === 'batch' ? item.records : [item.record];
  const live = records.filter((r) => !r.undoneAt && !r.backupDeletedAt);
  const counts = fileCounts(records);
  const files = list(
    [counts.replaced && m.filesReplaced(counts.replaced), counts.added && m.filesAdded(counts.added), counts.removed && m.filesRemoved(counts.removed)].filter(
      (part): part is string => Boolean(part),
    ),
    'unit',
  );
  const automatic = records.some((r) => r.automatic);
  const first = records[0]!;
  // A pack they went and got, rather than an update to something they had.
  const newPack = isNewPackInstall(item);
  const site = first.source && SOURCE_LABEL[first.source];
  // Duplicate files removed from Settings → Tools: no creator, and only removals.
  const cleanup = first.cleanup === true;
  const title = cleanup
    ? m.removedDuplicates(counts.removed)
    : item.kind === 'batch'
      ? m.updatedPacks(records.length)
      : newPack
        ? m.added(first.name, site)
        : m.updated(first.name, site);

  let detail: string;
  if (undone) {
    // Nothing is backed up for a file that wasn't there before, so undoing a pack only removes it.
    const what = undoRestoresFiles(records) ? m.oldFilesBack : m.addedFilesRemoved;
    detail = `${m.undoneOn(formatShortDate(Math.max(...records.map((r) => r.undoneAt ?? 0))))} · ${what}`;
  } else if (!live.length) detail = `${m.backupGone(records.length)} · ${formatShortDate(item.at)}`;
  else if (cleanup) detail = `${m.duplicateCleanup} · ${formatTime(item.at)}`;
  else detail = `${automatic ? m.afterCheck : item.kind === 'batch' ? m.updateAll : newPack ? m.newPack : m.update} · ${files} · ${formatTime(item.at)}`;

  const undo = async (): Promise<void> => {
    if (item.kind === 'batch') {
      const ok = await confirm({
        title: m.undoTitle(live.length),
        body: m.undoBody,
        confirmLabel: t().common.undoAll,
        cancelLabel: t().common.dontUndo,
      });
      if (!ok) return;
      if (await app.run(() => api.undoBatch(item.id))) toast({ text: m.undid(live.length) });
    } else if (await app.run(() => api.undoInstall(first.id))) {
      toast({ text: cleanup ? m.restoredDuplicates(counts.removed) : newPack ? m.removedPack(first.name) : m.undidUpdate(first.name) });
    }
  };

  return (
    <li className={`history-item ${undone ? 'undone' : ''} ${!live.length && !undone ? 'expired' : ''}`}>
      <span className="history-icon">
        {undone ? <RotateCcw size={18} aria-hidden="true" /> : cleanup ? <CopyMinus size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
      </span>
      <div className="history-text">
        <span className="history-title">
          {title} {automatic && !undone && <span className="tag">{m.automatic}</span>}
          {undone && <span className="tag">{m.undone}</span>}
        </span>
        <span className="faint small">{detail}</span>
        {item.kind === 'batch' && (
          <Disclosure summary={m.whichPacks} className="history-more">
            <ul className="plain-list small">
              {records.map((r) => (
                <li key={r.id} className={r.undoneAt ? 'faint' : ''}>
                  {r.name}
                  {r.source && <span className="faint"> {t().common.from(SOURCE_LABEL[r.source])}</span>}
                  {r.undoneAt && <span className="faint"> · {m.undone}</span>}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
      {live.length > 0 && (
        <>
          <IconButton
            label={m.openBackup}
            icon={FolderOpen}
            size={16}
            onClick={() => app.run(() => api.openBackupFolder(item.kind === 'batch' ? undefined : first.id))}
          />
          <Button size="sm" icon={RotateCcw} onClick={undo}>
            {item.kind === 'batch' ? t().common.undoAll : t().common.undo}
          </Button>
        </>
      )}
    </li>
  );
}
