/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { findDuplicates } from './duplicates.js';
import { makeExclusionSet, qualifiedKey } from './exclude.js';
import type { ClashElement, Vec3 } from './types.js';

let nextRef = 1;

/** A box element centred at `c` with half-extent `half` and `tris` triangles.
 *  `findDuplicates` reads only `bounds` and the triangle count, so `positions`
 *  can stay empty. */
function box(key: string, c: Vec3, half: number, tris: number, tag = 'IfcWall'): ClashElement {
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag,
    bounds: { min: [c[0] - half, c[1] - half, c[2] - half], max: [c[0] + half, c[1] + half, c[2] + half] },
    positions: new Float32Array(0),
    indices: new Uint32Array(tris * 3),
  };
}

describe('findDuplicates', () => {
  it('flags two coincident, identical elements as an exact duplicate', () => {
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0, 0, 0], 0.5, 12)]);
    expect(res.clashes).toHaveLength(1);
    const c = res.clashes[0];
    expect(c.severity).toBe('major');
    expect(c.rule).toBe('duplicates');
    // Coincident solids embed each other — depth is reported as a real overlap.
    expect(c.distance).toBeLessThan(0);
  });

  it('does not flag elements that are far apart', () => {
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [50, 0, 0], 0.5, 12)]);
    expect(res.clashes).toHaveLength(0);
  });

  it('does not flag merely-adjacent elements below the IoU threshold', () => {
    // Two unit boxes offset by ~0.9 of their width — small overlap, low IoU.
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0.9, 0, 0], 0.5, 12)]);
    expect(res.clashes).toHaveLength(0);
  });

  it('treats a same-place pair with a different triangle count as a looser overlap', () => {
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0, 0, 0], 0.5, 36)]);
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('minor');
  });

  it('never pairs an element with itself (same model + key)', () => {
    const a = box('dup', [0, 0, 0], 0.5, 12);
    const b = { ...box('dup', [0, 0, 0], 0.5, 12), key: 'dup' };
    expect(findDuplicates([a, b]).clashes).toHaveLength(0);
  });

  it('respects the exclusion set', () => {
    const exclusions = makeExclusionSet([[qualifiedKey('m', 'a'), qualifiedKey('m', 'b')]]);
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0, 0, 0], 0.5, 12)], { exclusions });
    expect(res.clashes).toHaveLength(0);
  });

  it('detects coincident degenerate (planar, zero-volume) elements', () => {
    const flatA: ClashElement = {
      key: 'fa', ref: nextRef++, model: 'm', tag: 'IfcSlab',
      bounds: { min: [0, 0, 0], max: [2, 0, 2] }, // zero Y extent
      positions: new Float32Array(0), indices: new Uint32Array(6),
    };
    const flatB: ClashElement = { ...flatA, key: 'fb', ref: nextRef++ };
    expect(findDuplicates([flatA, flatB]).clashes).toHaveLength(1);
  });

  it('produces a coherent summary', () => {
    const res = findDuplicates([
      box('a', [0, 0, 0], 0.5, 12),
      box('b', [0, 0, 0], 0.5, 12),
      box('c', [10, 0, 0], 0.5, 12),
      box('d', [10, 0, 0], 0.5, 12),
    ]);
    expect(res.summary.total).toBe(2);
    expect(res.summary.byRule.duplicates).toBe(2);
  });

  it('finds large duplicates offset by metres even among many small elements', () => {
    // Regression for the mixed-scale gap: a fixed-size grid driven by the small
    // elements would put the two 200 m boxes (offset 4 m, IoU ≈ 0.96) many cells
    // apart and miss them. Sort-and-sweep does not.
    const elements: ClashElement[] = [];
    for (let i = 0; i < 200; i += 1) elements.push(box(`s${i}`, [i * 0.3, 0, 0], 0.1, 6));
    elements.push(box('big-a', [500, 0, 0], 100, 1000));
    elements.push(box('big-b', [504, 0, 0], 100, 1000));
    const res = findDuplicates(elements);
    const ids = res.clashes.map((c) => `${c.a.key}/${c.b.key}`);
    expect(ids).toContain('big-a/big-b');
  });

  it('scales across many cells without missing centre-sharing pairs', () => {
    const elements: ClashElement[] = [];
    for (let i = 0; i < 50; i += 1) {
      const c: Vec3 = [i * 5, 0, 0];
      elements.push(box(`x${i}`, c, 0.5, 12));
      elements.push(box(`y${i}`, c, 0.5, 12)); // a duplicate at each location
    }
    expect(findDuplicates(elements).clashes).toHaveLength(50);
  });
});
