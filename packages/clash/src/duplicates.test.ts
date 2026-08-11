/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { findDuplicates } from './duplicates.js';
import { groupClashes } from './grouping.js';
import { groupDuplicateSets } from './duplicate-sets.js';
import { makeExclusionSet, qualifiedKey } from './exclude.js';
import type { ClashElement, Vec3 } from './types.js';

let nextRef = 1;

interface Geom {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * A closed, outward-wound box surface from `min` to `max`, each face cut into a
 * `seg × seg` grid — so `seg` controls the tessellation (12·seg² triangles) and
 * nothing else. Subdividing a planar face changes neither the surface area nor
 * the enclosed volume, so every `seg` describes the *same solid*: exactly the
 * "same object, re-tessellated" case the severity rule has to keep together.
 */
function boxMesh(min: Vec3, max: Vec3, seg = 1): Geom {
  const positions: number[] = [];
  const indices: number[] = [];
  const lo = min;
  const hi = max;
  for (let axis = 0; axis < 3; axis += 1) {
    for (let side = 0; side < 2; side += 1) {
      // (u, v) cyclic after `axis` gives an outward +axis normal on the far
      // face; swapping them flips the winding for the near face.
      const cyclic = [(axis + 1) % 3, (axis + 2) % 3];
      const [u, v] = side === 1 ? cyclic : [cyclic[1], cyclic[0]];
      const base = positions.length / 3;
      for (let i = 0; i <= seg; i += 1) {
        for (let j = 0; j <= seg; j += 1) {
          const p = [0, 0, 0];
          p[axis] = side === 1 ? hi[axis] : lo[axis];
          p[u] = lo[u] + ((hi[u] - lo[u]) * i) / seg;
          p[v] = lo[v] + ((hi[v] - lo[v]) * j) / seg;
          positions.push(p[0], p[1], p[2]);
        }
      }
      for (let i = 0; i < seg; i += 1) {
        for (let j = 0; j < seg; j += 1) {
          const a = base + i * (seg + 1) + j;
          const b = a + (seg + 1);
          indices.push(a, b, b + 1, a, b + 1, a + 1);
        }
      }
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * A closed vertical cylinder inscribed in the box `min`..`max` (elliptical if
 * the footprint is not square), with `segments` sides. Same bounding box as
 * `boxMesh` of the same extents, and — at 12 segments — the same 12·2 + caps
 * order of triangle count, but 1 − π/4 ≈ 21% less volume and lateral area.
 */
function cylinderMesh(min: Vec3, max: Vec3, segments: number): Geom {
  const positions: number[] = [];
  const indices: number[] = [];
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const rx = (max[0] - min[0]) / 2;
  const ry = (max[1] - min[1]) / 2;
  for (let i = 0; i < segments; i += 1) {
    const a = (2 * Math.PI * i) / segments;
    positions.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a), min[2]);
    positions.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a), max[2]);
  }
  const bottomCentre = positions.length / 3;
  positions.push(cx, cy, min[2]);
  const topCentre = positions.length / 3;
  positions.push(cx, cy, max[2]);
  for (let i = 0; i < segments; i += 1) {
    const b0 = i * 2;
    const t0 = b0 + 1;
    const b1 = ((i + 1) % segments) * 2;
    const t1 = b1 + 1;
    indices.push(b0, b1, t1, b0, t1, t0); // side, outward
    indices.push(bottomCentre, b1, b0); // bottom cap, downward
    indices.push(topCentre, t0, t1); // top cap, upward
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Pad a mesh's index list out to `tris` triangles with degenerate (zero-area,
 *  zero-volume) ones, so a test can dial the *triangle count* without touching
 *  the *shape*. Truncates instead when `tris` is smaller. */
function withTriangleCount(g: Geom, tris: number): Geom {
  const indices = new Uint32Array(Math.max(0, tris) * 3);
  indices.set(g.indices.subarray(0, Math.min(g.indices.length, indices.length)));
  return { positions: g.positions, indices };
}

function elementOf(key: string, min: Vec3, max: Vec3, g: Geom, tag: string, model: string): ClashElement {
  return {
    key,
    ref: nextRef++,
    model,
    tag,
    bounds: { min: [...min], max: [...max] },
    positions: g.positions,
    indices: g.indices,
  };
}

/** A box element centred at `c` with half-extent `half`, carrying a real box
 *  mesh padded to `tris` triangles. */
function box(
  key: string,
  c: Vec3,
  half: number,
  tris: number,
  tag = 'IfcWall',
  model = 'm',
): ClashElement {
  const min: Vec3 = [c[0] - half, c[1] - half, c[2] - half];
  const max: Vec3 = [c[0] + half, c[1] + half, c[2] + half];
  return elementOf(key, min, max, withTriangleCount(boxMesh(min, max), tris), tag, model);
}

/** Like `box`, but with a per-axis half-extent so a shape can be a pipe, a wall
 *  or a slab rather than a cube. */
function boxOf(key: string, c: Vec3, half: Vec3, tris: number): ClashElement {
  const min: Vec3 = [c[0] - half[0], c[1] - half[1], c[2] - half[2]];
  const max: Vec3 = [c[0] + half[0], c[1] + half[1], c[2] + half[2]];
  return elementOf(key, min, max, withTriangleCount(boxMesh(min, max), tris), 'IfcWall', 'm');
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

  it('treats a same-place pair of DIFFERENT shapes as a looser overlap', () => {
    const min: Vec3 = [-0.5, -0.5, -0.5];
    const max: Vec3 = [0.5, 0.5, 0.5];
    const res = findDuplicates([
      elementOf('a', min, max, boxMesh(min, max), 'IfcColumn', 'm'),
      elementOf('b', min, max, cylinderMesh(min, max, 12), 'IfcColumn', 'm'),
    ]);
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('minor');
  });

  it('never pairs an element with itself (same model + ref)', () => {
    // Suppression-side guard only. Two entries with the same `(model, ref)`
    // necessarily share the key too, so this passes under the old key-based
    // guard as well — it pins that self-pairs stay suppressed, and cannot
    // discriminate the identity change. The discriminating direction (same
    // key, DIFFERENT ref must pair) is 'reports two distinct elements that
    // share one GlobalId' in the duplicated-GlobalId suite below.
    const a = box('dup', [0, 0, 0], 0.5, 12);
    const b = { ...a };
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
    // Shapes chosen so the OLD IoU gate gives the OPPOSITE verdict on both
    // probes — a unit cube would pass them under either gate (#2530 review):
    // a 0.1 m cube offset 40 mm has IoU (0.1−0.04)/(0.1+0.04) ≈ 0.43 < 0.9
    // (old: dropped) but is inside a 50 mm distance; an 8 m slab offset 60 mm
    // has IoU (8−0.06)/(8+0.06) ≈ 0.985 ≥ 0.9 (old: reported) but is outside
    // it. So this can only pass while `positionTolerance` is the number doing
    // the work, and `settings.tolerance` reports that same number.
    const probe = (half: Vec3, d: number) =>
      findDuplicates([boxOf('a', [0, 0, 0], half, 12), boxOf('b', [d, 0, 0], half, 12)], {
        positionTolerance: 0.05,
      });
    const smallIn = probe([0.05, 0.05, 0.05], 0.04);
    expect(smallIn.clashes).toHaveLength(1);
    expect(smallIn.settings.tolerance).toBe(0.05);
    const slabOut = probe([4, 4, 0.1], 0.06);
    expect(slabOut.clashes).toHaveLength(0);
    expect(slabOut.settings.tolerance).toBe(0.05);
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

  it('does not pair two disjoint sheets offset along their own normal', () => {
    // Two zero-thickness sheets 9 mm apart along Y — their normal — have clear
    // air between them on that axis, so under the distance gate they are two
    // objects (`boxesTouch` fails), even though 9 mm is inside the 10 mm
    // tolerance. The legacy IoU fallback (`aabbApproxEqual`) DID report this
    // pair; the exclusion is deliberate (see the boxesTouch doc + the
    // distance-tolerance changeset), and the legacy branch still honours the
    // old reading. The filler makes X the sweep axis, so the pair genuinely
    // reaches the gate instead of being evicted by the sweep along Y (#2530
    // review, minor 4: the in-plane sibling test cannot see this direction).
    const filler = Array.from({ length: 20 }, (_, i) =>
      boxOf(`f${i}`, [i * 2 + 10, 0, 0], [0.1, 0.1, 0.1], 6));
    const sheet = (key: string, y: number): ClashElement => ({
      key, ref: nextRef++, model: 'm', tag: 'IfcPlate',
      bounds: { min: [0, y, 0], max: [2, y, 2] }, // zero Y extent
      positions: new Float32Array(0), indices: new Uint32Array(6),
    });
    expect(findDuplicates([...filler, sheet('a', 0), sheet('b', 0.009)]).clashes)
      .toHaveLength(0);
    // Same fixture through the legacy branch: still reported there.
    expect(
      findDuplicates([...filler, sheet('a', 0), sheet('b', 0.009)], { iouThreshold: 0.9 })
        .clashes,
    ).toHaveLength(1);
    // And coincident sheets (zero gap) still qualify under the distance gate.
    expect(findDuplicates([...filler, sheet('a', 0), sheet('b', 0)]).clashes)
      .toHaveLength(1);
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

describe('exact-duplicate severity is a shape signature, not a triangle count', () => {
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0.4, 0.4, 3];

  it('keeps a re-tessellated copy of the same solid EXACT', () => {
    // The defect, direction 1: a genuine duplicate re-tessellated on re-import
    // (12 vs 48 triangles, geometrically the identical box) was demoted to
    // `minor`, so a user filtering to `major` lost a real duplicate.
    const res = findDuplicates([
      elementOf('a', min, max, boxMesh(min, max, 1), 'IfcColumn', 'm'),
      elementOf('b', min, max, boxMesh(min, max, 2), 'IfcColumn', 'm'),
    ]);
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('major');
  });

  it('is invariant across three different tessellations of one box', () => {
    // Not a coincidence of one subdivision level: 12, 48 and 192 triangles all
    // describe the same solid, so every pair is exact.
    const res = findDuplicates([
      elementOf('a', min, max, boxMesh(min, max, 1), 'IfcColumn', 'm'),
      elementOf('b', min, max, boxMesh(min, max, 2), 'IfcColumn', 'm'),
      elementOf('c', min, max, boxMesh(min, max, 4), 'IfcColumn', 'm'),
    ]);
    expect(res.clashes.map((c) => c.severity)).toEqual(['major', 'major', 'major']);
  });

  it('does NOT call a round and a square column of equal bounds an exact duplicate', () => {
    // The defect, direction 2: both are 48 triangles inside the same bounding
    // box, so the triangle count promoted them to `major` — a fake "exact
    // duplicate" of two objects that are not the same object at all.
    const square = elementOf('sq', min, max, boxMesh(min, max, 2), 'IfcColumn', 'm');
    const round = elementOf('rd', min, max, cylinderMesh(min, max, 12), 'IfcColumn', 'm');
    expect(square.indices.length).toBe(round.indices.length); // same triangle count
    const res = findDuplicates([square, round]);
    // Still reported — it IS a coincident pair — but not as an exact duplicate.
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('minor');
  });

  it('tolerates the extra volume a finer facet count adds to a curved solid', () => {
    // A 12- and a 36-segment column differ by 4.0% in enclosed volume purely
    // because facets are chords: the same authored solid, re-tessellated.
    const res = findDuplicates([
      elementOf('a', min, max, cylinderMesh(min, max, 12), 'IfcColumn', 'm'),
      elementOf('b', min, max, cylinderMesh(min, max, 36), 'IfcColumn', 'm'),
    ]);
    expect(res.clashes[0].severity).toBe('major');
  });

  it('applies the SAME shape tolerance to a 50 mm fixing and a 30 m tank', () => {
    // The tolerance is relative for the same reason the position tolerance is
    // physical: one number has to mean one thing at every scale. An absolute
    // area/volume epsilon would call two different 50 mm objects identical
    // (their whole surface is a few thousandths of a square metre) and split a
    // re-tessellated 30 m tank (4% of it is hundreds of cubic metres).
    const tinyMin: Vec3 = [0, 0, 0];
    const tinyMax: Vec3 = [0.05, 0.05, 0.05];
    const tiny = findDuplicates([
      elementOf('a', tinyMin, tinyMax, boxMesh(tinyMin, tinyMax), 'IfcDiscreteAccessory', 'm'),
      elementOf('b', tinyMin, tinyMax, cylinderMesh(tinyMin, tinyMax, 12), 'IfcDiscreteAccessory', 'm'),
    ]);
    expect(tiny.clashes[0].severity).toBe('minor');

    const bigMin: Vec3 = [0, 0, 0];
    const bigMax: Vec3 = [10, 10, 30];
    const big = findDuplicates([
      elementOf('a', bigMin, bigMax, cylinderMesh(bigMin, bigMax, 12), 'IfcTank', 'm'),
      elementOf('b', bigMin, bigMax, cylinderMesh(bigMin, bigMax, 36), 'IfcTank', 'm'),
    ]);
    expect(big.clashes[0].severity).toBe('major');
  });

  it('will not promote an element whose geometry the caller did not supply', () => {
    // `major` claims the two meshes were compared. With no vertices there is
    // nothing to compare, so the honest answer is the weaker label.
    const bare = (key: string): ClashElement => ({
      key, ref: nextRef++, model: 'm', tag: 'IfcColumn',
      bounds: { min: [...min], max: [...max] },
      positions: new Float32Array(0), indices: new Uint32Array(36),
    });
    const res = findDuplicates([bare('a'), bare('b')]);
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('minor');
  });

  it('separates two coincident SHEETS by area alone', () => {
    // Both are flat, so both enclose zero volume and only the area term can
    // tell them apart: a full 2x2 sheet against the diagonal half of one.
    const sheet = (key: string, tris: number[][]): ClashElement => {
      const positions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2]);
      return {
        key, ref: nextRef++, model: 'm', tag: 'IfcAnnotation',
        bounds: { min: [0, 0, 0], max: [2, 0, 2] },
        positions, indices: new Uint32Array(tris.flat()),
      };
    };
    const full = sheet('full', [[0, 1, 2], [0, 2, 3]]); // area 4
    const halfSheet = sheet('half', [[0, 1, 2]]); // area 2
    expect(findDuplicates([full, halfSheet]).clashes[0].severity).toBe('minor');
    // Two copies of the same sheet still are exact, so the assertion above is
    // about the area and not about sheets never being exact.
    expect(findDuplicates([full, sheet('full2', [[0, 1, 2], [0, 2, 3]])]).clashes[0].severity)
      .toBe('major');
  });

  it('separates two solids by volume alone, when their areas match exactly', () => {
    // Same triangles, same total area — but one has its top face wound inward,
    // so it does not enclose the solid it appears to. Only the volume term sees
    // that.
    const good = boxMesh([0, 0, 0], [1, 1, 1], 1);
    const flipped = {
      positions: good.positions,
      indices: Uint32Array.from(good.indices),
    };
    // Reverse the winding of the last face only (2 triangles = 6 indices).
    const n = flipped.indices.length;
    for (let t = n - 6; t < n; t += 3) {
      const tmp = flipped.indices[t + 1];
      flipped.indices[t + 1] = flipped.indices[t + 2];
      flipped.indices[t + 2] = tmp;
    }
    const a = elementOf('a', [0, 0, 0], [1, 1, 1], good, 'IfcColumn', 'm');
    const b = elementOf('b', [0, 0, 0], [1, 1, 1], flipped, 'IfcColumn', 'm');
    expect(findDuplicates([a, b]).clashes[0].severity).toBe('minor');
  });

  it('is blind to a WHOLLY reversed winding, which is the same solid', () => {
    const good = boxMesh([0, 0, 0], [1, 1, 1], 1);
    const reversed = { positions: good.positions, indices: Uint32Array.from(good.indices) };
    for (let t = 0; t < reversed.indices.length; t += 3) {
      const tmp = reversed.indices[t + 1];
      reversed.indices[t + 1] = reversed.indices[t + 2];
      reversed.indices[t + 2] = tmp;
    }
    const a = elementOf('a', [0, 0, 0], [1, 1, 1], good, 'IfcColumn', 'm');
    const b = elementOf('b', [0, 0, 0], [1, 1, 1], reversed, 'IfcColumn', 'm');
    expect(findDuplicates([a, b]).clashes[0].severity).toBe('major');
  });

  it('measures the shape in WORLD space, through the element transform', () => {
    // Same local box, but one element is scaled 2x by its placement. The bounds
    // say they coincide; the signature must see two different solids, or a
    // transform-only difference would read as an exact duplicate.
    const local = boxMesh([0, 0, 0], [0.4, 0.4, 3], 1);
    const half = boxMesh([0, 0, 0], [0.2, 0.2, 1.5], 1);
    const a: ClashElement = {
      key: 'a', ref: nextRef++, model: 'm', tag: 'IfcColumn',
      bounds: { min: [...min], max: [...max] },
      positions: local.positions, indices: local.indices,
    };
    const b: ClashElement = {
      key: 'b', ref: nextRef++, model: 'm', tag: 'IfcColumn',
      bounds: { min: [...min], max: [...max] },
      positions: half.positions, indices: half.indices,
      // column-major scale-by-2, which maps `half` exactly onto `local`
      transform: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
    };
    expect(findDuplicates([a, b]).clashes[0].severity).toBe('major');
    // Drop the transform and the same vertex data is a half-size solid, which
    // is NOT the same shape — so the assertion above is about the transform.
    const untransformed = { ...b, transform: undefined };
    expect(findDuplicates([a, untransformed]).clashes[0].severity).toBe('minor');
  });
});

describe('duplicated GlobalIds', () => {
  // A file may carry the same GlobalId on two genuinely different entities —
  // `ifc-lite validate` reports it as a defect, and "the same element exported
  // twice" is the single case a duplicate hunt most wants surfaced. Identity
  // must therefore be the express id (`ref`), not the key.
  const twinsSharingAKey = (): ClashElement[] => [
    { ...box('SAME-GLOBALID', [0, 0, 0], 0.5, 12), ref: 101 },
    { ...box('SAME-GLOBALID', [0, 0, 0], 0.5, 12), ref: 102 },
  ];

  it('reports two distinct elements that share one GlobalId', () => {
    const res = findDuplicates(twinsSharingAKey());
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('major');
    expect(res.clashes[0].a.key).toBe('SAME-GLOBALID');
    expect(res.clashes[0].b.key).toBe('SAME-GLOBALID');
  });

  it('gives such a pair distinct clash ids, so neither is deduped away', () => {
    // Three copies under one GlobalId are three pairs. On a key-only id they
    // would collapse to one string and `seen` would drop two of them.
    const res = findDuplicates([
      { ...box('SAME-GLOBALID', [0, 0, 0], 0.5, 12), ref: 101 },
      { ...box('SAME-GLOBALID', [0, 0, 0], 0.5, 12), ref: 102 },
      { ...box('SAME-GLOBALID', [0, 0, 0], 0.5, 12), ref: 103 },
    ]);
    expect(res.clashes).toHaveLength(3);
    expect(new Set(res.clashes.map((c) => c.id)).size).toBe(3);
  });

  it('counts them as two objects when grouped into a set', () => {
    const groups = groupDuplicateSets(findDuplicates(twinsSharingAKey()));
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toContain('2 coincident');
  });

  it('leaves the clash ids of a well-formed file untouched', () => {
    // The ref only enters an id for a key that two different elements actually
    // share, so no existing finding is renamed by this.
    const res = findDuplicates([box('a', [0, 0, 0], 0.5, 12), box('b', [0, 0, 0], 0.5, 12)]);
    expect(res.clashes[0].id).toBe('duplicates m a m b');
  });

  it('does not rename an id just because an element emitted several meshes', () => {
    // `a` arrives as two meshes (same key AND same ref), which repeats the key
    // without making it ambiguous. Keying the id off "this key appeared twice"
    // rather than "two different elements carry it" would suffix every
    // multi-material element's findings.
    const a1 = box('a', [0, 0, 0], 0.5, 12);
    const a2 = { ...box('a', [0, 0, 0], 0.5, 12), ref: a1.ref };
    const res = findDuplicates([a1, a2, box('b', [0, 0, 0], 0.5, 12)]);
    expect(res.clashes.map((c) => c.id)).toEqual(['duplicates m a m b']);
  });

  it('still skips the several meshes one element emits', () => {
    // An element with more than one material/CSG part becomes several
    // ClashElements sharing BOTH key and ref. Those are one object, and pairing
    // them would report every multi-material element as its own duplicate.
    const part = box('wall-1', [0, 0, 0], 0.5, 12);
    const otherPart = { ...box('wall-1', [0, 0, 0], 0.5, 12), ref: part.ref };
    expect(findDuplicates([part, otherPart]).clashes).toHaveLength(0);
  });
});

describe('multi-mesh elements (one mesh per material / CSG part)', () => {
  // An element with several materials arrives as several ClashElements sharing
  // key and ref. All cross-submesh pairs of one element pair collapse to a
  // single clash id, so the severity of that one finding must be a property of
  // the ELEMENT pair — not of whichever submesh pair the sweep happened to
  // reach first (#2530 review, minor 5).

  /** Twenty spread-out boxes so X is the sweep axis (widest spread of minima)
   *  and the fixture pairs below are ordered purely by insertion order. */
  const filler = (): ClashElement[] =>
    Array.from({ length: 20 }, (_, i) => boxOf(`f${i}`, [i + 20, 0, 0], [0.1, 0.1, 0.1], 6));

  it('labels an exact duplicate major even when a mismatched submesh pair is swept first', () => {
    // Element A = a box part + a cylinder part in the same bounds (areas differ
    // by 22%); A' is an exact copy. The array interleaves the copies so the
    // first cross pair the sweep offers is box-vs-cylinder: comparing SUBMESH
    // signatures there reads "shapes disagree" and locks the finding at minor,
    // dropping the matching box/box and cylinder/cylinder pairs behind the
    // deduped id. Comparing ELEMENT signatures (summed over its parts) makes
    // the label independent of that order.
    const min: Vec3 = [0, 0, 0];
    const max: Vec3 = [1, 1, 1];
    const part = (key: string, ref: number, g: Geom): ClashElement => ({
      key, ref, model: 'm', tag: 'IfcWall',
      bounds: { min: [...min], max: [...max] },
      positions: g.positions, indices: g.indices,
    });
    const r1 = nextRef++;
    const r2 = nextRef++;
    const res = findDuplicates([
      ...filler(),
      part('w', r1, boxMesh(min, max)),
      part('w2', r2, cylinderMesh(min, max, 12)),
      part('w', r1, cylinderMesh(min, max, 12)),
      part('w2', r2, boxMesh(min, max)),
    ]);
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('major');
  });

  it('upgrades the deduped finding when a LATER submesh pair shows the copies coincide', () => {
    // Here the mismatch is positional, not shape: each element has a part at
    // y=0 and a part at y=5 mm. The first cross pair the sweep offers is a
    // cross-part one, 5 mm apart — within positionTolerance but outside
    // exactTolerance, so it records the (deduped) finding as minor. The
    // matching parts then coincide exactly; first-pair-wins keeps the stale
    // minor, exactly the "genuine exact duplicate reads as a loose overlap"
    // failure.
    const part = (key: string, ref: number, y: number): ClashElement => {
      const min: Vec3 = [0, y, 0];
      const max: Vec3 = [1, y + 0.2, 1];
      const g = boxMesh(min, max);
      return {
        key, ref, model: 'm', tag: 'IfcWall',
        bounds: { min: [...min], max: [...max] },
        positions: g.positions, indices: g.indices,
      };
    };
    const r1 = nextRef++;
    const r2 = nextRef++;
    const res = findDuplicates([
      ...filler(),
      part('w', r1, 0),
      part('w2', r2, 0.005),
      part('w', r1, 0.005),
      part('w2', r2, 0),
    ]);
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('major');
  });

  it('gives the same severity with the element order reversed', () => {
    // The complement of the two tests above: whatever order the sweep visits
    // the submesh pairs in, the one deduped finding reads the same.
    const min: Vec3 = [0, 0, 0];
    const max: Vec3 = [1, 1, 1];
    const part = (key: string, ref: number, g: Geom): ClashElement => ({
      key, ref, model: 'm', tag: 'IfcWall',
      bounds: { min: [...min], max: [...max] },
      positions: g.positions, indices: g.indices,
    });
    const r1 = nextRef++;
    const r2 = nextRef++;
    const parts = [
      part('w', r1, boxMesh(min, max)),
      part('w2', r2, cylinderMesh(min, max, 12)),
      part('w', r1, cylinderMesh(min, max, 12)),
      part('w2', r2, boxMesh(min, max)),
    ];
    const forward = findDuplicates([...filler(), ...parts]);
    const backward = findDuplicates([...filler(), ...parts.reverse()]);
    expect(forward.clashes.map((c) => [c.id, c.severity]))
      .toEqual(backward.clashes.map((c) => [c.id, c.severity]));
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
    // a/b are the same solid (exact, `major`); c is a round column in the same
    // bounds, so a/c and b/c are `minor`. Whichever member the group is built
    // from, the set is major.
    const min: Vec3 = [-0.5, -0.5, -0.5];
    const max: Vec3 = [0.5, 0.5, 0.5];
    const res = findDuplicates([
      box('a', [0, 0, 0], 0.5, 12),
      box('b', [0, 0, 0], 0.5, 12),
      elementOf('c', min, max, cylinderMesh(min, max, 12), 'IfcWall', 'm'),
    ]);
    expect(res.clashes.map((c) => c.severity).sort()).toEqual(['major', 'minor', 'minor']);
    const groups = groupDuplicateSets(res);
    expect(groups).toHaveLength(1);
    expect(groups[0].severity).toBe('major');
  });

  it('leaves an all-minor set minor', () => {
    const min: Vec3 = [-0.5, -0.5, -0.5];
    const max: Vec3 = [0.5, 0.5, 0.5];
    const res = findDuplicates([
      box('a', [0, 0, 0], 0.5, 12),
      elementOf('b', min, max, cylinderMesh(min, max, 12), 'IfcWall', 'm'),
    ]);
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

/**
 * A hollow vertical tube (outer wall, inner wall, annular end caps) inscribed in
 * `min`..`max` — a real pipe or sleeve rather than a solid rod, so a pipe nested
 * in a sleeve is two distinct solids and not one scaled copy of the other.
 */
function tubeMesh(min: Vec3, max: Vec3, innerFrac: number, segments: number): Geom {
  const positions: number[] = [];
  const indices: number[] = [];
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const outer = (max[0] - min[0]) / 2;
  const inner = outer * innerFrac;
  for (const radius of [outer, inner]) {
    for (let i = 0; i < segments; i += 1) {
      const a = (2 * Math.PI * i) / segments;
      positions.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a), min[2]);
      positions.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a), max[2]);
    }
  }
  const innerBase = segments * 2;
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments;
    const ob0 = i * 2, ot0 = ob0 + 1, ob1 = j * 2, ot1 = ob1 + 1;
    const ib0 = innerBase + i * 2, it0 = ib0 + 1, ib1 = innerBase + j * 2, it1 = ib1 + 1;
    indices.push(ob0, ob1, ot1, ob0, ot1, ot0); // outer wall, outward
    indices.push(ib0, it1, ib1, ib0, it0, it1); // inner wall, inward
    indices.push(ob0, ib0, ib1, ob0, ib1, ob1); // bottom annulus, downward
    indices.push(ot0, it1, it0, ot0, ot1, it1); // top annulus, upward
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * The three mid-planes of the box `min`..`max`, each emitted twice with opposite
 * winding. It fills the same bounding box as `boxMesh(min, max)` and — for a
 * unit cube — carries the same total surface area (6 m²), but it is a set of
 * loose sheets, so the signed volume of every triangle is cancelled by its
 * reversed twin and the enclosed volume is exactly 0 against the box's 1 m³.
 * The pair therefore agrees on area and can only be separated on volume.
 */
function midPlanesMesh(min: Vec3, max: Vec3): Geom {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
    const base = positions.length / 3;
    for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const p = [0, 0, 0];
      p[axis] = (min[axis] + max[axis]) / 2;
      p[u] = su ? max[u] : min[u];
      p[v] = sv ? max[v] : min[v];
      positions.push(p[0], p[1], p[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    indices.push(base + 2, base + 1, base, base + 3, base + 2, base);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * A railing-style assembly spanning `min`..`max`: `posts` thin uprights plus a
 * top rail. Same bounding box as `boxMesh(min, max)`, a wholly different solid.
 */
function postsMesh(min: Vec3, max: Vec3, posts: number, thick: number): Geom {
  const positions: number[] = [];
  const indices: number[] = [];
  const append = (g: Geom): void => {
    const base = positions.length / 3;
    for (const value of g.positions) positions.push(value);
    for (const i of g.indices) indices.push(base + i);
  };
  for (let p = 0; p < posts; p += 1) {
    const x = Math.min(min[0] + ((max[0] - min[0]) * p) / (posts - 1), max[0] - thick);
    append(boxMesh([x, min[1], min[2]], [x + thick, min[1] + thick, max[2]]));
  }
  append(boxMesh([min[0], min[1], max[2] - thick], [max[0], max[1], max[2]]));
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * The nested-solids limit (D4), pinned by measurement rather than left to prose.
 *
 * `findDuplicates` matches on AABBs, so two elements holding different solids
 * inside the same bounds are, in principle, indistinguishable to the matcher.
 * These tests record how far the two gates that *do* exist already carry that
 * case, so a later change cannot quietly erode it:
 *
 * - The corner-distance gate rejects loose nesting outright. Real nesting has an
 *   annulus: a duct in its shaft and a pipe in a standard sleeve are tens of
 *   millimetres apart in bounds, far outside the 10 mm default, so they are
 *   never reported at all.
 * - The shape signature blocks the rest from ever being labelled `major`. A
 *   nested pair that survives the distance gate still has to match on surface
 *   area *and* enclosed volume, which two genuinely different solids do not.
 *
 * What is left is a tightly nested pair — under about 7 mm of annulus — reported
 * as a `minor` candidate overlap. That is the documented, deliberate behaviour:
 * the pass reports the coincidence and declines to call it the same object.
 */
describe('findDuplicates: nested solids sharing bounds', () => {
  const pipe = (key: string, radius: number): ClashElement => {
    const min: Vec3 = [-radius, -radius, 0];
    const max: Vec3 = [radius, radius, 1];
    return elementOf(key, min, max, tubeMesh(min, max, 0.9, 24), 'IfcPipeSegment', 'm');
  };

  it('never reports a pipe in a normally-sized sleeve (12.5 mm annulus)', () => {
    // DN100 pipe through a DN125 sleeve. The bounds differ by 12.5 mm on two
    // axes — 17.7 mm of corner distance, well outside the 10 mm default — so
    // the pair never reaches the shape gate at all.
    const res = findDuplicates([pipe('pipe', 0.05), pipe('sleeve', 0.0625)]);
    expect(res.clashes).toEqual([]);
  });

  it('reports a pipe in a tight sleeve (5 mm annulus) as a candidate overlap', () => {
    // 7.07 mm of corner distance squeezes inside the 10 mm gate, so this pair IS
    // reported. This is the residual the AABB matcher cannot remove.
    const res = findDuplicates([pipe('pipe', 0.05), pipe('sleeve', 0.055)]);
    expect(res.clashes).toHaveLength(1);
  });

  it('will not call that tight sleeve an exact duplicate even at a 10 mm exactTolerance', () => {
    // Raising `exactTolerance` to cover the whole 7.07 mm takes the distance gate
    // out of the decision, so the ONLY thing left holding this pair at `minor`
    // is the shape signature — a 50 mm and a 55 mm tube differ by 9.1% in
    // surface area and 17.4% in enclosed volume, both far outside the 5% band.
    const res = findDuplicates([pipe('pipe', 0.05), pipe('sleeve', 0.055)], {
      exactTolerance: 0.01,
    });
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('minor');
  });

  it('keeps an assembly and its envelope minor, though their bounds are identical', () => {
    // A railing and a solid box drawn around it: zero corner distance, so only
    // the shape signature separates them.
    const min: Vec3 = [0, 0, 0];
    const max: Vec3 = [2, 0.05, 1.1];
    const res = findDuplicates([
      elementOf('railing', min, max, postsMesh(min, max, 5, 0.04), 'IfcRailing', 'm'),
      elementOf('envelope', min, max, boxMesh(min, max), 'IfcBuildingElementProxy', 'm'),
    ]);
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('minor');
  });

  it('separates loose sheets from the solid that shares their bounds AND their area', () => {
    // Both elements fill the unit cube and both carry 6 m² of surface, so area
    // alone says "same shape". Only the enclosed volume — 1 m³ against 0 —
    // tells the solid from the sheets, which is why the signature is a pair of
    // numbers and not just the area.
    const min: Vec3 = [0, 0, 0];
    const max: Vec3 = [1, 1, 1];
    const res = findDuplicates([
      elementOf('solid', min, max, boxMesh(min, max), 'IfcSlab', 'm'),
      elementOf('sheets', min, max, midPlanesMesh(min, max), 'IfcPlate', 'm'),
    ]);
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('minor');
  });

  it('still calls a genuine re-tessellated copy an exact duplicate', () => {
    // The bounding control: none of the above may be bought by demoting real
    // duplicates.
    const min: Vec3 = [0, 0, 0];
    const max: Vec3 = [1, 1, 3];
    const res = findDuplicates([
      elementOf('a', min, max, boxMesh(min, max, 1), 'IfcColumn', 'm'),
      elementOf('b', min, max, boxMesh(min, max, 4), 'IfcColumn', 'm'),
    ]);
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].severity).toBe('major');
  });
});
