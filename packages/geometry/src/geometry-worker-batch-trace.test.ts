/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Load hillclimb worker sub-stage spans (#9605). Drives the real worker
 * message handler with a mocked wasm: each batch records exactly one
 * `worker.batch.wasm`, `worker.batch.collect` and `worker.batch.post`, the
 * partitioned path included (its inner flat collection is not a second,
 * nested collect span), and the source copy is one `worker.sourceInstall`.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => {
  const emptyCollection = () => ({ length: 0, geometryHashCount: 0, takeMesh: () => undefined, free: () => {} });
  const partitioned = vi.fn(() => ({
    takeMeshes: emptyCollection, takeShard: () => new Uint8Array(4), instancedOccurrences: 1, free: () => {},
  }));
  class MockIfcAPI {
    setSourceBytes(): void {}
    processGeometryBatchPartitionedFromSource = partitioned;
    free(): void {}
  }
  return { init: vi.fn(async () => undefined), MockIfcAPI, partitioned };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasm.init,
  initSync: vi.fn(),
  setGeometryProgressCallback: () => undefined,
  IfcAPI: wasm.MockIfcAPI,
}));

const posted: Array<{ type?: string; payload?: { spans: Array<{ name: string; start: number; end: number }> } }> = [];
let originalSelf: unknown;
let originalPostMessage: unknown;

async function send(data: unknown): Promise<void> {
  (self as unknown as Worker).onmessage!({ data } as MessageEvent);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  posted.length = 0;
  wasm.partitioned.mockClear();
  const g = globalThis as Record<string, unknown>;
  originalSelf = g.self;
  originalPostMessage = g.postMessage;
  g.self = globalThis;
  g.postMessage = (msg: (typeof posted)[number]) => posted.push(msg);
  await import('./geometry.worker.js');
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  if (originalSelf === undefined) delete g.self; else g.self = originalSelf;
  if (originalPostMessage === undefined) delete g.postMessage; else g.postMessage = originalPostMessage;
});

const emptyU32 = () => new Uint32Array(0);

async function streamTwoBatches(): Promise<void> {
  await send({ type: 'init' });
  await send({
    type: 'stream-start',
    sharedBuffer: new SharedArrayBuffer(8),
    unitScale: 1, rtcX: 0, rtcY: 0, rtcZ: 0, needsShift: false,
    voidKeys: emptyU32(), voidCounts: emptyU32(), voidValues: emptyU32(),
    styleIds: emptyU32(), styleColors: new Uint8Array(0),
  });
  await send({ type: 'stream-chunk', jobsFlat: new Uint32Array([1, 0, 1]) });
  await send({ type: 'stream-chunk', jobsFlat: new Uint32Array([2, 0, 1]) });
}

const spanNames = () => posted
  .filter((m) => m.type === 'load-trace:spans')
  .flatMap((m) => m.payload!.spans)
  .filter((s) => s.name.startsWith('worker.'))
  .map((s) => s.name);

it('records one wasm, collect and post span per partitioned batch', async () => {
  await send({ type: 'load-trace:enable', thread: 'geom-0' });
  await streamTwoBatches();
  expect(posted.filter((m) => m.type === 'error')).toEqual([]);
  expect(wasm.partitioned).toHaveBeenCalledTimes(2);
  const names = spanNames();
  const count = (name: string) => names.filter((n) => n === name).length;
  expect(count('worker.sourceInstall')).toBe(1);
  expect(count('worker.batch.wasm')).toBe(2);
  expect(count('worker.batch.collect')).toBe(2);
  expect(count('worker.batch.post')).toBe(2);
});

it('posts no spans and the same batches when tracing is off', async () => {
  await streamTwoBatches();
  expect(wasm.partitioned).toHaveBeenCalledTimes(2);
  expect(posted.filter((m) => m.type === 'load-trace:spans')).toEqual([]);
  expect(posted.filter((m) => m.type === 'batch')).toHaveLength(2);
});
