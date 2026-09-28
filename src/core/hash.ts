import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { CancelledError } from './fetcher.js';

/** A file's SHA-256, read as a stream. With `signal`, stops reading when it's aborted. */
export function sha256(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    const abort = (): void => {
      stream.destroy();
      reject(new CancelledError());
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    stream
      .on('data', (chunk) => hash.update(chunk))
      .on('error', (err) => {
        signal?.removeEventListener('abort', abort);
        reject(err);
      })
      .on('end', () => {
        signal?.removeEventListener('abort', abort);
        resolve(hash.digest('hex'));
      });
  });
}

/** Whether two files are byte for byte the same (false if either can't be read). */
export async function sameContent(a: string, b: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    if (sa.size !== sb.size) return false;
    const [ha, hb] = await Promise.all([sha256(a, signal), sha256(b, signal)]);
    return ha === hb;
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    return false;
  }
}
