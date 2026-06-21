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
