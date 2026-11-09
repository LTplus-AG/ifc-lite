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
import { chunkFromWire, type SerializedChunk } from './protocol.js';
import { streamPointCloud } from './host.js';
import { PLY_STREAM_READ_BYTES } from './ply-stream-decode.js';
import { createDecodeWorkerSource, __resetSharedSessionForTests } from './worker-client.js';

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

describe('decode-worker PLY normal payload (#4561)', () => {
  it('sends source normals through the real PLY source and transferable wire row-for-row', async () => {
    const posted: unknown[] = [];
    installSelfPolyfill(msg => { posted.push(msg); });
    const onmessage = await loadWorker();
    const ply = 'ply\nformat ascii 1.0\nelement vertex 2\n'
      + 'property float x\nproperty float y\nproperty float z\n'
      + 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
      + 'property float nx\nproperty float ny\nproperty float nz\nend_header\n'
      + '1 2 3 255 0 0 0 0 1\n4 5 6 0 255 0 1 0 0\n';
    onmessage({ data: { kind: 'open', requestId: 41, format: 'ply', blob: new Blob([ply]), stride: 1 } });
    await vi.waitFor(() => expect(posted.some(row => (row as { kind?: string }).kind === 'opened')).toBe(true));
    const opened = posted.find(row => (row as { kind?: string }).kind === 'opened') as { sourceId: number };
    onmessage({ data: { kind: 'next', requestId: 42, sourceId: opened.sourceId, maxPoints: 10 } });
    await vi.waitFor(() => expect(posted.some(row => (row as { kind?: string }).kind === 'chunk')).toBe(true));
    const response = posted.find(row => (row as { kind?: string }).kind === 'chunk') as { chunk: SerializedChunk };
    const chunk = chunkFromWire(response.chunk);
    expect(Array.from(chunk.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(chunk.colors!).map(value => Math.round(value * 255))).toEqual([255, 0, 0, 0, 255, 0]);
    expect(Array.from(chunk.normals!)).toEqual([0, 0, 1, 1, 0, 0]);
  });

  it('preserves a safe-integer stride above 32 bits at the real worker boundary', async () => {
    const posted: unknown[] = [];
    installSelfPolyfill(msg => { posted.push(msg); });
    const onmessage = await loadWorker();
    const ply = 'ply\nformat ascii 1.0\nelement vertex 3\n'
      + 'property float x\nproperty float y\nproperty float z\nend_header\n'
      + '1 0 0\n2 0 0\n3 0 0\n';
    onmessage({ data: { kind: 'open', requestId: 51, format: 'ply', blob: new Blob([ply]), stride: 2 ** 32 } });
    await vi.waitFor(() => expect(posted.some(row => (row as { kind?: string }).kind === 'opened')).toBe(true));
    const opened = posted.find(row => (row as { kind?: string }).kind === 'opened') as { sourceId: number; info: { totalPointCount: number } };
    expect(opened.info.totalPointCount).toBe(1);
    onmessage({ data: { kind: 'next', requestId: 52, sourceId: opened.sourceId, maxPoints: 10 } });
    await vi.waitFor(() => expect(posted.some(row => (row as { kind?: string }).kind === 'chunk')).toBe(true));
    const response = posted.find(row => (row as { kind?: string }).kind === 'chunk') as { chunk: SerializedChunk };
    expect(Array.from(chunkFromWire(response.chunk).positions)).toEqual([1, 0, 0]);
  });
});

describe('decode-worker reopen and abort-open (#8777)', () => {
  beforeEach(() => {
    openMock.mockClear();
    closeMock.mockClear();
    sourceCtorMock.mockClear();
  });

  async function openLas(onmessage: (e: { data: unknown }) => void, posted: unknown[]): Promise<number> {
    onmessage({ data: { kind: 'open', requestId: 1, format: 'las', blob: new Blob([]), stride: 1 } });
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ kind: 'opened' })));
    return (posted.find(row => (row as { kind?: string }).kind === 'opened') as { sourceId: number }).sourceId;
  }

  it('rebuilds a source without its own reopen() under the same id, with the new stride and origin', async () => {
    const posted: unknown[] = [];
    installSelfPolyfill(msg => { posted.push(msg); });
    const onmessage = await loadWorker();
    const sourceId = await openLas(onmessage, posted);
    onmessage({ data: { kind: 'reopen', requestId: 2, sourceId, stride: 4, originOffset: [1, 2, 3] } });
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ kind: 'opened', requestId: 2, sourceId })));
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(sourceCtorMock).toHaveBeenCalledTimes(2);
    expect(sourceCtorMock.mock.calls[1][1]).toMatchObject({ downsample: { stride: 4 }, originOffset: [1, 2, 3] });
  });

  it('releases the source when reopen fails, so the client cannot reach a half-open one', async () => {
    const posted: unknown[] = [];
    installSelfPolyfill(msg => { posted.push(msg); });
    const onmessage = await loadWorker();
    const sourceId = await openLas(onmessage, posted);
    openMock.mockRejectedValueOnce(new Error('reopen boom'));
    onmessage({ data: { kind: 'reopen', requestId: 2, sourceId, stride: 2 } });
    await vi.waitFor(() => expect(posted).toContainEqual({ kind: 'error', requestId: 2, message: 'reopen boom' }));
    onmessage({ data: { kind: 'next', requestId: 3, sourceId, maxPoints: 1 } });
    await vi.waitFor(() => expect(posted).toContainEqual({ kind: 'error', requestId: 3, message: `Unknown sourceId ${sourceId}` }));
    expect(closeMock).toHaveBeenCalledTimes(2);
  });

  it('releases both sources when a close arrives while a rebuild is opening', async () => {
    const posted: unknown[] = [];
    installSelfPolyfill(msg => { posted.push(msg); });
    const onmessage = await loadWorker();
    const sourceId = await openLas(onmessage, posted);
    let release: (() => void) | undefined;
    // The rebuilt source's open() ignores its signal, so only the entry check can catch the close.
    openMock.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ totalPointCount: 1, bbox: { min: [0, 0, 0], max: [0, 0, 0] }, hasColor: false, hasClassification: false, hasIntensity: false });
    }));
    onmessage({ data: { kind: 'reopen', requestId: 2, sourceId, stride: 2 } });
    await vi.waitFor(() => expect(release).toBeDefined());
    onmessage({ data: { kind: 'close', sourceId } });
    release!();
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ kind: 'error', requestId: 2 })));
    expect(posted).not.toContainEqual(expect.objectContaining({ kind: 'opened', requestId: 2 }));
    onmessage({ data: { kind: 'next', requestId: 3, sourceId, maxPoints: 1 } });
    await vi.waitFor(() => expect(posted).toContainEqual({ kind: 'error', requestId: 3, message: `Unknown sourceId ${sourceId}` }));
    // The old source, by the rebuild and again by the close; the new one, by the entry check.
    expect(closeMock).toHaveBeenCalledTimes(3);
  });

  it('answers a reopen for an unknown source with an error', async () => {
    const posted: unknown[] = [];
    installSelfPolyfill(msg => { posted.push(msg); });
    const onmessage = await loadWorker();
    onmessage({ data: { kind: 'reopen', requestId: 9, sourceId: 404, stride: 1 } });
    await vi.waitFor(() => expect(posted).toContainEqual({ kind: 'error', requestId: 9, message: 'Unknown sourceId 404' }));
  });

  it('aborts an open that is still running', async () => {
    const posted: unknown[] = [];
    installSelfPolyfill(msg => { posted.push(msg); });
    const onmessage = await loadWorker();
    let seen: AbortSignal | undefined;
    openMock.mockImplementationOnce((signal: AbortSignal) => {
      seen = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('open aborted'))));
    });
    onmessage({ data: { kind: 'open', requestId: 7, format: 'las', blob: new Blob([]), stride: 1 } });
    await vi.waitFor(() => expect(seen).toBeDefined());
    onmessage({ data: { kind: 'abort-open', targetRequestId: 6 } });
    expect(seen!.aborted).toBe(false);
    onmessage({ data: { kind: 'abort-open', targetRequestId: 7 } });
    await vi.waitFor(() => expect(posted).toContainEqual({ kind: 'error', requestId: 7, message: 'open aborted' }));
  });
});

/**
 * A browser finishes each file read in a task of its own, which is when a
 * worker can handle a queued message. Node's in-memory Blob resolves in a
 * microtask, so without this a bridged `abort-open` would never interleave.
 */
class TaskBlob extends Blob {
  override async arrayBuffer(): Promise<ArrayBuffer> {
    await new Promise(resolve => setTimeout(resolve, 0));
    return super.arrayBuffer();
  }
}

/** A binary xyz-float PLY whose bytes are generated per read, so its size costs no memory. */
class VirtualPly extends Blob {
  readonly bodyReads: number[] = [];
  /** Reads that start at the first body byte: one per pass over the body. */
  passes = 0;
  private readonly header: Uint8Array;
  private readonly total: number;

  constructor(readonly count: number, private readonly onBodyRead?: (reads: number) => void) {
    super([]);
    this.header = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n`
      + 'property float x\nproperty float y\nproperty float z\nend_header\n');
    this.total = this.header.byteLength + count * 12;
  }

  override get size(): number { return this.total; }

  override slice(start = 0, end = this.total): Blob {
    const from = Math.max(0, start), to = Math.min(this.total, end);
    const out = new Uint8Array(Math.max(0, to - from));
    out.set(this.header.subarray(from, to));
    const bodyFrom = Math.max(from, this.header.byteLength);
    if (bodyFrom < to) {
      this.bodyReads.push(to - bodyFrom);
      if (from <= this.header.byteLength && this.header.byteLength + 12 <= to) this.passes++;
      this.onBodyRead?.(this.bodyReads.length);
      // Record i is (i, 2i, 3i) with every coordinate of record 0 shifted by 1000.
      const view = new DataView(out.buffer);
      const firstRecord = Math.floor((bodyFrom - this.header.byteLength) / 12);
      for (let record = firstRecord; record * 12 + this.header.byteLength < to; record++) {
        for (let axis = 0; axis < 3; axis++) {
          const at = this.header.byteLength + record * 12 + axis * 4 - from;
          if (at >= 0 && at + 4 <= out.byteLength) view.setFloat32(at, record * (axis + 1) + 1000, true);
        }
      }
    }
    return new TaskBlob([out]);
  }
}

/** Route a decode-worker client through the real worker module in-process. */
async function inProcessWorker(): Promise<() => Worker> {
  const listeners = new Set<(event: { data: unknown }) => void>();
  installSelfPolyfill(msg => { setTimeout(() => listeners.forEach(listener => listener({ data: msg })), 0); });
  const onmessage = await loadWorker();
  const worker = {
    postMessage: (msg: unknown) => setTimeout(() => onmessage({ data: msg }), 0),
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === 'message') listeners.add(listener);
    },
  };
  return () => worker as unknown as Worker;
}

describe('large PLY through the real worker (#8777)', () => {
  beforeEach(() => { __resetSharedSessionForTests(); });

  it('reads a downsampled, auto-origin PLY at most twice: one bounds scan and one decode', async () => {
    const spawn = await inProcessWorker();
    const blob = new VirtualPly(3_000_000);
    const bodyBytes = blob.count * 12;
    let emitted = 0, first: number[] | undefined, opened: { stride: number; originOffset?: readonly number[] } | undefined;
    const handle = streamPointCloud({
      format: 'ply', blob, maxPointsInMemory: 1_000_000, autoOrigin: true, chunkSize: 500_000,
      createSource: options => createDecodeWorkerSource({ ...options, spawn }),
      onOpen: info => { opened = info; },
      onChunk: chunk => { first ??= Array.from(chunk.positions.subarray(0, 6)); emitted += chunk.pointCount; },
    });
    await handle.done;
    expect(opened?.stride).toBe(3);
    expect(emitted).toBe(1_000_000);
    // Record i is (i, 2i, 3i) + 1000 for i < 3,000,000, so the bbox centre is
    // known without asking the code under test.
    const origin = [1_500_999.5, 3_000_999, 4_500_998.5];
    expect(opened!.originOffset).toEqual(origin);
    expect(first).toEqual([1000, 1000, 1000, 1003, 1006, 1009].map((v, i) => Math.fround(v - origin[i % 3])));
    // The header read (its window overlaps the body), one bounds scan, one
    // decode. Before #8777 the reopen read the header and scanned again: 5.
    expect(blob.passes).toBe(3);
    const read = blob.bodyReads.reduce((sum, bytes) => sum + bytes, 0);
    expect(read).toBeGreaterThanOrEqual(2 * bodyBytes);
    expect(read).toBeLessThan(2.25 * bodyBytes);
  });

  it('settles promptly when cancelled during the bounds scan of a 5 GiB PLY', async () => {
    const spawn = await inProcessWorker();
    let handle: ReturnType<typeof streamPointCloud> | undefined;
    const blob = new VirtualPly(Math.floor(5 * 2 ** 30 / 12), reads => { if (reads === 3) handle!.cancel(); });
    const onError = vi.fn();
    handle = streamPointCloud({
      format: 'ply', blob, autoOrigin: true, onChunk: () => {}, onError,
      createSource: options => createDecodeWorkerSource({ ...options, spawn }),
    });
    await handle.done;
    expect(onError).not.toHaveBeenCalled();
    // The scan stops at its next window: nowhere near the ~1280 windows of the file.
    expect(blob.bodyReads.length).toBeLessThanOrEqual(5);
    expect(Math.max(...blob.bodyReads)).toBeLessThanOrEqual(PLY_STREAM_READ_BYTES);
  }, 10_000);
});
