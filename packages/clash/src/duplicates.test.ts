/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { findDuplicates } from './duplicates.js';
import { groupClashes, groupDuplicateSets } from './grouping.js';
import { makeExclusionSet, qualifiedKey } from './exclude.js';
import type { ClashElement, Vec3 } from './types.js';

let nextRef = 1;

/** A box element centred at `c` with half-extent `half` and `tris` triangles.
 *  `findDuplicates` reads only `bounds` and the triangle count, so `positions`
 *  can stay empty. */
function box(
  key: string,
  c: Vec3,
  half: number,
  tris: number,
  tag = 'IfcWall',
  model = 'm',
): ClashElement {
  return {
    key,
    ref: nextRef++,
    model,
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

  it('does not evict a same-position candidate at the exact sweep boundary', () => {
    // Two zero-volume (point) elements at the identical location: bounds.min ===
    // bounds.max on every axis, so the sweep's own max[axis] EQUALS the next
    // candidate's min[axis] exactly. The sweep must keep (not evict) a candidate
    // whose max sits exactly at the new element's min — an `<=` eviction there
    // would drop the pair before `consider()` ever sees it, silently losing a
    // genuine coincident-element duplicate.
    const p: ClashElement = {
      key: 'pa', ref: nextRef++, model: 'm', tag: 'IfcColumn',
      bounds: { min: [3, 3, 3], max: [3, 3, 3] },
      positions: new Float32Array(0), indices: new Uint32Array(6),
    };
    const q: ClashElement = { ...p, key: 'pb', ref: nextRef++ };
    expect(findDuplicates([p, q]).clashes).toHaveLength(1);
  });

  it('reports a pair whose IoU is EXACTLY the threshold', () => {
    // A = [0,1]³, B = [0,1]²×[0,2]: intersection 1, union 1 + 2 − 1 = 2, so the
    // IoU is exactly 0.5 — no rounding involved. `sim < threshold` rejects means
    // the threshold itself qualifies; an exclusive `<=` silently drops the pair
    // that sits precisely on the value the caller configured.
    const a: ClashElement = {
      key: 'a', ref: nextRef++, model: 'm', tag: 'IfcWall',
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      positions: new Float32Array(0), indices: new Uint32Array(36),
    };
    const b: ClashElement = {
      ...a, key: 'b', ref: nextRef++,
      bounds: { min: [0, 0, 0], max: [1, 1, 2] },
    };
    expect(findDuplicates([a, b], { iouThreshold: 0.5 }).clashes).toHaveLength(1);
    // Just above the exact IoU it is correctly rejected, so the assertion above
    // is a boundary decision and not "this pair always overlaps".
    expect(findDuplicates([a, b], { iouThreshold: 0.5000001 }).clashes).toHaveLength(0);
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

describe('groupDuplicateSets', () => {
  it('collapses three mutually-coincident objects into ONE finding', () => {
    // The user-visible complaint: three copies of one column produce 3 pairwise
    // rows and each copy is named in 2 of them. As a set it is one issue.
    const res = findDuplicates([
      box('a', [0, 0, 0], 0.5, 12),
      box('b', [0, 0, 0], 0.5, 12),
      box('c', [0, 0, 0], 0.5, 12),
    ]);
    expect(res.clashes).toHaveLength(3);

    const groups = groupDuplicateSets(res);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].title).toContain('3 coincident');
    expect(groups[0].id).toMatch(/^grp-[0-9a-f]{8}$/);
  });

  it('keeps two duplicate sets that stand close together as TWO findings', () => {
    // Each set is a coincident pair; the sets are 1 m apart — closer than the
    // 1.5 m default cluster radius, but not duplicates OF EACH OTHER.
    const res = findDuplicates([
      box('a1', [0, 0, 0], 0.1, 12),
      box('a2', [0, 0, 0], 0.1, 12),
      box('b1', [1, 0, 0], 0.1, 12),
      box('b2', [1, 0, 0], 0.1, 12),
    ]);
    expect(res.clashes).toHaveLength(2);

    // This is precisely why spatial clustering is the wrong tool here: it fuses
    // the two unrelated sets into a single bogus finding.
    expect(groupClashes(res, { by: 'cluster' })).toHaveLength(1);

    // Connected components over the pair graph keep them apart, with no epsilon.
    const groups = groupDuplicateSets(res);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.members.length === 1)).toBe(true);
  });

  it('reports a lone coincident pair as exactly one finding', () => {
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0, 0, 0], 0.5, 12)]);
    const groups = groupDuplicateSets(res);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(1);
    expect(groups[0].title).toContain('2 coincident');
  });

  it('produces no findings when nothing is duplicated', () => {
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [50, 0, 0], 0.5, 12)]);
    expect(res.clashes).toHaveLength(0);
    expect(groupDuplicateSets(res)).toEqual([]);
  });

  it('surfaces a set as major when ANY member pair is an exact duplicate', () => {
    // a/b share a triangle count (exact, `major`); c differs, so a/c and b/c are
    // `minor`. Whichever member the group is built from, the set is major.
    const res = findDuplicates([
      box('a', [0, 0, 0], 0.5, 12),
      box('b', [0, 0, 0], 0.5, 12),
      box('c', [0, 0, 0], 0.5, 36),
    ]);
    expect(res.clashes.map((c) => c.severity).sort()).toEqual(['major', 'minor', 'minor']);
    const groups = groupDuplicateSets(res);
    expect(groups).toHaveLength(1);
    expect(groups[0].severity).toBe('major');
  });

  it('leaves an all-minor set minor', () => {
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0, 0, 0], 0.5, 36)]);
    expect(groupDuplicateSets(res)[0].severity).toBe('minor');
  });

  it('groups a set that spans models, keyed on (model, key)', () => {
    // The classic federation case: the same object delivered in three files.
    // A second, spatially separate object shares its keys across the same models,
    // so a grouping that ignored `model` would fuse everything into one set.
    const res = findDuplicates([
      box('w1', [0, 0, 0], 0.5, 12, 'IfcWall', 'arch'),
      box('w1', [0, 0, 0], 0.5, 12, 'IfcWall', 'struct'),
      box('w1', [0, 0, 0], 0.5, 12, 'IfcWall', 'mep'),
      box('w2', [40, 0, 0], 0.5, 12, 'IfcWall', 'arch'),
      box('w2', [40, 0, 0], 0.5, 12, 'IfcWall', 'struct'),
    ]);
    const groups = groupDuplicateSets(res);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.title)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('3 coincident'),
        expect.stringContaining('2 coincident'),
      ]),
    );
  });

  it('is order-independent and deterministic', () => {
    const elements = [
      box('a', [0, 0, 0], 0.5, 12),
      box('b', [0, 0, 0], 0.5, 12),
      box('c', [0, 0, 0], 0.5, 12),
      box('d', [30, 0, 0], 0.5, 12),
      box('e', [30, 0, 0], 0.5, 12),
    ];
    const forward = groupDuplicateSets(findDuplicates(elements));
    const backward = groupDuplicateSets(findDuplicates([...elements].reverse()));
    expect(forward.map((g) => g.id)).toEqual(backward.map((g) => g.id));
    expect(forward.map((g) => g.members.length)).toEqual([3, 1]);
  });
});
