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

/** Like `box`, but with a per-axis half-extent so a shape can be a pipe, a wall
 *  or a slab rather than a cube. */
function boxOf(key: string, c: Vec3, half: Vec3, tris: number): ClashElement {
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag: 'IfcWall',
    bounds: {
      min: [c[0] - half[0], c[1] - half[1], c[2] - half[2]],
      max: [c[0] + half[0], c[1] + half[1], c[2] + half[2]],
    },
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

  it('does not flag merely-adjacent elements', () => {
    // Two unit boxes offset by ~0.9 of their width — they overlap, but nowhere
    // near the same place.
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

  it('applies the SAME displacement tolerance to a pipe, a wall, a cube and a slab', () => {
    // The defect: the gate was AABB intersection-over-union, and for two equal
    // boxes offset by `d` along an axis of extent `e` the IoU is (e−d)/(e+d).
    // IoU ≥ 0.9 therefore means d ≤ e/19 — a tolerance that scales with the
    // object, not with anything a user asked for. One 20 mm displacement was
    // then a duplicate for a slab (e = 8 m → 421 mm allowed) and not for a pipe
    // (e = 0.1 m → 5 mm allowed), from the same setting, in the same model.
    const verdict = (half: Vec3, d: number, opts = {}): boolean => {
      const a = boxOf('a', [0, 0, 0], half, 12);
      const b = boxOf('b', [d, 0, 0], half, 12);
      return findDuplicates([a, b], opts).clashes.length === 1;
    };
    const shapes: Array<[string, Vec3]> = [
      ['pipe D100', [0.05, 0.05, 1.5]],
      ['wall 200 thick', [2, 0.1, 1.5]],
      ['cube 1 m', [0.5, 0.5, 0.5]],
      ['slab 8×8×0.2', [4, 4, 0.1]],
    ];

    // 20 mm is outside the 10 mm default for every shape...
    expect(shapes.map(([name, h]) => [name, verdict(h, 0.02)])).toEqual(
      shapes.map(([name]) => [name, false]),
    );
    // ...and inside a 30 mm tolerance for every shape.
    expect(
      shapes.map(([name, h]) => [name, verdict(h, 0.02, { positionTolerance: 0.03 })]),
    ).toEqual(shapes.map(([name]) => [name, true]));
  });

  it('has an effective tolerance equal to positionTolerance for every shape and axis', () => {
    // The deliverable table: bisect for the largest displacement still reported
    // as a duplicate, per shape per axis. Under the IoU gate these spanned 5 mm
    // to 421 mm from one setting; they must now all be the configured metres.
    const tol = 0.02;
    const effective = (half: Vec3, axis: number): number => {
      let lo = 0;
      let hi = 4;
      for (let i = 0; i < 60; i += 1) {
        const mid = (lo + hi) / 2;
        const c: Vec3 = [0, 0, 0];
        c[axis] = mid;
        const hit = findDuplicates(
          [boxOf('a', [0, 0, 0], half, 12), boxOf('b', c, half, 12)],
          { positionTolerance: tol },
        ).clashes.length === 1;
        if (hit) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const shapes: Array<[string, Vec3]> = [
      ['pipe D100', [0.05, 0.05, 1.5]],
      ['wall 200 thick', [2, 0.1, 1.5]],
      ['cube 1 m', [0.5, 0.5, 0.5]],
      ['slab 8×8×0.2', [4, 4, 0.1]],
    ];
    for (const [name, half] of shapes) {
      for (let axis = 0; axis < 3; axis += 1) {
        const d = effective(half, axis);
        expect(
          Math.abs(d - tol) <= tol * 0.01,
          `${name} axis ${axis}: effective tolerance ${d.toFixed(4)} m, expected ${tol} m`,
        ).toBe(true);
      }
    }
  });

  it('is isotropic: a diagonal displacement of the same length behaves the same', () => {
    // Chebyshev (per-axis) comparison would allow √3 more along the diagonal.
    const half: Vec3 = [0.5, 0.5, 0.5];
    const k = 0.012 / Math.sqrt(3); // |(k,k,k)| = 12 mm
    const diag = findDuplicates([
      boxOf('a', [0, 0, 0], half, 12),
      boxOf('b', [k, k, k], half, 12),
    ]);
    const axial = findDuplicates([
      boxOf('a', [0, 0, 0], half, 12),
      boxOf('b', [0.012, 0, 0], half, 12),
    ]);
    expect(diag.clashes.length).toBe(axial.clashes.length);
    expect(diag.clashes).toHaveLength(0); // 12 mm > the 10 mm default, both ways
  });

  it('reports the tolerance that actually decided the matches', () => {
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0, 0, 0], 0.5, 12)], {
      positionTolerance: 0.05,
    });
    expect(res.settings.tolerance).toBe(0.05);
    // And that number really is the gate: 40 mm in, 60 mm out.
    expect(
      findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0.04, 0, 0], 0.5, 12)], {
        positionTolerance: 0.05,
      }).clashes,
    ).toHaveLength(1);
    expect(
      findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0.06, 0, 0], 0.5, 12)], {
        positionTolerance: 0.05,
      }).clashes,
    ).toHaveLength(0);
  });

  it('counts a size difference, not just a position difference', () => {
    // Same centre, but one box is 40 mm longer on X — its two X faces are 20 mm
    // out. Centre distance alone would call this a perfect duplicate.
    const a = box('a', [0, 0, 0], 0.5, 12);
    const b: ClashElement = {
      ...a, key: 'b', ref: nextRef++,
      bounds: { min: [-0.52, -0.5, -0.5], max: [0.52, 0.5, 0.5] },
    };
    expect(findDuplicates([a, b]).clashes).toHaveLength(0);
    expect(findDuplicates([a, b], { positionTolerance: 0.03 }).clashes).toHaveLength(1);
  });

  it('counts a size difference at ONE end of an axis', () => {
    // A wall extended 40 mm at its far end only: the near faces coincide exactly
    // and the far faces are 40 mm apart. Taking the SMALLER of the two face
    // offsets per axis (or comparing centres, which move only 20 mm) would call
    // this the same object; the pair is not within 10 mm anywhere it differs.
    const a = box('a', [0, 0, 0], 0.5, 12);
    const b: ClashElement = {
      ...a, key: 'b', ref: nextRef++,
      bounds: { min: [-0.5, -0.5, -0.5], max: [0.54, 0.5, 0.5] },
    };
    expect(findDuplicates([a, b]).clashes).toHaveLength(0);
    expect(findDuplicates([a, b], { positionTolerance: 0.05 }).clashes).toHaveLength(1);
  });

  it('does not pair two small elements that do not even touch', () => {
    // Two 5 mm cubes 8 mm apart are within a 10 mm tolerance but are disjoint in
    // space — separate objects, not one object modelled twice.
    //
    // Separated along Y, NOT along the sweep axis. The sort-and-sweep already
    // drops pairs that are apart on the axis it sweeps, so a pair separated
    // along that axis never reaches the gate and cannot show whether the gate
    // itself rejects it. The filler run makes X the sweep axis (widest spread of
    // box minima) so this pair is genuinely offered to the gate.
    const half: Vec3 = [0.0025, 0.0025, 0.0025];
    const filler = (): ClashElement[] =>
      Array.from({ length: 20 }, (_, i) => boxOf(`f${i}`, [i * 0.5, 0, 0], [0.1, 0.1, 0.1], 6));

    const apart = findDuplicates([
      ...filler(),
      boxOf('a', [5, 0, 0], half, 12),
      boxOf('b', [5, 0.008, 0], half, 12),
    ]);
    expect(apart.clashes).toHaveLength(0);

    // 3 mm apart they do overlap, and are reported.
    const touching = findDuplicates([
      ...filler(),
      boxOf('a', [5, 0, 0], half, 12),
      boxOf('b', [5, 0.003, 0], half, 12),
    ]);
    expect(touching.clashes.map((c) => `${c.a.key}/${c.b.key}`)).toEqual(['a/b']);
  });

  it('keeps the degenerate (planar) path at the documented default', () => {
    const flat = (key: string, x: number): ClashElement => ({
      key, ref: nextRef++, model: 'm', tag: 'IfcSlab',
      bounds: { min: [x, 0, 0], max: [x + 2, 0, 2] }, // zero Y extent
      positions: new Float32Array(0), indices: new Uint32Array(6),
    });
    expect(findDuplicates([flat('a', 0), flat('b', 0.009)]).clashes).toHaveLength(1);
    expect(findDuplicates([flat('a', 0), flat('b', 0.011)]).clashes).toHaveLength(0);
  });

  it('marks a nudged same-triangle-count pair minor, and a coincident one major', () => {
    const half: Vec3 = [0.5, 0.5, 0.5];
    const nudged = findDuplicates([
      boxOf('a', [0, 0, 0], half, 12),
      boxOf('b', [0.005, 0, 0], half, 12),
    ]);
    expect(nudged.clashes[0].severity).toBe('minor');
    expect(
      findDuplicates([boxOf('a', [0, 0, 0], half, 12), boxOf('b', [0, 0, 0], half, 12)])
        .clashes[0].severity,
    ).toBe('major');
  });

  it('still honours an explicitly-passed legacy iouThreshold', () => {
    // Deprecated, but a caller that sets it asked for IoU semantics and must not
    // be silently switched: two unit cubes 40 mm apart are an IoU-0.92 pair.
    const a = box('a', [0, 0, 0], 0.5, 12);
    const b = box('b', [0.04, 0, 0], 0.5, 12);
    expect(findDuplicates([a, b], { iouThreshold: 0.9 }).clashes).toHaveLength(1);
    // The default (distance) path rejects the same pair at 10 mm.
    expect(findDuplicates([a, b]).clashes).toHaveLength(0);
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
    // elements would put the two 200 m boxes (offset 4 m, inside the 5 m
    // tolerance this caller configured) many cells apart and miss them.
    // Sort-and-sweep does not.
    const elements: ClashElement[] = [];
    for (let i = 0; i < 200; i += 1) elements.push(box(`s${i}`, [i * 0.3, 0, 0], 0.1, 6));
    elements.push(box('big-a', [500, 0, 0], 100, 1000));
    elements.push(box('big-b', [504, 0, 0], 100, 1000));
    const res = findDuplicates(elements, { positionTolerance: 5 });
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
