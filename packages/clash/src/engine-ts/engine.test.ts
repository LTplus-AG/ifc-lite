/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createClashEngine } from '../engine.js';
import { TsKernel } from './ts-kernel.js';
import { makeExclusionSet, qualifiedKey } from '../exclude.js';
import { fromPositions } from '../math/aabb.js';
import type { ClashElement, ClashRule, Vec3 } from '../types.js';

/** Axis-aligned cube as a triangle mesh (12 triangles). */
function makeBox(center: Vec3, size: number): { positions: Float32Array; indices: Uint32Array } {
  const h = size / 2;
  const [cx, cy, cz] = center;
  const v: number[] = [
    cx - h, cy - h, cz - h,
    cx + h, cy - h, cz - h,
    cx + h, cy + h, cz - h,
    cx - h, cy + h, cz - h,
    cx - h, cy - h, cz + h,
    cx + h, cy - h, cz + h,
    cx + h, cy + h, cz + h,
    cx - h, cy + h, cz + h,
  ];
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ]);
  return { positions: new Float32Array(v), indices };
}

let nextRef = 1;
function boxElement(key: string, tag: string, center: Vec3, size = 1): ClashElement {
  const { positions, indices } = makeBox(center, size);
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag,
    bounds: fromPositions(positions),
    positions,
    indices,
  };
}

/** Box corners in the canonical order, given a centre and per-axis half-extents. */
function boxCorners(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): Vec3[] {
  return [
    [cx - hx, cy - hy, cz - hz],
    [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz],
    [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz],
    [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz],
    [cx - hx, cy + hy, cz + hz],
  ];
}

const BOX_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
  1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
]);

/** Box element with independent per-axis half-extents (for crossing bars). */
function boxElementHxyz(key: string, tag: string, center: Vec3, half: Vec3): ClashElement {
  const corners = boxCorners(center[0], center[1], center[2], half[0], half[1], half[2]);
  const positions = new Float32Array(corners.flat());
  return { key, ref: nextRef++, model: 'm', tag, bounds: fromPositions(positions), positions, indices: BOX_INDICES };
}

const PRISM_INDICES = new Uint32Array([
  0, 1, 2, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5,
]);

const L_PRISM_INDICES = new Uint32Array([
  // bottom cap (fan from 0), top cap (fan from 6)
  0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4,
  6, 7, 8, 6, 8, 9, 6, 9, 10, 6, 10, 11,
  // sides (one quad per footprint edge)
  0, 1, 7, 0, 7, 6, 1, 2, 8, 1, 8, 7, 2, 3, 9, 2, 9, 8,
  3, 4, 10, 3, 10, 9, 4, 5, 11, 4, 11, 10, 5, 0, 6, 5, 6, 11,
]);

/**
 * Closed, CONCAVE L-shaped prism: footprint (0,0)-(2,0)-(2,1)-(1,1)-(1,2)-(0,2)
 * extruded z=0..1. The square [1,2]x[1,2] is a notch: inside the AABB but
 * OUTSIDE the solid, so a small box sitting in the notch is AABB-contained
 * while only its faces cross the notch wall at x=1.
 */
function lPrismElement(key: string, tag: string): ClashElement {
  const positions = new Float32Array([
    // bottom (z=0): 0..5
    0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0,
    // top (z=1): 6..11
    0, 0, 1, 2, 0, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 0, 2, 1,
  ]);
  return { key, ref: nextRef++, model: 'm', tag, bounds: fromPositions(positions), positions, indices: L_PRISM_INDICES };
}

/** Closed triangular prism: `footprint` (XY) extruded between z0 and z1. */
function triPrismElement(
  key: string,
  tag: string,
  footprint: [Vec3, Vec3, Vec3] | [[number, number], [number, number], [number, number]],
  z0: number,
  z1: number,
): ClashElement {
  const [p0, p1, p2] = footprint as [[number, number], [number, number], [number, number]];
  const v = [
    p0[0], p0[1], z0, p1[0], p1[1], z0, p2[0], p2[1], z0,
    p0[0], p0[1], z1, p1[0], p1[1], z1, p2[0], p2[1], z1,
  ];
  const positions = new Float32Array(v);
  return { key, ref: nextRef++, model: 'm', tag, bounds: fromPositions(positions), positions, indices: PRISM_INDICES };
}

/**
 * `n` unit boxes stacked almost on top of each other, tags alternating, so
 * every A x B pair survives the broad phase and the run is dominated by
 * narrow-phase triangle work — long enough to be interrupted part-way.
 */
function overlappingBoxes(n: number): ClashElement[] {
  const elements: ClashElement[] = [];
  for (let i = 0; i < n; i += 1) {
    elements.push(boxElement(`k${i}`, i % 2 === 0 ? 'IfcWall' : 'IfcDuct', [i * 0.001, 0, 0]));
  }
  return elements;
}

const engine = createClashEngine({ backend: 'ts' });
const hard = (over: Partial<ClashRule> = {}): ClashRule => ({
  id: 'r',
  name: 'rule',
  a: 'IfcWall',
  b: 'IfcDuct',
  mode: 'hard',
  ...over,
});

describe('TsClashEngine', () => {
  it('detects a hard clash between overlapping elements', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [0.5, 0, 0]),
    ];
    const result = await engine.run(elements, [hard()]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
    expect(result.clashes[0].distance).toBeLessThan(0);
    expect(result.summary.byRule.r).toBe(1);
    // The coplanar/flush overlap must report the real (non-degenerate) overlap
    // region so it renders as a visible penetration box (#1402), not a zero-size
    // box. Overlap of the two unit cubes offset 0.5 in x is 0.5 x 1 x 1.
    const b = result.clashes[0].bounds;
    expect(b.max[0] - b.min[0]).toBeGreaterThan(0.4);
    expect(b.max[0] - b.min[0]).toBeLessThan(0.6);
    expect(b.max[1] - b.min[1]).toBeGreaterThan(0.5);
    expect(b.max[2] - b.min[2]).toBeGreaterThan(0.5);
  });

  it('reports no clash for separated elements in hard mode', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [2, 0, 0]),
    ];
    const result = await engine.run(elements, [hard()]);
    expect(result.summary.total).toBe(0);
  });

  it('finds a clearance violation within the gap, not outside it', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [2, 0, 0]), // 1.0 m face-to-face gap
    ];
    const tooTight = await engine.run(elements, [hard({ mode: 'clearance', clearance: 0.5 })]);
    expect(tooTight.summary.total).toBe(0);

    const wide = await engine.run(elements, [hard({ mode: 'clearance', clearance: 1.5 })]);
    expect(wide.summary.total).toBe(1);
    expect(wide.clashes[0].status).toBe('clearance');
    expect(wide.clashes[0].distance).toBeCloseTo(1.0, 3);
  });

  it('suppresses touching elements unless reportTouch is set', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [1, 0, 0]), // faces meet at x = 0.5
    ];
    const suppressed = await engine.run(elements, [hard()]);
    expect(suppressed.summary.total).toBe(0);

    const reported = await engine.run(elements, [hard({ reportTouch: true })]);
    expect(reported.summary.total).toBe(1);
    expect(reported.clashes[0].status).toBe('touch');
  });

  it('honors the exclusion set', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [0.5, 0, 0]),
    ];
    const exclusions = makeExclusionSet([[qualifiedKey('m', 'A'), qualifiedKey('m', 'B')]]);
    const result = await engine.run(elements, [hard()], { exclusions });
    expect(result.summary.total).toBe(0);
  });

  it('runs a self-clash within one selection', async () => {
    const elements = [
      boxElement('A', 'IfcBeam', [0, 0, 0]),
      boxElement('B', 'IfcBeam', [0.5, 0, 0]), // overlaps A
      boxElement('C', 'IfcBeam', [10, 0, 0]), // far away
    ];
    const result = await engine.run(elements, [
      { id: 'self', name: 'beam self-clash', a: 'IfcBeam', mode: 'hard' },
    ]);
    expect(result.summary.total).toBe(1);
  });

  it('infers severity from the discipline matrix when not given', async () => {
    const elements = [
      boxElement('A', 'IfcDuctSegment', [0, 0, 0]),
      boxElement('B', 'IfcBeam', [0.5, 0, 0]),
    ];
    const result = await engine.run(elements, [
      { id: 'hvac-str', name: 'HVAC vs STR', a: 'IfcDuct*', b: 'IfcBeam', mode: 'hard' },
    ]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].severity).toBe('critical');
  });

  it('produces deterministic, stable clash ids and ordering', async () => {
    const build = () => [
      boxElement('B', 'IfcDuct', [0.5, 0, 0]),
      boxElement('A', 'IfcWall', [0, 0, 0]),
    ];
    const first = await engine.run(build(), [hard()]);
    const second = await engine.run(build(), [hard()]);
    expect(first.clashes[0].id).toBe(second.clashes[0].id);
  });

  it('throws when the abort signal is already aborted', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [0.5, 0, 0]),
    ];
    const controller = new AbortController();
    controller.abort();
    await expect(engine.run(elements, [hard()], { signal: controller.signal })).rejects.toThrow();
  });

});

/**
 * Cancellation, driven at the kernel so the assertions are deterministic.
 *
 * Every canceller a caller can realistically wire up fires from the event loop:
 * a run deadline (this is how the script sandbox cancels), a cancel button, a
 * host teardown. The narrow phase used to yield only when an `onProgress`
 * callback was supplied, so without one the loop never returned to the event
 * loop, a timer never ran, and `signal` amounted to "refuse to start" rather
 * than "cancel" — measured, a 200 ms timer against a 426 ms run aborted nothing
 * at all.
 *
 * A zero yield interval is what makes these tests deterministic rather than a
 * race against the host's clock: the loop reaches the event loop on a fixed
 * *pair* cadence (every 256) instead of a time-based one, so the outcome does
 * not depend on how fast the machine is. Everything else — the checkpoints, the
 * checks, the rejection — is the shipping code path; `TsClashEngine.run` is the
 * same call with the default interval.
 */
describe('TsKernel cancellation (#2419)', () => {
  // 24 walls x 24 ducts = 576 candidate pairs: checkpoints at 0, 256 and 512,
  // so a run spans several yields however fast it executes.
  const elements = overlappingBoxes(48);
  const evens = elements.map((_, i) => i).filter((i) => i % 2 === 0);
  const odds = elements.map((_, i) => i).filter((i) => i % 2 === 1);

  const detect = (
    signal: AbortSignal,
    maxPairs = Infinity,
    onProgress?: (done: number, total: number) => void,
  ) => new TsKernel(0).detectRule(elements, evens, odds, hard(), 0, maxPairs, signal, onProgress);

  it('observes an abort raised by a timer mid-run, with no onProgress callback', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, 0);
    try {
      await expect(detect(controller.signal)).rejects.toThrow(/aborted/i);
    } finally {
      clearTimeout(timer);
    }
  });

  it('does not finish a run whose abort lands during the yield itself', async () => {
    // `onProgress` fires immediately before the yield, so aborting from it puts
    // the abort inside the yield window — past the pre-yield check. Aimed at
    // the LAST checkpoint (512 of 576) on purpose: there is no later checkpoint
    // to catch it, so the recheck on the way back from the await is the only
    // thing that can stop this run. Without it, the run quietly completes.
    const controller = new AbortController();
    await expect(
      detect(controller.signal, Infinity, (done) => { if (done === 512) controller.abort(); }),
    ).rejects.toThrow(/aborted/i);
  });

  it('lets a cancellation beat the maxCandidatePairs cap', async () => {
    // The cap bites on the first iteration (`maxPairs` 0), and the periodic
    // check used to sit after that exit — so the run returned a truncated
    // result without ever yielding, and the abort armed below never landed.
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, 0);
    try {
      await expect(detect(controller.signal, 0)).rejects.toThrow(/aborted/i);
    } finally {
      clearTimeout(timer);
    }
  });

  it('completes normally when nothing aborts it', async () => {
    // The control: the same eager-yield path with a signal that never fires
    // must still produce the full result, so the tests above fail for the
    // cancellation and not for the yielding.
    const controller = new AbortController();
    const detection = await detect(controller.signal);
    expect(detection.candidatesProcessed).toBe(576);
    expect(detection.records.length).toBeGreaterThan(0);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('TsClashEngine: false-positive + bounds regressions (#1362 / #1402)', () => {
  const wallDuct = (over: Partial<ClashRule> = {}): ClashRule => ({
    id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct', mode: 'hard', ...over,
  });

  it('does not report a hard clash for skewed members that only share a face (Bug A)', async () => {
    // Two wedges meeting flush at a slanted face: their axis-aligned bounds overlap
    // fully, but the solids share NO volume. The old AABB-penetration proxy fired a
    // false hard clash here.
    const elements = [
      triPrismElement('A', 'IfcWall', [[0, 0], [2, 0], [0, 2]], 0, 1),
      triPrismElement('B', 'IfcDuct', [[2, 0], [0, 2], [5, 5]], 0, 1),
    ];
    const result = await engine.run(elements, [wallDuct()]);
    expect(result.summary.total).toBe(0);
  });

  it('still reports a hard clash when members genuinely interpenetrate (Bug A recall)', async () => {
    // Same wedge A, but a box that straddles the slanted face -> real shared volume.
    const elements = [
      triPrismElement('A', 'IfcWall', [[0, 0], [2, 0], [0, 2]], 0, 1),
      boxElementHxyz('B', 'IfcDuct', [1, 1, 0.5], [0.5, 0.5, 0.5]),
    ];
    const result = await engine.run(elements, [wallDuct()]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
  });

  it('still reports a hard clash for unequal-length aligned members that overlap (Bug A recall #1455)', async () => {
    // A long bar x[-5,5] and a short bar x[4.9,5.9] sharing y/z extents overlap by
    // 0.1 m. The vertex-centroid midpoint (~x=2.7) lies outside the short bar, so a
    // single centroid probe would drop this real clash; the overlap-centre probe
    // keeps it.
    const a = boxElementHxyz('A', 'IfcWall', [0, 0, 0], [5, 0.5, 0.5]);
    const b = boxElementHxyz('B', 'IfcDuct', [5.4, 0, 0], [0.5, 0.5, 0.5]);
    const result = await engine.run([a, b], [wallDuct()]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
  });

  it('reports a tight contact box for a genuine crossing, not the element overlap (Bug B)', async () => {
    // Perpendicular bars: A runs along X, B along Y, crossing near the origin.
    const a = boxElementHxyz('A', 'IfcWall', [0, 0, 0], [5, 0.5, 0.5]);
    const b = boxElementHxyz('B', 'IfcDuct', [0, 0, 0], [0.5, 5, 0.5]);
    const result = await engine.run([a, b], [wallDuct()]);
    expect(result.summary.total).toBe(1);
    const { bounds } = result.clashes[0];
    // Tight along the long bar: A spans x[-5,5] (10 m), but the contact is only the
    // local crossing (~B's 1 m width), so the box must NOT span A's full length.
    expect(bounds.max[0] - bounds.min[0]).toBeLessThan(2.0);
    // And it must stay within the element-OVERLAP AABB on every axis, not just
    // element A: A is the long X bar, so an A-only check would still pass if the
    // box expanded across A's whole 10 m X span. The overlap is x[-0.5,0.5] (B's
    // width) on X, y[-0.5,0.5] (A's width) on Y, z[-0.5,0.5] on Z.
    for (let i = 0; i < 3; i += 1) {
      const overlapMin = Math.max(a.bounds.min[i], b.bounds.min[i]);
      const overlapMax = Math.min(a.bounds.max[i], b.bounds.max[i]);
      expect(bounds.min[i]).toBeGreaterThanOrEqual(overlapMin - 1e-6);
      expect(bounds.max[i]).toBeLessThanOrEqual(overlapMax + 1e-6);
    }
  });
});

describe('TsClashEngine: contained-pair penetration depth (#1866)', () => {
  it('reports the mesh-level depth, not the AABB gap, for a contained crossing pair', async () => {
    // Box in the L's notch, AABB-contained in the L's AABB, dipping past the
    // notch wall at x=1 into the solid. True mesh penetration = 1 - xMin.
    const wall = lPrismElement('A', 'IfcWall');
    const duct = boxElementHxyz('B', 'IfcDuct', [1.2, 1.4, 0.5], [0.25, 0.2, 0.2]);
    const result = await engine.run([wall, duct], [hard()]);
    expect(result.summary.total).toBe(1);
    const clash = result.clashes[0];
    expect(clash.status).toBe('hard');
    const expected = 1 - duct.bounds.min[0]; // ~0.05, f32-exact from the mesh
    expect(expected).toBeGreaterThan(0.049);
    expect(expected).toBeLessThan(0.051);
    expect(Math.abs(-clash.distance - expected)).toBeLessThan(1e-9);
    // The old AABB signed-gap depth for this pair was 0.7 (the contained box's
    // own smallest-axis overlap), 14x the real penetration.
    expect(-clash.distance).toBeLessThan(0.1);
  });

  it('reports a micrometre-scale depth for a designed face contact (issue corpus scale)', async () => {
    // Same layout, but the box crosses the notch wall by ~1e-6 m: a designed
    // face contact as in the #1866 corpus (true worst depth 7.39e-6 m). The
    // reported depth must sit inside the touching band, not at the AABB gap.
    const wall = lPrismElement('A', 'IfcWall');
    const xMinTarget = 0.999999;
    const duct = boxElementHxyz(
      'B',
      'IfcDuct',
      [(xMinTarget + 1.45) / 2, 1.4, 0.5],
      [(1.45 - xMinTarget) / 2, 0.2, 0.2],
    );
    const xMin = duct.bounds.min[0]; // f32-rounded, slightly below 1
    expect(xMin).toBeLessThan(1);
    const expected = 1 - xMin; // ~1e-6
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(1e-4); // inside TOUCHING_EPSILON
    const result = await engine.run([wall, duct], [hard()]);
    expect(result.summary.total).toBe(1);
    const clash = result.clashes[0];
    expect(clash.status).toBe('hard');
    expect(Math.abs(-clash.distance - expected)).toBeLessThan(1e-12);
  });
});
