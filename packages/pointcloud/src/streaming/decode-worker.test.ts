/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `decode-worker.ts`'s `handleOpen` used to register a newly-opened
 * `StreamingPointSource` into the worker-local `sources` map BEFORE
 * reporting `{ kind: 'opened', sourceId, ... }` back to the client. If
 * that `post()` (i.e. `self.postMessage`) throws, the client never
 * learns `sourceId` and can therefore never send `close`/`abort` for
 * it — so the source stayed registered and open for the life of the
 * worker with no way to release it.
 *
 * This test polyfills `self` (decode-worker.ts is written for the real
 * `DedicatedWorkerGlobalScope`, which vitest's `node` environment does
 * not provide) and mocks the LAS format module so `handleOpen` runs
 * end-to-end against a fake `StreamingPointSource`. It forces the
 * *first* `postMessage` call (the `'opened'` response) to throw, then
 * asserts the fake source's `close()` was called by the worker itself
 * — proving nothing was left registered for the client to leak.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { openMock, closeMock, sourceCtorMock } = vi.hoisted(() => {
  const openMock = vi.fn().mockResolvedValue({
    totalPointCount: 10,
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    hasColor: false,
    hasClassification: false,
    hasIntensity: false,
  });
  const closeMock = vi.fn();
  const sourceCtorMock = vi.fn().mockImplementation(function FakeLasStreamingSource(
    this: { open: unknown; next: unknown; close: unknown },
  ) {
    this.open = openMock;
    this.next = vi.fn();
    this.close = closeMock;
  });
  return { openMock, closeMock, sourceCtorMock };
});

vi.mock('./las-source.js', () => ({
  LasStreamingSource: sourceCtorMock,
}));

/** Minimal `DedicatedWorkerGlobalScope` stand-in. */
function installSelfPolyfill(postMessage: (msg: unknown) => void) {
  (globalThis as unknown as { self: unknown }).self = {
    postMessage,
    onmessage: null,
  };
}

async function loadWorker() {
  vi.resetModules();
  // `decode-worker.ts` assigns `self.onmessage = ...` at module load,
  // so `self` must exist before the dynamic import runs.
  await import('./decode-worker.js');
  return (globalThis as unknown as { self: { onmessage: (e: { data: unknown }) => void } }).self
    .onmessage;
}

describe('decode-worker handleOpen — post(\'opened\') failure', () => {
  beforeEach(() => {
    openMock.mockClear();
    closeMock.mockClear();
    sourceCtorMock.mockClear();
  });

  it('closes the source when reporting success to the client fails, so it cannot leak', async () => {
    const posted: unknown[] = [];
    installSelfPolyfill((msg) => {
      posted.push(msg);
      const kind = (msg as { kind?: string }).kind;
      if (kind === 'opened') {
        throw new Error('DataCloneError: simulated postMessage failure');
      }
    });
    const onmessage = await loadWorker();

    onmessage({
      data: {
        kind: 'open',
        requestId: 1,
        format: 'las',
        blob: new Blob([new Uint8Array(0)]),
        stride: 1,
      },
    });
    // handleOpen is async (`void handleOpen(msg)`); let its microtasks run.
    await vi.waitFor(() => {
      expect(posted.length).toBeGreaterThanOrEqual(2);
    });

    // The worker attempted to report 'opened' (and it threw), then fell
    // back to an 'error' response — the client is told the open failed.
    expect(posted[0]).toMatchObject({ kind: 'opened' });
    expect(posted[posted.length - 1]).toMatchObject({ kind: 'error', requestId: 1 });

    // The crux of the fix: since the client was never told a usable
    // sourceId, the worker must release the source itself instead of
    // leaving it registered forever.
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('does not close the source when post(\'opened\') succeeds (control case)', async () => {
    const posted: unknown[] = [];
    installSelfPolyfill((msg) => {
      posted.push(msg);
    });
    const onmessage = await loadWorker();

    onmessage({
      data: {
        kind: 'open',
        requestId: 1,
        format: 'las',
        blob: new Blob([new Uint8Array(0)]),
        stride: 1,
      },
    });
    await vi.waitFor(() => {
      expect(posted.length).toBeGreaterThanOrEqual(1);
    });

    expect(posted[0]).toMatchObject({ kind: 'opened', sourceId: 1 });
    expect(closeMock).not.toHaveBeenCalled();
  });
});
