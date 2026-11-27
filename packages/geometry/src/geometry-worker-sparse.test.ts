/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MAX_MISS_RETRIES, WorkerSparseSession, type BatchCallArgs, type GeometryWorkerSetSparseSourceMessage, type SparseBatchApi } from './geometry-worker-sparse.js';

const MIB = 1024 * 1024;

function setup(budgetBytes = 192 * MIB): GeometryWorkerSetSparseSourceMessage {
  const text = '#1=A();#2=B();#3=C();';
  const sharedBuffer = new SharedArrayBuffer(text.length);
  new Uint8Array(sharedBuffer).set(new TextEncoder().encode(text));
  return {
    type: 'set-sparse-source', sharedBuffer, preamble: new Uint8Array([1, 2, 3]),
    inverseTargets: Uint32Array.from([5]), inverseReferrers: Uint32Array.from([6]),
    indexIds: Uint32Array.from([1, 2, 3]), indexStarts: Uint32Array.from([0, 7, 14]), indexLengths: Uint32Array.from([7, 7, 7]),
    budgetBytes,
  };
}

/** A fake wasm surface: records calls, and reports `misses[n]` after the n-th batch run. */
function fakeApi(misses: number[][] = [], arenaBytes = 0) {
  const calls: string[] = [];
  const installed = new Set<number>();
  let runs = 0;
  const output = (kind: string) => ({ kind, run: runs, freed: false, free() { this.freed = true; } });
  const api = {
    sparseBegin: (preamble: Uint8Array, reserve: number) => { calls.push(`begin ${preamble.length} ${reserve}`); },
    sparseSetInverseEdges: (targets: Uint32Array, referrers: Uint32Array) => { calls.push(`edges ${targets[0]}>${referrers[0]}`); },
    sparseExpand: (ids: Uint32Array) => ids.filter((id) => !installed.has(id)),
    sparseInstall: (spans: Uint32Array) => { for (let i = 0; i < spans.length; i += 3) installed.add(spans[i]); },
    sparseMarkAbsent: (ids: Uint32Array) => { ids.forEach((id) => installed.add(id)); },
    sparseTakeMisses: () => Uint32Array.from(misses[runs - 1] ?? []),
    sparseStats: () => Float64Array.from([arenaBytes]),
    sparseReset: () => { calls.push('reset'); },
    sparseInvalidateDerived: () => { calls.push('invalidate'); },
    processGeometryBatchSparse: () => { runs++; return output('flat'); },
    processGeometryBatchPartitionedSparse: () => { runs++; return output('partitioned'); },
  };
  return { api: api as unknown as SparseBatchApi, calls, installed, runs: () => runs };
}

/** Batch arguments for one job on entity `id`. */
function argsFor(id: number): BatchCallArgs {
  const none = new Uint32Array(0);
  return [Uint32Array.from([id, 0, 7]), 1, 0, 0, 0, false, none, none, none, none, new Uint8Array(0), undefined, undefined, undefined, undefined];
}

type FakeOutput = { kind: string; run: number; freed: boolean };

describe('WorkerSparseSession', () => {
  it('starts the wasm session with the preamble, the inverse edges and one reservation above the budget', () => {
    const { api, calls } = fakeApi();
    new WorkerSparseSession(setup(8)).applyTo(api);
    expect(calls).toEqual(['begin 3 10', 'edges 5>6']);
  });

  it('never reserves more than the file and the preamble can fill', () => {
    const { api, calls } = fakeApi();
    new WorkerSparseSession(setup(192 * MIB)).applyTo(api);
    expect(calls[0]).toBe(`begin 3 ${3 + 21}`); // the fixture source is 21 bytes
  });

  it('starts the session from a copy of the preamble when the runtime refuses the shared one', () => {
    const { api } = fakeApi();
    const begun: Uint8Array[] = [];
    api.sparseBegin = (preamble: Uint8Array) => {
      begun.push(preamble);
      if (preamble.buffer instanceof SharedArrayBuffer) throw new TypeError('shared view refused');
    };
    const shared = setup();
    shared.preamble = new Uint8Array(new SharedArrayBuffer(3)).fill(9);
    new WorkerSparseSession(shared).applyTo(api);
    expect(begun.map((preamble) => preamble.buffer instanceof SharedArrayBuffer)).toEqual([true, false]);
    expect([...begun[1]]).toEqual([9, 9, 9]);
  });

  it('fetches the batch closure, then meshes with the flat or the partitioned variant', () => {
    const { api, installed } = fakeApi();
    const session = new WorkerSparseSession(setup());
    expect(session.mesh(api, argsFor(2), false) as unknown as FakeOutput).toMatchObject({ kind: 'flat' });
    expect([...installed]).toEqual([2]);
    expect(session.mesh(api, argsFor(3), true) as unknown as FakeOutput).toMatchObject({ kind: 'partitioned' });
    expect(session.stats).toMatchObject({ batches: 2, retries: 0, records: 2 });
  });

  it('runs a batch again after installing a record its first run missed, and frees the replaced output', () => {
    // Run 1 misses #3 (in the file) and #99 (not in the file: the whole-file answer is a miss too).
    const { api, calls, installed, runs } = fakeApi([[3, 99]]);
    const session = new WorkerSparseSession(setup());
    const outputs: FakeOutput[] = [];
    const out = session.runBatch(api, argsFor(1)[0], { keys: new Uint32Array(0), counts: new Uint32Array(0), values: new Uint32Array(0) }, () => {
      const made = api.processGeometryBatchSparse(...argsFor(1)) as unknown as FakeOutput & { free(): void };
      outputs.push(made);
      return made;
    });
    expect(runs()).toBe(2);
    expect(out).toBe(outputs[1]);
    expect(outputs.map((made) => made.freed)).toEqual([true, false]);
    expect([...installed].sort()).toEqual([1, 3]);
    expect(calls).toContain('invalidate');
    expect(session.stats.retries).toBe(1);
  });

  it('refuses a batch that still misses records after the retry limit, leaving no output alive', () => {
    const { api, runs } = fakeApi(Array.from({ length: MAX_MISS_RETRIES + 1 }, () => [2]));
    const session = new WorkerSparseSession(setup());
    const outputs: FakeOutput[] = [];
    expect(() => session.runBatch(api, argsFor(1)[0], { keys: new Uint32Array(0), counts: new Uint32Array(0), values: new Uint32Array(0) }, () => {
      const made = api.processGeometryBatchSparse(...argsFor(1)) as unknown as FakeOutput & { free(): void };
      outputs.push(made);
      return made;
    })).toThrow(/still misses 1 record\(s\) after 4 retries \(first #2\)/);
    expect(runs()).toBe(MAX_MISS_RETRIES + 1);
    expect(outputs.every((made) => made.freed)).toBe(true);
  });

  it('frees the output it holds when the bookkeeping after a batch throws', () => {
    const { api } = fakeApi();
    api.sparseStats = () => { throw new Error('stats failed'); };
    const outputs: FakeOutput[] = [];
    expect(() => new WorkerSparseSession(setup()).runBatch(api, argsFor(1)[0], { keys: new Uint32Array(0), counts: new Uint32Array(0), values: new Uint32Array(0) }, () => {
      const made = api.processGeometryBatchSparse(...argsFor(1)) as unknown as FakeOutput & { free(): void };
      outputs.push(made);
      return made;
    })).toThrow('stats failed');
    expect(outputs.map((made) => made.freed)).toEqual([true]);
  });

  it('drops the arena back to its preamble once it passes the budget, after the batch', () => {
    const over = fakeApi([], 11 * MIB);
    const session = new WorkerSparseSession(setup(10 * MIB));
    session.mesh(over.api, argsFor(1), false);
    expect(over.calls).toEqual(['reset']);
    expect(session.stats).toMatchObject({ resets: 1, peakArenaBytes: 11 * MIB });

    const under = fakeApi([], 9 * MIB);
    new WorkerSparseSession(setup(10 * MIB)).mesh(under.api, argsFor(1), false);
    expect(under.calls).toEqual([]);
  });
});
