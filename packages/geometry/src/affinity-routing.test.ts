/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { planAffinityRouting } from './geometry-parallel.js';

describe('planAffinityRouting (content-affinity worker routing)', () => {
  it('routes every job exactly once', () => {
    const affinity = new Uint32Array([10, 20, 10, 30, 20, 10]);
    const { buckets } = planAffinityRouting(affinity, 6, 4, new Map(), 0);
    const all = buckets.flat().sort((a, b) => a - b);
    expect(all).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('sends all jobs of one affinity key to the SAME worker', () => {
    const affinity = new Uint32Array([10, 20, 10, 30, 20, 10]);
    const { buckets } = planAffinityRouting(affinity, 6, 4, new Map(), 0);
    const workerOf = (job: number) => buckets.findIndex((b) => b.includes(job));
    // jobs 0,2,5 share key 10; 1,4 share key 20.
    expect(workerOf(0)).toBe(workerOf(2));
    expect(workerOf(2)).toBe(workerOf(5));
    expect(workerOf(1)).toBe(workerOf(4));
  });

  it('round-robins NEW keys across workers', () => {
    // 4 distinct keys, 4 workers → one key per worker.
    const affinity = new Uint32Array([7, 8, 9, 10]);
    const { buckets, nextWorker } = planAffinityRouting(affinity, 4, 4, new Map(), 0);
    expect(buckets.map((b) => b.length)).toEqual([1, 1, 1, 1]);
    expect(nextWorker).toBe(0); // wrapped back around
  });

  it('keeps a key on its worker ACROSS chunks via the sticky map', () => {
    const keyToWorker = new Map<number, number>();
    // Chunk 1: key 42 first seen → worker 0 (startWorker 0).
    const r1 = planAffinityRouting(new Uint32Array([42, 99]), 2, 4, keyToWorker, 0);
    const w42 = r1.buckets.findIndex((b) => b.includes(0));
    // Chunk 2: key 42 reappears (plus new key 7) → must reuse the same worker.
    const r2 = planAffinityRouting(new Uint32Array([7, 42]), 2, 4, keyToWorker, r1.nextWorker);
    expect(r2.buckets[w42]).toContain(1); // job 1 has key 42
  });

  it('advances the round-robin cursor it returns', () => {
    const map = new Map<number, number>();
    const { nextWorker } = planAffinityRouting(new Uint32Array([1, 2]), 2, 4, map, 0);
    expect(nextWorker).toBe(2); // two new keys consumed workers 0,1
  });
});
