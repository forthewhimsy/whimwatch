import { t } from '../shared/i18n/index.js';
import type { BatchItem, BatchState } from '../shared/api.js';
import { CancelledError } from './fetcher.js';

/** Thrown by a batch step when nothing after it can succeed either (e.g. the game is running). */
export class StopBatchError extends Error {}

/**
 * Runs `work` for each item in order, never in parallel. Failures are
 * recorded and the batch moves on; a StopBatchError or a stop request
 * cancels the remaining items.
 */
export interface BatchStepResult {
  message?: string;
  replaced?: number;
  added?: number;
  addedNames?: string[];
  /** Not installed: it waits for the user to choose its files (BatchItem.review). */
  review?: BatchItem['review'];
}

export async function runBatch(
  items: { key: string; name: string; source?: string }[],
  work: (key: string) => Promise<string | BatchStepResult | void>,
  onChange: (state: BatchState) => void,
  shouldStop: () => boolean,
  batchId?: string,
): Promise<BatchState> {
  const state: BatchState = { running: true, stopRequested: false, batchId, items: items.map((i) => ({ ...i, state: 'queued' })) };
  const emit = (): void => onChange({ ...state, stopRequested: shouldStop(), items: state.items.map((i) => ({ ...i })) });
  emit();

  for (const item of state.items) {
    if (shouldStop()) break;
    item.state = 'working';
    emit();
    try {
      const result = await work(item.key);
      const { message, replaced, added, addedNames, review } = typeof result === 'string' ? { message: result } : (result ?? {});
      Object.assign(item, { state: review ? 'review' : 'done', message: message || undefined, replaced, added, addedNames, review });
    } catch (err) {
      if (err instanceof CancelledError) {
        item.state = 'cancelled';
        item.message = t().updater.cancelled;
        break;
      }
      item.state = 'failed';
      item.message = (err as Error).message;
      if (err instanceof StopBatchError) break;
    }
    emit();
  }

  for (const item of state.items) {
    if (item.state === 'queued') item.state = 'cancelled';
  }
  state.running = false;
  emit();
  return state;
}
