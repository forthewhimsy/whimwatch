import { Gamepad2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DuplicateGroup } from '../../shared/api';
import { t } from '../../shared/i18n';
import { Dialog } from './dialog';
import { fileName, formatBytes, formatShortDate } from './format';
import { useToast } from './toast';
import { api, type AppModel } from './useApp';
import { Banner, Button, Checkbox, Spinner } from './ui';

/**
 * Finds mod files that are in the Mods folders more than once, byte for byte, and removes the copies
 * the user doesn't keep. Removed copies are backed up like an update's replaced files, and History
 * puts them back. Nothing here leaves the computer.
 */
export function DuplicatesDialog({ app, onClose }: { app: AppModel; onClose: () => void }) {
  const toast = useToast();
  const [groups, setGroups] = useState<DuplicateGroup[]>();
  const [failed, setFailed] = useState<string>();
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  // The copy to keep in each group, by group id; null leaves the group alone.
  const [keep, setKeep] = useState<Record<string, string | null>>({});
  const [removing, setRemoving] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const m = t().duplicates;

  useEffect(() => api.onEvent((e) => e.type === 'duplicates-progress' && setProgress({ done: e.done, total: e.total })), []);

  useEffect(() => {
    let cancelled = false;
    api.findDuplicates().then(
      (found) => {
        if (cancelled) return;
        setGroups(found);
        setKeep(Object.fromEntries(found.map((g) => [g.id, g.keep])));
        if (found.length) void api.isGameRunning().then(setGameOpen, () => undefined);
      },
      (err: Error) => !cancelled && setFailed(err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // As in the Update window: look again when the user comes back, and every few seconds.
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
    if (!groups && !failed) void api.cancelDuplicates();
    onClose();
  };

  const chosen = (groups ?? []).filter((g) => keep[g.id]);
  const copies = chosen.reduce((n, g) => n + g.copies.length - 1, 0);
  const bytes = chosen.reduce((n, g) => n + g.size * (g.copies.length - 1), 0);

  const remove = async (): Promise<void> => {
    setRemoving(true);
    const done = await app.run(() => api.removeDuplicates(chosen.map((g) => ({ group: g.id, keep: keep[g.id]! }))));
    setRemoving(false);
    if (!done) return;
    const { recordId, removed, skipped } = done;
    toast({
      text: [removed ? m.removed(removed) : m.nothingRemoved, skipped ? m.leftChanged(skipped) : ''].filter(Boolean).join(' · '),
      action: recordId ? { label: t().common.undo, run: () => void app.run(() => api.undoInstall(recordId)) } : undefined,
    });
    onClose();
  };

  const pct = progress?.total ? Math.min(100, (progress.done / progress.total) * 100) : undefined;

  return (
    <Dialog
      title={m.title}
      subtitle={groups?.length ? m.intro(groups.length) : undefined}
      onClose={close}
      dismissable={!removing}
      width={680}
      footer={
        <>
          {groups && groups.length > 0 && <span className="muted small">{copies ? m.summary(copies, formatBytes(bytes)) : m.nothingChosen}</span>}
          <span className="spacer" />
          <Button variant="quiet" onClick={close} disabled={removing}>
            {groups?.length ? t().common.cancel : t().common.close}
          </Button>
          {groups && groups.length > 0 && (
            <Button variant="primary" icon={gameOpen ? Gamepad2 : Trash2} onClick={remove} disabled={removing || gameOpen || !copies}>
              {removing ? m.removing : gameOpen ? m.closeGame : m.removeButton}
            </Button>
          )}
        </>
      }
    >
      {!groups && !failed && (
        <div className="progress-block" role="status">
          <p className="row-center">
            <Spinner /> {m.finding}
          </p>
          <div
            className={`bar ${pct === undefined ? 'indeterminate' : ''}`}
            role="progressbar"
            aria-valuenow={pct === undefined ? undefined : Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={pct === undefined ? undefined : { width: `${pct}%` }} />
          </div>
        </div>
      )}
      {failed && (
        <Banner tone="error" title={m.couldntLook}>
          {failed}
        </Banner>
      )}
      {groups?.length === 0 && (
        <Banner tone="ok" title={m.noneTitle}>
          {m.none}
        </Banner>
      )}
      {gameOpen && (
        <Banner tone="error" title={t().update.gameOpenTitle}>
          {t().update.gameOpen}
        </Banner>
      )}
      {groups && groups.length > 0 && (
        <>
          <p className="muted small">{m.backedUp}</p>
          {groups.map((g) => {
            const kept = keep[g.id];
            return (
              <section key={g.id} className={`file-changes dupe-group ${kept ? '' : 'off'}`} aria-label={g.name}>
                <div className="dupe-head">
                  <span className="mono file-line-name" title={g.name}>
                    {g.name}
                  </span>
                  <span className="faint small">{m.copiesOf(g.copies.length, formatBytes(g.size))}</span>
                </div>
                {g.copies.map((c) => (
                  <label key={c.path} className={`file-line ${kept === c.path ? 'kind-add' : kept ? 'kind-remove' : 'off'}`}>
                    <input
                      type="radio"
                      className="radio"
                      name={g.id}
                      checked={kept === c.path}
                      disabled={!kept}
                      onChange={() => setKeep({ ...keep, [g.id]: c.path })}
                      aria-label={`${m.keep} ${c.relPath}`}
                    />
                    <span className="file-line-names">
                      <span className="mono file-line-name" title={c.path}>
                        {folderOf(c.relPath) || m.topLevel}
                      </span>
                      {fileName(c.relPath) !== g.name && <span className="faint small file-line-name">{fileName(c.relPath)}</span>}
                    </span>
                    <span className="faint small file-line-note">{formatShortDate(c.mtimeMs)}</span>
                    <span className="kind-label">{!kept ? m.leave : kept === c.path ? m.keep : m.remove}</span>
                  </label>
                ))}
                <label className="file-line dupe-leave">
                  <Checkbox checked={!kept} onChange={() => setKeep({ ...keep, [g.id]: kept ? null : g.keep })} label={m.leaveAlone} />
                  <span className="small">{m.leaveAlone}</span>
                </label>
              </section>
            );
          })}
        </>
      )}
    </Dialog>
  );
}

/** The folder a copy is in, inside its Mods folder; empty at the top. */
function folderOf(relPath: string): string {
  const parts = relPath.split(/[\\/]/);
  return parts.slice(0, -1).join('/');
}
