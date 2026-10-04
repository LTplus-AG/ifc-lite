/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Round trip through the real decode worker module (#6869): the client talks
 * to `decode-worker.ts` over a structured-clone message channel run
 * in-process, and the worker decodes the fixture with real laz-perf. This
 * covers the protocol additions, the shared session, cancel, and close.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLazPerf } from 'laz-perf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLazPerfLoaderForTesting, type LazPerfModule } from '../streaming/laz-perf-loader.js';
import { __resetSharedSessionForTests } from '../streaming/worker-client.js';
import { loadPendingCopcPages } from './copc-hierarchy.js';
import { openCopcWorkerReader } from './copc-worker-client.js';

const fixtureUrl = new URL('../../test-fixtures/', import.meta.url);
const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('tiny.copc.laz', fixtureUrl))));
const expected = JSON.parse(readFileSync(fileURLToPath(new URL('tiny-copc.json', fixtureUrl)), 'utf8')) as {
  pointCount: number;
  nodeCount: number;
  nodes: Record<string, number>;
  center: [number, number, number];
};

type Listener = (event: MessageEvent) => void;

/** Every message the client sent to the worker, in order. */
const sentToWorker: Array<{ kind: string; [k: string]: unknown }> = [];
/** Runs on each worker response just before the client sees it. */
let responseTap: ((msg: { kind: string; [k: string]: unknown }) => void) | null = null;

/**
 * A Worker whose other end is `decode-worker.ts` loaded into this realm.
 * Messages cross as `structuredClone` copies, like a real postMessage.
 */
async function inProcessWorker(): Promise<Worker> {
  const listeners = new Set<Listener>();
  const scope = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage(msg: unknown) {
      const copy = structuredClone(msg);
      queueMicrotask(() => {
        responseTap?.(copy as { kind: string });
        listeners.forEach((l) => l({ data: copy } as MessageEvent));
      });
    },
  };
  (globalThis as unknown as { self: typeof scope }).self = scope;
  await import('../streaming/decode-worker.js');
  const worker = {
    postMessage(msg: unknown) {
      const copy = structuredClone(msg);
      sentToWorker.push(copy as { kind: string });
      queueMicrotask(() => scope.onmessage?.({ data: copy }));
    },
    addEventListener(_type: string, l: Listener) { listeners.add(l); },
    removeEventListener(_type: string, l: Listener) { listeners.delete(l); },
  };
  return worker as unknown as Worker;
}

/** Root page size of the fixture, read straight from its info VLR. */
function expectedRootPageBytes(): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(375 + 54 + 48, true);
}

let restore: () => void;
beforeAll(() => {
  __resetSharedSessionForTests();
  restore = setLazPerfLoaderForTesting(() => createLazPerf() as Promise<LazPerfModule>);
});
afterAll(() => {
  restore();
  __resetSharedSessionForTests();
});

describe('openCopcWorkerReader (#6869)', () => {
  it('opens, pages in the whole hierarchy and decodes every node through the worker', async () => {
    const reader = await openCopcWorkerReader({
      source: { kind: 'blob', blob: new Blob([bytes]) },
      originOffset: expected.center,
      spawn: inProcessWorker,
    });
    expect(reader.file.header.pointCount).toBe(expected.pointCount);
    expect(reader.hierarchy.pendingPages.size).toBeGreaterThan(0);
    await loadPendingCopcPages(reader.hierarchy, reader.readPage);
    expect(reader.hierarchy.nodes.size).toBe(expected.nodeCount);
    expect(reader.hierarchy.pendingPages.size).toBe(0);
    let total = 0;
    for (const node of reader.hierarchy.nodes.values()) {
      if (node.pointCount === 0) continue;
      const chunk = await reader.readNode(node);
      total += chunk.pointCount;
      // Origin offset applied in the worker: positions are local, small.
      for (const v of chunk.positions) expect(Math.abs(v)).toBeLessThan(11);
    }
    expect(total).toBe(expected.pointCount);
    reader.close();
    await expect(reader.readNode([...reader.hierarchy.nodes.values()][0])).rejects.toThrow(/closed/);
  });

  it('concurrent loadPage calls for one page read it once and admit it once', async () => {
    const reader = await openCopcWorkerReader({ source: { kind: 'blob', blob: new Blob([bytes]) }, spawn: inProcessWorker });
    const [ref] = reader.hierarchy.pendingPages.values();
    await Promise.all([reader.loadPage(ref), reader.loadPage(ref), reader.loadPage(ref)]);
    expect(reader.hierarchy.stateOf(ref.key)).toBe('node');
    await reader.loadPage(ref); // already loaded: a no-op, not a "not pending" throw
    reader.close();
  });

  it('an aborted read rejects with AbortError and leaves the reader usable', async () => {
    const reader = await openCopcWorkerReader({ source: { kind: 'blob', blob: new Blob([bytes]) }, spawn: inProcessWorker });
    const root = reader.hierarchy.nodes.get('0-0-0-0');
    if (!root) throw new Error('root missing');
    const ctrl = new AbortController();
    const pending = reader.readNode(root, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    const ok = await reader.readNode(root, { stride: 2 });
    expect(ok.pointCount).toBe(Math.ceil(expected.nodes['0-0-0-0'] / 2));
    reader.close();
  });

  it('one waiter aborting a shared page load does not reject the others (#6874 review)', async () => {
    const reader = await openCopcWorkerReader({ source: { kind: 'blob', blob: new Blob([bytes]) }, spawn: inProcessWorker });
    const [ref] = reader.hierarchy.pendingPages.values();
    const quitter = new AbortController();
    const first = reader.loadPage(ref, quitter.signal);
    const second = reader.loadPage(ref);
    quitter.abort();
    await expect(first).rejects.toThrow(/abort/i);
    await expect(second).resolves.toBeUndefined();
    expect(reader.hierarchy.stateOf(ref.key)).toBe('node');
    reader.close();
  });

  it('the shared load is cancelled only when every waiter has gone', async () => {
    const reader = await openCopcWorkerReader({ source: { kind: 'blob', blob: new Blob([bytes]) }, spawn: inProcessWorker });
    const [ref] = reader.hierarchy.pendingPages.values();
    const a = new AbortController();
    const b = new AbortController();
    const cancelsBefore = sentToWorker.filter((m) => m.kind === 'copc-cancel').length;
    const pa = reader.loadPage(ref, a.signal);
    const pb = reader.loadPage(ref, b.signal);
    a.abort();
    expect(sentToWorker.filter((m) => m.kind === 'copc-cancel').length).toBe(cancelsBefore);
    b.abort();
    expect(sentToWorker.filter((m) => m.kind === 'copc-cancel').length).toBe(cancelsBefore + 1);
    await expect(pa).rejects.toThrow(/abort/i);
    await expect(pb).rejects.toThrow(/abort/i);
    // A later caller starts a fresh load rather than joining the cancelled one.
    await expect(reader.loadPage(ref)).resolves.toBeUndefined();
    expect(reader.hierarchy.stateOf(ref.key)).toBe('node');
    reader.close();
  });

  it('a reader opened just as the caller aborted is closed, not leaked (#6874 review)', async () => {
    const ctrl = new AbortController();
    let openedId: unknown = null;
    responseTap = (msg) => {
      if (msg.kind === 'copc-opened') {
        openedId = msg.sourceId;
        ctrl.abort(); // the abort lands after the worker already opened the reader
      }
    };
    try {
      await expect(openCopcWorkerReader({ source: { kind: 'blob', blob: new Blob([bytes]) }, spawn: inProcessWorker, signal: ctrl.signal }))
        .rejects.toThrow(/abort/i);
    } finally {
      responseTap = null;
    }
    expect(openedId).not.toBeNull();
    expect(sentToWorker.some((m) => m.kind === 'close' && m.sourceId === openedId)).toBe(true);
  });

  it('a page larger than the remaining byte budget is refused before the worker reads it (#6874 review)', async () => {
    const reader = await openCopcWorkerReader({
      source: { kind: 'blob', blob: new Blob([bytes]) },
      spawn: inProcessWorker,
      hierarchyLimits: { maxPages: 100, maxNodes: 10_000, maxPageBytes: expectedRootPageBytes() + 32 },
    });
    const [ref] = reader.hierarchy.pendingPages.values();
    const pageRequests = sentToWorker.filter((m) => m.kind === 'copc-page').length;
    await expect(reader.loadPage(ref)).rejects.toThrow(/page bytes/);
    expect(sentToWorker.filter((m) => m.kind === 'copc-page').length).toBe(pageRequests);
    reader.close();
  });

  it('the worker refuses a root page over the open-time byte limit (#6874 review)', async () => {
    await expect(openCopcWorkerReader({
      source: { kind: 'blob', blob: new Blob([bytes]) },
      spawn: inProcessWorker,
      hierarchyLimits: { maxPages: 100, maxNodes: 10_000, maxPageBytes: 32 },
    })).rejects.toThrow(/exceeds/);
  });

  it('surfaces a non-COPC file as an open error', async () => {
    const broken = bytes.slice();
    broken.set(new TextEncoder().encode('nope'), 375 + 2);
    await expect(openCopcWorkerReader({ source: { kind: 'blob', blob: new Blob([broken]) }, spawn: inProcessWorker }))
      .rejects.toThrow(/not a COPC file/);
  });
});
