/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planeFrameGeometry, resolveSectionPlaneFrames } from './section-plane-frames.js';
import type { SectionPlane } from './types.js';

const BOUNDS = { min: { x: -20, y: 0, z: -10 }, max: { x: 20, y: 10, z: 10 } };
const plane = (patch: Partial<SectionPlane>): SectionPlane => ({ axis: 'down', position: 50, enabled: true, ...patch });
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

describe('the world-space frame of every section plane (#7545)', () => {
  it('every corner and the anchor lie on the plane, and the quad is a square around the anchor', () => {
    for (const [normal, distance] of [[[0, 1, 0], 4], [[1, 0, 0], -6], [[0.6, 0, 0.8], 3]] as const) {
      const { anchor, corners } = planeFrameGeometry(normal, distance, BOUNDS);
      assert.ok(Math.abs(dot(anchor, normal) - distance) < 1e-9);
      for (const c of corners) assert.ok(Math.abs(dot(c, normal) - distance) < 1e-9, 'corner on the plane');
      const [a, b, c, d] = corners;
      const side = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
      assert.ok(Math.abs(side(a, b) - side(b, c)) < 1e-9 && Math.abs(side(c, d) - side(d, a)) < 1e-9);
    }
  });

  it('resolves the primary and each extra the way the clip does, ids carried, disabled planes included', () => {
    const frames = resolveSectionPlaneFrames({
      primary: plane({ id: 'a', axis: 'down', position: 30 }),
      extras: [plane({ id: 'b', axis: 'side', position: 75, flipped: true }), plane({ id: 'c', axis: 'front', position: 0, enabled: false })],
      bounds: BOUNDS,
      buildingRotation: undefined,
    });
    assert.deepEqual(frames.map((f) => [f.id, f.primary, f.enabled]), [['a', true, true], ['b', false, true], ['c', false, false]]);
    assert.equal(frames[0]!.distance, 3, '30 % of the 0..10 vertical extent');
    assert.equal(frames[1]!.distance, 10, '75 % of the -20..20 side extent');
    assert.equal(frames[1]!.flipped, true);
    assert.equal(frames[2]!.distance, -10);
  });

  it('applies the building rotation to every plane', () => {
    const frames = resolveSectionPlaneFrames({
      primary: null, extras: [plane({ id: 'b', axis: 'side' })], bounds: BOUNDS, buildingRotation: Math.PI / 2,
    });
    assert.ok(Math.abs(frames[0]!.normal[0]) < 1e-9 && Math.abs(Math.abs(frames[0]!.normal[2]) - 1) < 1e-9);
  });

  it('has no primary frame without a primary plane and caps the extras at seven', () => {
    const many = Array.from({ length: 10 }, (_, i) => plane({ id: `p${i}` }));
    const frames = resolveSectionPlaneFrames({ primary: null, extras: many, bounds: BOUNDS, buildingRotation: undefined });
    assert.equal(frames.length, 7);
    assert.ok(frames.every((f) => !f.primary));
  });
});
