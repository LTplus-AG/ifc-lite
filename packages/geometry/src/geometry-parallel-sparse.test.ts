/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { SparsePool, sparsePoolFor, sumSparseStats } from './geometry-parallel-sparse.js';
import { GLOBAL_INSTANCING_MIN_BYTES } from './perf-flags.js';
import type { GeometryWorkerSetSparseSourceMessage, WorkerSparseStats } from './geometry-worker-sparse.js';

const flagHost = globalThis as { __IFC_LITE_OOC?: unknown; __IFC_LITE_OOC_BUDGET_MB?: unknown; __IFC_LITE_OOC_STATS__?: unknown; __IFC_LITE_GLOBAL_INSTANCING?: unknown };

afterEach(() => {
  delete flagHost.__IFC_LITE_OOC;
  delete flagHost.__IFC_LITE_OOC_BUDGET_MB;
  delete flagHost.__IFC_LITE_OOC_STATS__;
  delete flagHost.__IFC_LITE_GLOBAL_INSTANCING;
});

function harness(budgetBytes?: number) {
  const source = new SharedArrayBuffer(64);
  const posted: GeometryWorkerSetSparseSourceMessage[] = [];
  const worker = { postMessage: (message: GeometryWorkerSetSparseSourceMessage) => { posted.push(message); } } as unknown as Worker;
  let ready = 0;
  const shared: SharedArrayBuffer[][] = [];
  const pool = new SparsePool(source, {
    broadcast: (setup) => setup(worker),
    shareIndex: (...columns) => { shared.push(columns); },
    onReady: () => { ready++; },
  }, budgetBytes);
  const columns = [new SharedArrayBuffer(8), new SharedArrayBuffer(8), new SharedArrayBuffer(8)] as const;
  const facts = { type: 'sparse-facts', preamble: Uint8Array.from([7, 8, 9]), inverseTargets: Uint32Array.from([1]), inverseReferrers: Uint32Array.from([2]) };
  return { pool, posted, shared, source, columns, facts, ready: () => ready };
}

describe('SparsePool', () => {
  it.each(['index first', 'facts first'])('sends one sparse source once the index and the pre-pass facts are both in (%s)', (order) => {
    const { pool, posted, source, columns, facts, ready } = harness(64 * 1024 * 1024);
    if (order === 'index first') pool.offerIndex(...columns); else pool.offerFacts(facts);
    expect(pool.ready).toBe(false);
    expect(posted).toHaveLength(0);
    if (order === 'index first') pool.offerFacts(facts); else pool.offerIndex(...columns);

    expect(pool.ready).toBe(true);
    expect(ready()).toBe(1);
    expect(posted).toHaveLength(1);
    const [message] = posted;
    expect(message.sharedBuffer).toBe(source);
    expect(message.budgetBytes).toBe(64 * 1024 * 1024);
    expect([...message.preamble]).toEqual([7, 8, 9]);
    expect(message.preamble.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(message.indexIds.buffer).toBe(columns[0]);
    expect(message.indexStarts.buffer).toBe(columns[1]);
    expect(message.indexLengths.buffer).toBe(columns[2]);

    pool.offerFacts(facts);
    expect(posted).toHaveLength(1);
  });

  it.each(['index first', 'facts first'])('hands the workers the index of the whole-file path when the scan names the file unsupported (%s)', (order) => {
    const { pool, posted, shared, columns, facts, ready } = harness();
    const refusal = { ...facts, unsupported: 'annotation fill areas' };
    if (order === 'index first') pool.offerIndex(...columns); else pool.offerFacts(refusal);
    expect(pool.ready).toBe(false);
    if (order === 'index first') pool.offerFacts(refusal); else pool.offerIndex(...columns);

    expect(posted).toHaveLength(0);
    expect(shared).toEqual([[...columns]]);
    expect(pool.ready).toBe(true);
    expect(ready()).toBe(1);
    expect(pool.refused).toBe('annotation fill areas');
    expect(pool.report(1)).toBeNull();
    expect(flagHost.__IFC_LITE_OOC_STATS__).toBeUndefined();
  });

  it('reads its arena budget from the flag, 192 MiB when unset or not a positive number', () => {
    const budgetOf = () => {
      const { pool, posted, columns, facts } = harness();
      pool.offerIndex(...columns);
      pool.offerFacts(facts);
      return posted[0].budgetBytes / (1024 * 1024);
    };
    expect(budgetOf()).toBe(192);
    flagHost.__IFC_LITE_OOC_BUDGET_MB = 48;
    expect(budgetOf()).toBe(48);
    flagHost.__IFC_LITE_OOC_BUDGET_MB = -1;
    expect(budgetOf()).toBe(192);
  });

  it('reports the workers summed, with the largest arena as the peak', () => {
    const stats = (reads: number, peakArenaBytes: number): WorkerSparseStats => ({
      rounds: 1, reads, bytesRead: reads * 10, records: reads, readMs: 0, batches: 2, retries: 1, resets: 0, peakArenaBytes, fetchMs: 0,
    });
    expect(sumSparseStats([stats(3, 100), stats(5, 40)])).toMatchObject({ reads: 8, bytesRead: 80, batches: 4, retries: 2, peakArenaBytes: 100 });

    const { pool } = harness(1);
    pool.stats.push(stats(3, 100), stats(5, 40));
    const summary = pool.report(12);
    expect(summary).toMatchObject({ workers: 2, sourceBytes: 64, poolMs: 12, reads: 8, peakArenaBytes: 100 });
    expect(flagHost.__IFC_LITE_OOC_STATS__).toBe(summary);
  });
});

describe('sparsePoolFor', () => {
  const host = { broadcast: () => {}, shareIndex: () => {}, onReady: () => {} };
  const make = (bytes = 8, options?: { mergeLayers?: boolean }) => sparsePoolFor(new SharedArrayBuffer(bytes), host, options);

  it('keeps a load on the whole-file path for the options an arena cannot serve', () => {
    flagHost.__IFC_LITE_OOC = 1;
    expect(make(8, { mergeLayers: true })).toBeNull();
    expect(make(8, { mergeLayers: false })).toBeInstanceOf(SparsePool);
    flagHost.__IFC_LITE_GLOBAL_INSTANCING = 1;
    expect(make(8), 'the plan does not apply to the small-file tier').toBeInstanceOf(SparsePool);
    expect(make(GLOBAL_INSTANCING_MIN_BYTES)).toBeNull();
  });

  it('clears the stats an earlier load published, whichever path this load takes', () => {
    flagHost.__IFC_LITE_OOC_STATS__ = { workers: 4 };
    expect(make()).toBeNull();
    expect(flagHost.__IFC_LITE_OOC_STATS__).toBeUndefined();
  });

  it('is null unless the flag is on: the load runs the whole-file path', () => {
    expect(make()).toBeNull();
    flagHost.__IFC_LITE_OOC = 0;
    expect(make()).toBeNull();
    flagHost.__IFC_LITE_OOC = '1';
    expect(make()).toBeInstanceOf(SparsePool);
  });
});
