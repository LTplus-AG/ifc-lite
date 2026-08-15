/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isTouching, penetrationDepth, sortClashes, TOUCHING_EPSILON } from './analysis.js';
import type { AABB, Clash, ClashElementRef, ClashSeverity, ClashStatus, Vec3 } from './types.js';

function ref(key: string, tag: string): ClashElementRef {
  return { key, ref: 1, model: 'm', tag };
}

const POINT: Vec3 = [0, 0, 0];
const BOUNDS: AABB = { min: [0, 0, 0], max: [1, 1, 1] };

function clash(id: string, distance: number, severity: ClashSeverity, status: ClashStatus = 'hard'): Clash {
  return {
    id,
    a: ref(`${id}a`, 'IfcPipeSegment'),
    b: ref(`${id}b`, 'IfcBeam'),
    rule: 'r',
    status,
    distance,
    point: POINT,
    bounds: BOUNDS,
    severity,
  };
}

describe('penetrationDepth', () => {
  it('is the magnitude of a negative (penetrating) distance', () => {
    expect(penetrationDepth(clash('a', -0.25, 'major'))).toBeCloseTo(0.25);
  });

  it('is zero for separated (positive-distance) clashes', () => {
    expect(penetrationDepth(clash('a', 0.4, 'minor', 'clearance'))).toBe(0);
  });
});

describe('isTouching', () => {
  it('flags hard clashes within the touching band (zero-distance contacts, #1273)', () => {
    expect(isTouching(clash('a', 0, 'info'))).toBe(true);
    expect(isTouching(clash('a', -TOUCHING_EPSILON / 2, 'info'))).toBe(true);
  });

  it('does not flag a genuine interpenetration', () => {
    expect(isTouching(clash('a', -0.05, 'major'))).toBe(false);
  });

  it('always flags touch-status clashes', () => {
    expect(isTouching(clash('a', 0.001, 'info', 'touch'))).toBe(true);
  });

  it('includes a depth sitting EXACTLY on the epsilon, and excludes the next value up', () => {
    // The band is inclusive at its edge. An exclusive `<` re-labels a coincident
    // face reported at precisely the band edge as a genuine overlap — the
    // false-positive class #1273 removed — and nothing else in the suite pins it.
    expect(isTouching(clash('a', -TOUCHING_EPSILON, 'info'))).toBe(true);
    expect(isTouching(clash('a', -TOUCHING_EPSILON * 1.000001, 'info'))).toBe(false);
  });

  it('honours a caller-supplied epsilon at its own boundary', () => {
    const c = clash('a', -0.5, 'info');
    expect(isTouching(c, 0.5)).toBe(true);
    expect(isTouching(c, 0.25)).toBe(false);
    // Default band would reject it — proves the argument, not the default, wins.
    expect(isTouching(c)).toBe(false);
  });
});

describe('isTouching (scale-relative default, far from origin)', () => {
  // Geometry is ingested from f32 buffers, so a fixed TOUCHING_EPSILON=1e-4
  // is only valid near the origin: the f32 ULP for a coordinate of magnitude
  // `extent` is `extent * 2^-22`, which exceeds 1e-4 once `extent` passes
  // 1024 m (1e-4 / 2^-22 = 419.4, and the ULP only takes power-of-two steps,
  // so the first step that actually exceeds 1e-4 lands at 1024 m). Past that
  // distance, a genuinely flush pair's measured depth can exceed the fixed
  // band on pure rounding noise and reappear as a hard clash.
  function clashAt(id: string, distance: number, extent: number): Clash {
    return {
      id,
      a: ref(`${id}a`, 'IfcWall'),
      b: ref(`${id}b`, 'IfcSlab'),
      rule: 'r',
      status: 'hard',
      distance,
      point: [extent, extent, extent],
      bounds: { min: [extent - 0.01, extent - 0.01, extent - 0.01], max: [extent, extent, extent] },
      severity: 'info',
    };
  }

  it('RED (documents the old fixed-1e-4 result): a flush pair 5 km out, with only f32-noise-scale penetration, would NOT have been flagged as touching under the fixed constant alone', () => {
    const c = clashAt('far', -0.00048828125, 5000); // measured noise floor at 5 km, see engine.test.ts-style repro
    expect(penetrationDepth(c)).toBeGreaterThan(TOUCHING_EPSILON); // the old, unscaled comparison
  });

  it('GREEN: the same clash IS flagged touching by the scale-relative default', () => {
    const c = clashAt('far', -0.00048828125, 5000);
    expect(isTouching(c)).toBe(true);
  });

  it('also recovers it at 50 km', () => {
    const c = clashAt('far50k', -0.00390625, 50_000);
    expect(isTouching(c)).toBe(true);
  });

  it('still rejects a genuine interpenetration at the same distance (scaling does not hide real clashes)', () => {
    const c = clashAt('real-clash-5km', -0.05, 5000); // 5 cm, far above any plausible f32 noise floor
    expect(isTouching(c)).toBe(false);
  });

  it('unchanged near the origin: matches the fixed TOUCHING_EPSILON exactly on the existing near-origin fixtures', () => {
    // Same fixtures as the plain `isTouching` describe block above (extent ~1 m,
    // via the shared `clash()` helper) — near the origin the scale-relative
    // default must floor to exactly TOUCHING_EPSILON, so behaviour is identical.
    expect(isTouching(clash('a', 0, 'info'))).toBe(true);
    expect(isTouching(clash('a', -TOUCHING_EPSILON / 2, 'info'))).toBe(true);
    expect(isTouching(clash('a', -TOUCHING_EPSILON * 1.5, 'info'))).toBe(false);
    expect(isTouching(clash('a', -0.05, 'major'))).toBe(false);
  });

  it('an explicit eps still overrides the scale-relative default entirely', () => {
    const c = clashAt('explicit', -0.00048828125, 5000);
    expect(isTouching(c, 1e-6)).toBe(false);
    expect(isTouching(c, 1)).toBe(true);
  });
});

describe('sortClashes', () => {
  it('orders by severity then depth (#1274)', () => {
    const list = [
      clash('shallow-critical', -0.01, 'critical'),
      clash('deep-minor', -0.9, 'minor'),
      clash('deep-critical', -0.5, 'critical'),
    ];
    const out = sortClashes(list, 'severity').map((c) => c.id);
    expect(out).toEqual(['deep-critical', 'shallow-critical', 'deep-minor']);
  });

  it('orders by overlap depth, deepest first', () => {
    const list = [clash('a', -0.1, 'info'), clash('b', -0.8, 'info'), clash('c', -0.4, 'info')];
    expect(sortClashes(list, 'depth').map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders by signed distance, deepest penetration to widest gap', () => {
    const list = [clash('gap', 0.5, 'info', 'clearance'), clash('deep', -0.3, 'info'), clash('touch', 0, 'info')];
    expect(sortClashes(list, 'distance').map((c) => c.id)).toEqual(['deep', 'touch', 'gap']);
  });

  it('does not mutate the input', () => {
    const list = [clash('b', -0.1, 'info'), clash('a', -0.2, 'info')];
    const before = list.map((c) => c.id);
    sortClashes(list, 'depth');
    expect(list.map((c) => c.id)).toEqual(before);
  });
});
