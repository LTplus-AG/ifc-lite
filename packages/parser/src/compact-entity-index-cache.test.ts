/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { CompactEntityIndex } from './compact-entity-index.js';

function index(capacity: number, count = 20_000): CompactEntityIndex {
  const ids = Uint32Array.from({ length: count }, (_, i) => i + 1);
  return new CompactEntityIndex(ids, ids.map(id => id * 80), new Uint32Array(count).fill(80),
    new Uint16Array(count), ['IFCWALL'], capacity);
}

/** How many offending ids a failure names before it falls back to a count. */
const PREVIEW = 10;

describe('entity cache eviction after long scans (#3983)', () => {
  it('preserves reference contents and hot entries across eviction and clearing', () => {
    const data = index(3);
    const hot = data.get(1);
    data.get(2);
    const cold = data.get(3);
    // #4110: the 20k-entry scan is the point of this test (it is what forces
    // eviction), but asserting inside it cost ~40k expect() calls and lost the
    // race against the 5000ms timeout on a loaded runner. Record what went
    // wrong and assert once, which also names many bad ids instead of aborting
    // on the first.
    const evictedAt: number[] = [];
    const wrong: string[] = [];
    for (let id = 4; id <= 20_000; id++) {
      if (data.get(1) !== hot) evictedAt.push(id);
      const got = data.get(id);
      if (got?.expressId !== id || got.type !== 'IFCWALL' || got.byteOffset !== id * 80
        || got.byteLength !== 80 || got.lineNumber !== 0) {
        wrong.push(`#${id} was ${JSON.stringify(got)}`);
      }
    }
    expect({
      hotEntryReallocations: evictedAt.length,
      firstHotEntryReallocations: evictedAt.slice(0, PREVIEW),
      wrongEntries: wrong.length,
      firstWrongEntries: wrong.slice(0, PREVIEW),
    }).toEqual({
      hotEntryReallocations: 0,
      firstHotEntryReallocations: [],
      wrongEntries: 0,
      firstWrongEntries: [],
    });
    expect(data.get(3)).not.toBe(cold);
    data.clearCache();
    const renewed = data.get(1);
    expect(renewed).toEqual(hot);
    expect(renewed).not.toBe(hot);
    for (let id = 4; id < 100; id++) { data.get(1); data.get(id); }
    expect(data.get(1)).toBe(renewed);
    expect(data.get(99)?.byteOffset).toBe(7920);
  });

  it('supports zero-capacity caches and invalid lookups without exhausting eviction', () => {
    const data = index(0, 100);
    for (let id = 1; id <= 100; id++) {
      const first = data.get(id);
      expect(data.get(id)).toEqual(first);
      expect(data.get(id)).not.toBe(first);
      expect(data.get(-1)).toBeUndefined();
    }
  });
});
