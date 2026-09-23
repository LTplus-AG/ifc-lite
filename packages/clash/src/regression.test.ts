/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for defects found by adversarial review of phases 2/5/6:
 * - element-mode groups must not collide on the same id (-> duplicate BCF GUIDs)
 * - the BCF clash-ids round-trip must survive commas in a clash id
 * - the self-clash broad phase must skip same-key (same-entity) pairs
 */

import { describe, expect, it } from 'vitest';
import { readBCF, writeBCF } from '@ifc-lite/bcf';
import { groupClashes } from './grouping.js';
import { createBCFFromClashResult, mapBcfToClashes } from './bcf-bridge.js';
import { createClashEngine } from './engine.js';
import type { AABB, Clash, ClashElement, ClashElementRef, ClashResult, Vec3 } from './types.js';

function ref(key: string, tag: string): ClashElementRef {
  return { key, ref: 1, model: 'm', tag };
}

function boundsAround(p: Vec3): AABB {
  return { min: [p[0] - 0.1, p[1] - 0.1, p[2] - 0.1], max: [p[0] + 0.1, p[1] + 0.1, p[2] + 0.1] };
}

function makeClash(id: string, a: ClashElementRef, b: ClashElementRef, point: Vec3): Clash {
  return {
    id, a, b, rule: 'r', status: 'hard', distance: -0.01,
    point, bounds: boundsAround(point), severity: 'major',
  };
}

function makeResult(clashes: Clash[]): ClashResult {
  return {
    clashes,
    summary: {
      total: clashes.length,
      byRule: {}, byTypePair: {},
      bySeverity: { critical: 0, major: 0, minor: 0, info: 0 },
    },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

function boxElement(key: string, tag: string, cx: number, h = 0.5): ClashElement {
  const v = [
    cx - h, -h, -h, cx + h, -h, -h, cx + h, h, -h, cx - h, h, -h,
    cx - h, -h, h, cx + h, -h, h, cx + h, h, h, cx - h, h, h,
  ];
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  const positions = new Float32Array(v);
  return {
    key, ref: refFromKey(key), model: 'm', tag, positions, indices,
    bounds: { min: [cx - h, -h, -h], max: [cx + h, h, h] },
  };
}

/**
 * A stable, deterministic expressId-like `ref` derived from `key`, so that
 * two `boxElement`s built with the same key (the split-entity case) get the
 * same `ref` — matching real data, where `key` and `ref` both identify one
 * entity — while distinct keys get distinct refs. Fixes a fixture bug: this
 * helper used to hardcode `ref: 1` for every box, which happened to work
 * only because the broad-phase self-clash guard checked `key` alone; once it
 * also checks `ref` (see `broad.ts`'s `isSameEntity`), two DIFFERENT
 * entities sharing that hardcoded `ref` were wrongly treated as one.
 *
 * Uses a counter/registry rather than a hash: a 32-bit hash can collide
 * (e.g. "Aa" and "BB" both hash to 2112 under a 31-multiplier hash), and a
 * collision here would make two distinct fixture entities share a `ref`,
 * which `isSameEntity` would then wrongly treat as one entity — silently
 * suppressing a valid clash pair and letting a regression test pass for the
 * wrong reason. A registry is collision-free by construction.
 */
const refRegistry = new Map<string, number>();
let nextRef = 1;
function refFromKey(key: string): number {
  const existing = refRegistry.get(key);
  if (existing !== undefined) return existing;
  const assigned = nextRef;
  nextRef += 1;
  refRegistry.set(key, assigned);
  return assigned;
}

describe('regression: element-mode group ids do not collide', () => {
  it('gives two elements that clash only with each other distinct group ids', () => {
    const a = ref('GUID-A', 'IfcPipeSegment');
    const b = ref('GUID-B', 'IfcBeam');
    const result = makeResult([makeClash('r m GUID-A m GUID-B', a, b, [0, 0, 0])]);

    const groups = groupClashes(result, { by: 'element' });
    expect(groups).toHaveLength(2);
    expect(groups[0].id).not.toBe(groups[1].id);
  });
});

describe('regression: BCF clash-ids round-trip survives commas in an id', () => {
  it('recovers a clash id containing a comma (federated model label)', async () => {
    // A realistic federated model label puts a comma inside the clash id.
    const commaId = 'r Building A, Phase 2.ifc GUID-A m GUID-B';
    const a = ref('GUID-A', 'IfcDuctSegment');
    const b = ref('GUID-B', 'IfcBeam');
    const result = makeResult([makeClash(commaId, a, b, [0, 0, 0])]);
    const groups = groupClashes(result, { by: 'rule' });

    const project = await createBCFFromClashResult(result, groups, { author: 'qa@example.com' });
    const reloaded = await readBCF(await (await writeBCF(project)).arrayBuffer());
    const map = mapBcfToClashes(reloaded);

    expect(map.has(commaId)).toBe(true);
    expect(map.get(commaId)?.[0]?.status).toBe('Open');
  });
});

describe('regression: clearance violations inside tolerance are not swallowed', () => {
  it('reports a near-touching pair (gap < tolerance) as a clearance violation', async () => {
    // Two boxes 1 mm apart with a 50 mm clearance requirement and the default
    // 2 mm tolerance. The 1 mm gap is < tolerance, but it is the WORST kind of
    // clearance violation and must be reported (previously it was suppressed).
    const elements = [boxElement('A', 'IfcWall', 0), boxElement('B', 'IfcDuctSegment', 1.001)];
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(elements, [
      { id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'clearance', clearance: 0.05 },
    ]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('clearance');
  });

  it('catches an exact touch when tolerance is 0 and reportTouch is set', async () => {
    const elements = [boxElement('A', 'IfcWall', 0), boxElement('B', 'IfcDuctSegment', 1)];
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      elements,
      [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard', tolerance: 0, reportTouch: true }],
      { tolerance: 0 },
    );
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('touch');
  });
});

describe('regression: self-clash skips same-key (same-entity) pairs', () => {
  it('does not report a clash between two elements sharing a durable key', async () => {
    // An IFC5 element split across two geometry sub-prims -> two overlapping
    // ClashElements with the SAME key. That is one entity, not a clash.
    const elements = [boxElement('SAME', 'IfcWall', 0), boxElement('SAME', 'IfcWall', 0.2)];
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(elements, [
      { id: 'self', name: 'wall self-clash', a: 'IfcWall', mode: 'hard' },
    ]);
    expect(result.summary.total).toBe(0);
  });
});

/**
 * A "dumbbell" element: two tiny, far-apart triangles that together give a
 * wide AABB — the AABB overlaps a target while neither triangle does. Models
 * one sub-prim of a split entity that is a broad-phase false positive.
 */
function dumbbellElement(key: string, tag: string, cxNear: number, cxFar: number): ClashElement {
  const eps = 0.01;
  const positions = new Float32Array([
    cxNear, 0, 0, cxNear + eps, 0, 0, cxNear, eps, 0,
    cxFar, 0, 0, cxFar + eps, 0, 0, cxFar, eps, 0,
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  // Bounds padded by a fixed 0.05 margin around the two triangle centers
  // (NOT the triangles' own eps-sized extent) — matching the issue's own
  // executed repro bit-for-bit ([0.45, 20.55] for cxNear=0.5, cxFar=20.5).
  // This is deliberately exact: the broad-phase BVH's traversal/hit order
  // for two same-sized candidate leaves is sensitive to their bounds at the
  // float level, and reproducing the issue's order-dependence reliably
  // depends on matching its geometry, not just its shape.
  const margin = 0.05;
  return {
    key, ref: refFromKey(key), model: 'm', tag, positions, indices,
    bounds: { min: [cxNear - margin, -margin, -margin], max: [cxFar + margin, margin, margin] },
  };
}

describe('regression: cross-group broad-phase dedup does not drop a real clash (#5194)', () => {
  // Numbers match the issue's own executed repro exactly:
  // B: box at x=10, half-extent 1 -> spans [9, 11].
  // A2: box at x=10.5, half-extent 1 -> genuinely interpenetrates B.
  // A1: dumbbell whose AABB spans ~[0.45, 20.55] and overlaps B, but whose
  // actual triangles (near x=0.5 and x=20.5) are nowhere near B — an ordinary
  // broad-phase false positive the narrow phase correctly rejects alone.
  // A1 and A2 share one key: one entity split across sub-prims.
  function buildElements() {
    const b = boxElement('B', 'IfcBeam', 10, 1);
    const a1 = dumbbellElement('A', 'IfcWall', 0.5, 20.5);
    const a2 = boxElement('A', 'IfcWall', 10.5, 1);
    return { a1, a2, b };
  }

  it('sanity: the dumbbell alone does not clash with B', async () => {
    const { a1, b } = buildElements();
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run([a1, b], [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }]);
    expect(result.summary.total).toBe(0);
  });

  it('sanity: the genuinely-overlapping submesh alone clashes with B', async () => {
    const { a2, b } = buildElements();
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run([a2, b], [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
  });

  it('reports the clash regardless of element order — [A1, A2, B]', async () => {
    const { a1, a2, b } = buildElements();
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run([a1, a2, b], [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
  });

  it('reports the clash regardless of element order — [A2, A1, B]', async () => {
    const { a1, a2, b } = buildElements();
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run([a2, a1, b], [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
  });
});

describe('regression: cross-group entity dedup still reports one record per pair (no-regression pin)', () => {
  // B: box at x=10, half-extent 0.5 -> spans [9.5, 10.5].
  // aShallow: box at x=9.6, half-extent 0.5 -> spans [9.1, 10.1]; overlap
  // with B is [9.5, 10.1], a 0.6 m penetration.
  // aDeep: box at x=10.05, half-extent 0.5 -> spans [9.55, 10.55]; overlap
  // with B is [9.55, 10.5], a 0.95 m penetration — the more severe of the
  // two. Deliberately at a HIGHER x than aShallow (not lower): the broad
  // phase's BVH traverses candidates by spatial position, not by insertion
  // order, so a fixture where "more severe" also happened to mean "lower x"
  // would pass under a naive first-wins dedup by spatial coincidence, not
  // because severity was actually being compared.
  // Both share key "A": one entity, two sub-prims, BOTH genuinely clash with
  // B at different depths. Removing the pre-narrow broad-phase dedup must
  // not turn this into two reported clashes, and the survivor must be
  // decided by severity, not by which element the caller listed first or by
  // spatial traversal order.
  function buildElements() {
    const b = boxElement('B', 'IfcBeam', 10);
    const aShallow = boxElement('A', 'IfcWall', 9.6);
    const aDeep = boxElement('A', 'IfcWall', 10.05);
    return { aShallow, aDeep, b };
  }

  async function singleDistance(a: ClashElement, b: ClashElement) {
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run([a, b], [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }]);
    return result.clashes[0]?.distance;
  }

  it('keeps the deeper submesh when the SHALLOWER one is listed first', async () => {
    const { aShallow, aDeep, b } = buildElements();
    const shallowDistance = await singleDistance(aShallow, b);
    const deepDistance = await singleDistance(aDeep, b);
    expect(shallowDistance).toBeDefined();
    expect(deepDistance).toBeDefined();
    // Sanity on the fixture itself (hard-clash `distance` is the signed
    // penetration depth, negative — more negative is deeper).
    expect(deepDistance!).toBeLessThan(shallowDistance!);

    const engine = createClashEngine({ backend: 'ts' });
    // aShallow listed BEFORE aDeep: a first-wins dedup would wrongly keep
    // the shallower record.
    const result = await engine.run(
      [aShallow, aDeep, b],
      [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }],
    );
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
    expect(result.clashes[0].distance).toBe(deepDistance);
  });

  it('keeps the deeper submesh when the DEEPER one is listed first', async () => {
    const { aShallow, aDeep, b } = buildElements();
    const deepDistance = await singleDistance(aDeep, b);

    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      [aDeep, aShallow, b],
      [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }],
    );
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
    expect(result.clashes[0].distance).toBe(deepDistance);
  });
});

describe('regression: ordinary cross-group two-element detection is unchanged', () => {
  it('still reports exactly one clash for a plain A-vs-B overlap', async () => {
    const a = boxElement('A', 'IfcWall', 0);
    const b = boxElement('B', 'IfcDuctSegment', 0.6);
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run([a, b], [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
  });
});
