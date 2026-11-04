/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for Codex P2 feedback on #671:
 *
 *  1. `createDecodeWorkerSource()` must NOT touch the worker / spawn
 *     callback at construction time. The dynamic `inline-worker.js`
 *     import + Blob URL setup is deferred until `open()` (or `next()`)
 *     actually runs, so speculative construction, SSR paths, and tests
 *     that build sources but never open them don't pay for or crash on
 *     worker setup.
 *
 *  2. If the spawn callback fails (sync throw OR promise rejection),
 *     the module-level cache must clear so a subsequent
 *     `createDecodeWorkerSource()` — possibly with a different custom
 *     `spawn` callback — can recover. Without this the first failure
 *     poisons every later call.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDecodeWorkerSource,
  __resetSharedSessionForTests,
} from './worker-client.js';

describe('createDecodeWorkerSource — lazy spawn', () => {
  beforeEach(() => {
    __resetSharedSessionForTests();
  });

  it('does NOT call the spawn callback at construction time', () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn should not be called yet');
    });
    // Construction should be side-effect-free. If this throws, the
    // P2 fix regressed and consumers eagerly pay for the worker bundle
    // (or crash on missing Worker global at SSR).
    expect(() =>
      createDecodeWorkerSource({
        format: 'las',
        blob: new Blob([new Uint8Array(0)]),
        spawn,
      }),
    ).not.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('close() before open() does NOT trigger spawn', () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn should not be called by close()');
    });
    const source = createDecodeWorkerSource({
      format: 'las',
      blob: new Blob([new Uint8Array(0)]),
      spawn,
    });
    // `close()` on a never-opened source must be a no-op. The session
    // promise is null at this point; `close()` should detect that and
    // skip the notify call entirely.
    expect(() => source.close()).not.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('createDecodeWorkerSource — failure recovery', () => {
  beforeEach(() => {
    __resetSharedSessionForTests();
  });

  it('clears the cache after async spawn rejection so a retry can succeed', async () => {
    const failingSpawn = vi.fn(async () => {
      throw new Error('CSP blocks blob: workers');
    });
    const firstSource = createDecodeWorkerSource({
      format: 'las',
      blob: new Blob([new Uint8Array(0)]),
      spawn: failingSpawn,
    });
    // First open() rejects — and crucially, after this rejection the
    // module-level cache must be cleared so the next source's spawn
    // callback is actually invoked (instead of getting the cached
    // rejected promise).
    await expect(firstSource.open()).rejects.toThrow('CSP blocks blob: workers');
    expect(failingSpawn).toHaveBeenCalledTimes(1);

    // Construct a SECOND source with a fresh spawn callback. This is
    // the documented recovery path: consumer detects the failure,
    // builds a new source with an alternative spawn. If the cache
    // wasn't cleared, the new spawn would never be invoked.
    const retrySpawn = vi.fn(async () => {
      throw new Error('retry also rejected (but spawn WAS called)');
    });
    const secondSource = createDecodeWorkerSource({
      format: 'las',
      blob: new Blob([new Uint8Array(0)]),
      spawn: retrySpawn,
    });
    await expect(secondSource.open()).rejects.toThrow(
      'retry also rejected (but spawn WAS called)',
    );
    // The whole point: retrySpawn MUST have been invoked. If it
    // wasn't, the cache poisoning bug regressed.
    expect(retrySpawn).toHaveBeenCalledTimes(1);
  });

  it('clears the cache after a sync throw from a custom spawn callback', async () => {
    const syncThrower = vi.fn(() => {
      throw new Error('sync spawn failure');
    });
    const source = createDecodeWorkerSource({
      format: 'las',
      blob: new Blob([new Uint8Array(0)]),
      spawn: syncThrower as () => Worker,
    });
    await expect(source.open()).rejects.toThrow('sync spawn failure');

    // Recovery: new source with a different spawn callback must call it.
    const retrySpawn = vi.fn(() => {
      throw new Error('retry sync failure');
    });
    const retrySource = createDecodeWorkerSource({
      format: 'las',
      blob: new Blob([new Uint8Array(0)]),
      spawn: retrySpawn as () => Worker,
    });
    await expect(retrySource.open()).rejects.toThrow('retry sync failure');
    expect(retrySpawn).toHaveBeenCalledTimes(1);
  });
});

/** A scripted worker: records every message and lets the test answer by hand. */
function scriptedWorker() {
  const sent: Array<Record<string, unknown>> = [];
  let listener: ((event: { data: unknown }) => void) | undefined;
  const worker = {
    postMessage: (msg: Record<string, unknown>) => { sent.push(msg); },
    addEventListener: (_type: string, l: (event: { data: unknown }) => void) => { listener = l; },
  };
  const info = { totalPointCount: 1, bbox: { min: [0, 0, 0], max: [0, 0, 0] }, hasColor: false, hasClassification: false, hasIntensity: false };
  return {
    sent,
    spawn: () => worker as unknown as Worker,
    reply: (data: unknown) => listener!({ data }),
    opened: (requestId: number, sourceId: number) => listener!({ data: { kind: 'opened', requestId, sourceId, info } }),
    lastRequest: (kind: string) => [...sent].reverse().find(msg => msg.kind === kind) as { requestId: number },
  };
}

describe('createDecodeWorkerSource — abort and reopen (#8777)', () => {
  beforeEach(() => {
    __resetSharedSessionForTests();
  });

  it('sends abort-open for the pending open, and settles when the worker answers', async () => {
    const w = scriptedWorker();
    const source = createDecodeWorkerSource({ format: 'ply', blob: new Blob([]), spawn: w.spawn });
    const ctrl = new AbortController();
    const opening = source.open(ctrl.signal);
    await vi.waitFor(() => expect(w.lastRequest('open')).toBeDefined());
    ctrl.abort();
    const { requestId } = w.lastRequest('open');
    expect(w.sent).toContainEqual({ kind: 'abort-open', targetRequestId: requestId });
    w.reply({ kind: 'error', requestId, message: 'Aborted' });
    await expect(opening).rejects.toThrow('Aborted');
  });

  it('closes a source whose open finished just as the abort fired', async () => {
    const w = scriptedWorker();
    const source = createDecodeWorkerSource({ format: 'ply', blob: new Blob([]), spawn: w.spawn });
    const ctrl = new AbortController();
    const opening = source.open(ctrl.signal);
    await vi.waitFor(() => expect(w.lastRequest('open')).toBeDefined());
    ctrl.abort();
    w.opened(w.lastRequest('open').requestId, 17);
    await expect(opening).rejects.toThrow('Aborted');
    expect(w.sent).toContainEqual({ kind: 'close', sourceId: 17 });
    await expect(source.next(1)).rejects.toThrow('not opened');
  });

  it('reopens in place, aborting by source id', async () => {
    const w = scriptedWorker();
    const source = createDecodeWorkerSource({ format: 'ply', blob: new Blob([]), spawn: w.spawn });
    const opening = source.open();
    await vi.waitFor(() => expect(w.lastRequest('open')).toBeDefined());
    w.opened(w.lastRequest('open').requestId, 5);
    await opening;
    const ctrl = new AbortController();
    const reopening = source.reopen!({ stride: 3, originOffset: [1, 2, 3] }, ctrl.signal);
    await vi.waitFor(() => expect(w.lastRequest('reopen')).toBeDefined());
    expect(w.lastRequest('reopen')).toMatchObject({ sourceId: 5, stride: 3, originOffset: [1, 2, 3] });
    ctrl.abort();
    expect(w.sent).toContainEqual({ kind: 'abort', sourceId: 5 });
    w.reply({ kind: 'error', requestId: w.lastRequest('reopen').requestId, message: 'Aborted' });
    await expect(reopening).rejects.toThrow('Aborted');
    // The worker released the source on the failed reopen; so does the client.
    await expect(source.next(1)).rejects.toThrow('not opened');
  });
});
