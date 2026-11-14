/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane: relationship queries filter every related id through `has`,
// millions of calls while a large model's hierarchy renders. After warm-up the
// answer comes from a bitset built once, never from a binary search, and it is
// the same answer.
import { describe, it, expect } from 'vitest';
import { CompactEntityIndex } from './compact-entity-index.js';
import { LazyMembership } from './compact-entity-index-membership.js';

function index(ids: number[]): CompactEntityIndex {
  const sorted = Uint32Array.from(ids).sort();
  const n = sorted.length;
  return new CompactEntityIndex(sorted, new Uint32Array(n), new Uint32Array(n).fill(1), new Uint16Array(n), ['IFCWALL']);
}

/** Every id in [-2, max+40] plus out-of-range probes: the bitset must agree with the binary search. */
function probes(max: number): number[] {
  const out: number[] = [];
  for (let id = -2; id <= max + 40; id++) out.push(id);
  return out.concat([2 ** 31, 2 ** 32 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER, 0.5]);
}

/** `undefined` answers: the lookups LazyMembership leaves to the index's binary search. */
const deferred = (m: LazyMembership, probes: number[]) => probes.filter((id) => m.has(id) === undefined).length;
const sortedIds = (ids: number[]) => Uint32Array.from(ids).sort();

describe('CompactEntityIndex.has membership', () => {
  // Dense ids with gaps, duplicates (#7675) and ids at every bit position of a word, including bit 31.
  const ids = [0, 1, 2, 2, 2, 5, 31, 32, 33, 63, 64, 95, 96, 127, 1000, 1023, 1024, 4095];
  for (let i = 4096; i < 6000; i += 3) ids.push(i);

  it('answers every probe the same as the binary search, before and after the bitset exists', () => {
    const idx = index(ids);
    const reference = new Set(ids);
    const answers = probes(6000).map((id) => idx.has(id));
    expect(answers).toEqual(probes(6000).map((id) => reference.has(id)));
    // The probes above crossed the warm-up: ask again, now from the bitset.
    expect(probes(6000).map((id) => idx.has(id))).toEqual(answers);
  });

  it('answers from the bitset after warm-up: the binary search is left only the first lookups', () => {
    const m = new LazyMembership(sortedIds(ids));
    const lookups = Array.from({ length: 5000 }, (_, k) => k % 6100);
    expect(deferred(m, lookups)).toBe(255);
    expect(lookups.every((id) => typeof m.has(id) === 'boolean')).toBe(true);
  });

  it('keeps the binary search for an id range too sparse for a bitset', () => {
    const sparse = [1, 10, 2 ** 30, 2 ** 31 + 7];
    const idx = index(sparse);
    const answers = Array.from({ length: 600 }, (_, k) => idx.has(sparse[k % 4] + (k % 3 === 0 ? 1 : 0)));
    expect(answers).toEqual(Array.from({ length: 600 }, (_, k) => k % 3 !== 0));
    expect(deferred(new LazyMembership(sortedIds(sparse)), Array.from({ length: 600 }, (_, k) => k))).toBe(600);
  });

  it('keeps the binary search, without throwing, when the bitset cannot be allocated', () => {
    const m = new LazyMembership(sortedIds(ids), () => { throw new RangeError('Array buffer allocation failed'); });
    const lookups = Array.from({ length: 600 }, (_, k) => k);
    expect(() => deferred(m, lookups)).not.toThrow();
    expect(deferred(m, lookups)).toBe(600);
  });

  it('answers false once the columns are detached, as the binary search did', () => {
    const idx = index(ids);
    for (let k = 0; k < 300; k++) idx.has(k);
    expect(idx.has(5)).toBe(true);
    const columns = idx.getColumns();
    structuredClone(columns.expressIds.buffer, { transfer: [columns.expressIds.buffer] });
    expect(idx.has(5)).toBe(false);
  });
});
