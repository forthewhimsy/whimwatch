import { describe, expect, it } from 'vitest';
import { runBatch, StopBatchError } from '../src/core/batch.js';
import { BROWSERS, browserForDefault, parseMacHttpsHandler, parseRegProgId } from '../src/core/browsers.js';
import type { BatchState } from '../src/shared/api.js';

describe('runBatch', () => {
  const items = [
    { key: 'a', name: 'A' },
    { key: 'b', name: 'B' },
    { key: 'c', name: 'C' },
  ];

  it('runs items in order and keeps going after a failure', async () => {
    const order: string[] = [];
    const states: BatchState[] = [];
    const final = await runBatch(
      items,
      async (key) => {
        order.push(key);
        if (key === 'b') throw new Error('broken download');
        return `updated ${key}`;
      },
      (s) => states.push(s),
      () => false,
    );
    expect(order).toEqual(['a', 'b', 'c']);
    expect(final.items.map((i) => [i.state, i.message])).toEqual([
      ['done', 'updated a'],
      ['failed', 'broken download'],
      ['done', 'updated c'],
    ]);
    expect(final.running).toBe(false);
    // Emitted snapshots are copies, so earlier ones still show the item in progress.
    expect(states.some((s) => s.items[0]!.state === 'working')).toBe(true);
  });

  it('cancels the rest on a stop request or StopBatchError', async () => {
    let stop = false;
    const stopped = await runBatch(items, async () => void (stop = true), () => undefined, () => stop);
    expect(stopped.items.map((i) => i.state)).toEqual(['done', 'cancelled', 'cancelled']);

    const blocked = await runBatch(
      items,
      async () => {
        throw new StopBatchError('Close The Sims 4 first.');
      },
      () => undefined,
      () => false,
    );
    expect(blocked.items.map((i) => i.state)).toEqual(['failed', 'cancelled', 'cancelled']);
  });

  it('lets a step correct the source it downloads from, while it runs', async () => {
    const states: BatchState[] = [];
    const final = await runBatch(
      [{ key: 'a', name: 'A', source: 'wicked.cc' }],
      async (_key, setSource) => {
        setSource('LoversLab');
        setSource('LoversLab');
        return 'updated a';
      },
      (s) => states.push(s),
      () => false,
    );
    expect(final.items[0]).toMatchObject({ state: 'done', source: 'LoversLab' });
    // Queued, working, corrected once (the same source again isn't news), done, finished.
    expect(states.map((s) => `${s.items[0]!.state} ${s.items[0]!.source}`)).toEqual([
      'queued wicked.cc',
      'working wicked.cc',
      'working LoversLab',
      'done LoversLab',
      'done LoversLab',
    ]);
  });
});

describe('browser detection helpers', () => {
  it('reads the Windows default browser ProgId', () => {
    expect(parseRegProgId('\nHKEY_CURRENT_USER\\...\\UserChoice\n    ProgId    REG_SZ    BraveHTML\n')).toBe('BraveHTML');
    expect(parseRegProgId('ERROR: The system was unable to find the specified registry key')).toBeUndefined();
  });

  it('reads the macOS https handler', () => {
    const out = `(
    { LSHandlerContentType = "public.html"; LSHandlerRoleAll = "com.apple.safari"; },
    { LSHandlerPreferredVersions = { LSHandlerRoleAll = "-"; }; LSHandlerRoleAll = "com.google.chrome"; LSHandlerURLScheme = https; }
)`;
    expect(parseMacHttpsHandler(out)).toBe('com.google.chrome');
  });

  it.each([
    ['BraveHTML', 'brave'],
    ['ChromeHTML', 'chrome'],
    ['MSEdgeHTM', 'edge'],
    ['FirefoxURL-308046B0AF4A39CB', 'firefox'],
    ['org.mozilla.firefox', 'firefox'],
    ['chromium_chromium.desktop', 'chromium'],
    ['google-chrome.desktop', 'chrome'],
    ['com.apple.safari', undefined],
  ])('maps %s to %s', (identifier, id) => {
    expect(browserForDefault(identifier)).toBe(id);
  });

  it('passes the URL as a single private-window argument', () => {
    const url = 'https://www.loverslab.com/files/file/1-x/?a=1&b=2';
    expect(BROWSERS.find((b) => b.id === 'edge')!.privateArgs(url)).toEqual(['--inprivate', url]);
    expect(BROWSERS.find((b) => b.id === 'firefox')!.privateArgs(url)).toEqual(['-private-window', url]);
  });
});
