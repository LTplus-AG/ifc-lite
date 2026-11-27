/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  batchRoots,
  buildVoidLookup,
  ensureSparseClosure,
  installChunk,
  findIndexRow,
  planReads,
  sabByteSource,
  SPARSE_FULL_CLOSURE,
  type OutOfCoreIndex,
  type SparseFetchStats,
  type SparseSourceApi,
} from './out-of-core.js';

/** Records `#id` at the given offsets; ids ascending as the pre-pass index is. */
function indexOf(rows: Array<[id: number, start: number, length: number]>): OutOfCoreIndex {
  return {
    ids: Uint32Array.from(rows.map((row) => row[0])),
    starts: Uint32Array.from(rows.map((row) => row[1])),
    lengths: Uint32Array.from(rows.map((row) => row[2])),
  };
}

const newStats = (): SparseFetchStats => ({ rounds: 0, reads: 0, bytesRead: 0, records: 0, readMs: 0 });

describe('findIndexRow', () => {
  it('finds each id of an ascending column and rejects the gaps', () => {
    const ids = Uint32Array.from([3, 7, 8, 40]);
    expect([3, 7, 8, 40].map((id) => findIndexRow(ids, id))).toEqual([0, 1, 2, 3]);
    expect([0, 5, 39, 41].map((id) => findIndexRow(ids, id))).toEqual([-1, -1, -1, -1]);
    expect(findIndexRow(new Uint32Array(0), 1)).toBe(-1);
  });
});

describe('planReads', () => {
  const index = indexOf([[1, 0, 10], [2, 10, 10], [3, 500, 10], [4, 5000, 20], [5, 5020, 0]]);
  const plan = { gapBytes: 512, maxReadBytes: 1000 };

  it('merges records that sit within the gap into one read, in file order', () => {
    const { reads, absent } = planReads(index, Uint32Array.from([3, 1, 2]), plan);
    expect(absent.length).toBe(0);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ offset: 0, length: 20 + 480 + 10 });
    // [id, offset in the read, length] per record.
    expect([...reads[0].spans]).toEqual([1, 0, 10, 2, 10, 10, 3, 500, 10]);
  });

  it('starts a new read past the gap, and past the size limit', () => {
    expect(planReads(index, Uint32Array.from([1, 4]), plan).reads.map((read) => [read.offset, read.length])).toEqual([[0, 10], [5000, 20]]);
    const tight = planReads(index, Uint32Array.from([1, 2, 3]), { gapBytes: 512, maxReadBytes: 100 });
    expect(tight.reads.map((read) => [read.offset, read.length])).toEqual([[0, 20], [500, 10]]);
  });

  it('names an id the index does not hold, or holds with no bytes, as absent', () => {
    const { reads, absent } = planReads(index, Uint32Array.from([9, 5, 2]), plan);
    expect([...absent]).toEqual([9, 5]);
    expect(reads.map((read) => [...read.spans])).toEqual([[2, 0, 10]]);
  });
});

describe('ensureSparseClosure', () => {
  /** A fake arena over a reference graph: `sparseExpand` names what the walk reaches and the arena lacks. */
  function fakeArena(references: Record<number, number[]>) {
    const installed = new Map<number, string>();
    const absent = new Set<number>();
    const api: SparseSourceApi = {
      sparseExpand(ids, maxDepth) {
        expect(maxDepth).toBe(SPARSE_FULL_CLOSURE);
        const missing = new Set<number>();
        const seen = new Set<number>();
        const walk = (id: number): void => {
          if (seen.has(id) || absent.has(id)) return;
          seen.add(id);
          if (!installed.has(id)) { missing.add(id); return; }
          for (const next of references[id] ?? []) walk(next);
        };
        ids.forEach(walk);
        return Uint32Array.from(missing);
      },
      sparseInstall(spans, chunk) {
        for (let i = 0; i < spans.length; i += 3) {
          installed.set(spans[i], new TextDecoder().decode(chunk.slice(spans[i + 1], spans[i + 1] + spans[i + 2])));
        }
      },
      sparseMarkAbsent(ids) { ids.forEach((id) => absent.add(id)); },
    };
    return { api, installed, absent };
  }

  it('installs the whole reference closure of the roots, each record with its own bytes, and nothing else', () => {
    const text = '#1=A(#2);#2=B(#3,#9);#3=C();#4=UNRELATED();';
    const buffer = new SharedArrayBuffer(text.length);
    new Uint8Array(buffer).set(new TextEncoder().encode(text));
    const index = indexOf([[1, 0, 9], [2, 9, 12], [3, 21, 7], [4, 28, 15]]);
    const { api, installed, absent } = fakeArena({ 1: [2], 2: [3, 9] });
    const stats = newStats();

    ensureSparseClosure(api, sabByteSource(buffer), index, Uint32Array.from([1]), stats);

    expect([...installed]).toEqual([[1, '#1=A(#2);'], [2, '#2=B(#3,#9);'], [3, '#3=C();']]);
    expect([...absent]).toEqual([9]); // referenced, not in the file: retired so the walk terminates
    expect(stats).toMatchObject({ rounds: 3, records: 3, bytesRead: 9 + 12 + 7 });
  });

  it('reads nothing when the arena already holds the closure', () => {
    const { api } = fakeArena({});
    const stats = newStats();
    const source = { size: 0, read: () => { throw new Error('read'); } };
    api.sparseInstall(Uint32Array.from([1, 0, 0]), new Uint8Array(0));
    ensureSparseClosure(api, source, indexOf([[1, 0, 4]]), Uint32Array.from([1]), stats);
    expect(stats).toEqual(newStats());
  });
});

describe('installChunk', () => {
  it('installs the same bytes as a copy when the runtime refuses a view over shared memory', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4)).fill(7);
    const seen: Uint8Array[] = [];
    const api = {
      sparseInstall(_spans: Uint32Array, chunk: Uint8Array) {
        seen.push(chunk);
        if (chunk.buffer instanceof SharedArrayBuffer) throw new TypeError('shared view refused');
      },
    } as unknown as SparseSourceApi;
    installChunk(api, new Uint32Array(3), shared);
    expect(seen).toHaveLength(2);
    expect(seen[1].buffer).toBeInstanceOf(ArrayBuffer);
    expect([...seen[1]]).toEqual([7, 7, 7, 7]);
  });

  it('does not retry after a wasm trap: the instance is unusable', () => {
    let calls = 0;
    const api = { sparseInstall() { calls++; throw new WebAssembly.RuntimeError('unreachable'); } } as unknown as SparseSourceApi;
    expect(() => installChunk(api, new Uint32Array(3), new Uint8Array(new SharedArrayBuffer(4)))).toThrow('unreachable');
    expect(calls).toBe(1);
  });

  it('does not retry an install that failed on a plain buffer', () => {
    const api = { sparseInstall() { throw new Error('unreachable'); } } as unknown as SparseSourceApi;
    expect(() => installChunk(api, new Uint32Array(3), new Uint8Array(4))).toThrow('unreachable');
  });
});

describe('batchRoots', () => {
  it('is each job id followed by the openings that cut it', () => {
    const voids = buildVoidLookup(Uint32Array.from([10, 30]), Uint32Array.from([2, 1]), Uint32Array.from([101, 102, 301]));
    // Jobs are [id, start, end] triples.
    const jobs = Uint32Array.from([10, 0, 5, 20, 5, 5, 30, 10, 5]);
    expect([...batchRoots(jobs, voids)]).toEqual([10, 101, 102, 20, 30, 301]);
  });
});
