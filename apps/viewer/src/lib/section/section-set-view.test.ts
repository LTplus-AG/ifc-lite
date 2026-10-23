/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planeBasis } from '@ifc-lite/renderer';
import { customPlaneViewpoint } from './section-set-view.js';

const CURRENT = {
  position: { x: 10, y: 10, z: 10 }, target: { x: 0, y: 0, z: 0 }, fov: Math.PI / 4,
  projectionMode: 'perspective' as const,
};

function plane(normal: [number, number, number], distance: number, flipped = false) {
  const { tangent, bitangent } = planeBasis(normal);
  return { flipped, custom: { normal, distance, pickedAt: [normal[0] * distance, normal[1] * distance, normal[2] * distance] as [number, number, number], tangent, bitangent } };
}
const dot = (a: { x: number; y: number; z: number }, n: readonly number[]) => a.x * n[0]! + a.y * n[1]! + a.z * n[2]!;
const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe('Set view for a face-picked plane (#7545)', () => {
  it('puts the eye on the removed side, looking straight along the kept direction at the plane', () => {
    const p = plane([1, 0, 0], 4);
    const v = customPlaneViewpoint(p, CURRENT);
    // Not flipped: the part behind the plane stays, so the eye is on the +normal side.
    assert.ok(v.position.x > 4, 'eye on the +x side');
    const forward = { x: v.target.x - v.position.x, y: v.target.y - v.position.y, z: v.target.z - v.position.z };
    const l = len(forward);
    assert.ok(Math.abs(forward.x / l + 1) < 1e-9 && Math.abs(forward.y / l) < 1e-9 && Math.abs(forward.z / l) < 1e-9, 'looking along -normal');
    assert.ok(Math.abs(dot(v.target, [1, 0, 0]) - 4) < 1e-9, 'aimed at a point on the plane');
  });

  it('flipping the plane moves the eye to the other side', () => {
    const v = customPlaneViewpoint(plane([1, 0, 0], 4, true), CURRENT);
    assert.ok(v.position.x < 4);
  });

  it('keeps the distance the camera already had', () => {
    const v = customPlaneViewpoint(plane([0, 0, 1], 2), CURRENT);
    assert.ok(Math.abs(len({ x: v.position.x - v.target.x, y: v.position.y - v.target.y, z: v.position.z - v.target.z }) - len({ x: 10, y: 10, z: 10 })) < 1e-9);
  });

  it('keeps world up up for a tilted plane, and the up vector is unit and perpendicular to the view', () => {
    const n: [number, number, number] = [0.6, 0.2, 0.8];
    const l = Math.hypot(...n);
    const unit: [number, number, number] = [n[0] / l, n[1] / l, n[2] / l];
    const v = customPlaneViewpoint(plane(unit, 1), CURRENT);
    assert.ok(Math.abs(len(v.up) - 1) < 1e-9);
    assert.ok(v.up.y > 0, 'world up stays up');
    assert.ok(Math.abs(dot(v.up, unit)) < 1e-9, 'up lies in the view plane');
  });

  it('a horizontal plane falls back to its own in-plane axis for up (no world-up direction exists in it)', () => {
    const v = customPlaneViewpoint(plane([0, 1, 0], 3), CURRENT);
    assert.ok(Math.abs(len(v.up) - 1) < 1e-9);
    assert.ok(Math.abs(v.up.y) < 1e-9, 'up lies in the horizontal plane');
  });

  it('carries the projection through unchanged', () => {
    const v = customPlaneViewpoint(plane([1, 0, 0], 0), { ...CURRENT, projectionMode: 'orthographic', orthoSize: 12 });
    assert.equal(v.projectionMode, 'orthographic');
    assert.equal(v.orthoSize, 12);
  });
});
