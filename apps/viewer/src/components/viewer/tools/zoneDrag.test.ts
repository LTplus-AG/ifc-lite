/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeZoneDragPatch, MIN_RESIZE_HALF_M, type DragState, type Vec3 } from './zoneDrag.js';

/** Drag state for a top-down camera where +1 world metre along `probeDir`
 *  projects to `screenPerUnit` pixels. */
function makeDrag(overrides: Partial<DragState>): DragState {
  return {
    op: { kind: 'move' },
    setId: 's1',
    zoneId: 'z1',
    cursorStart: { x: 100, y: 100 },
    screenPerUnit: { x: 10, y: 0 },
    probeDir: { x: 1, y: 0, z: 0 },
    startCenter: [0, 0, 0],
    startSize: [10, 3, 10],
    startRotationY: 0,
    ...overrides,
  };
}

function approxEqual(actual: readonly number[], expected: readonly number[], eps = 1e-9): void {
  assert.strictEqual(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < eps, `component ${i}: ${actual[i]} != ${expected[i]}`);
  }
}

describe('zones/zoneDrag (PR #1869 review: rotated-zone drag math)', () => {
  it('unrotated move along local X moves the world X center only', () => {
    const drag = makeDrag({});
    // Cursor moved +20px along the probe's screen direction => +2 metres.
    const patch = computeZoneDragPatch(drag, { x: 120, y: 100 })!;
    approxEqual(patch.center!, [2, 0, 0]);
  });

  it('at 90° rotation the local-X handle moves the box along world Z, not world X', () => {
    // rotationY = 90°: localX = (cos, 0, sin) = (0, 0, 1) — the handle points
    // down world +Z and the probe measured screen pixels along world +Z.
    const localX: Vec3 = { x: 0, y: 0, z: 1 };
    const drag = makeDrag({
      probeDir: localX,
      startRotationY: Math.PI / 2,
      screenPerUnit: { x: 0, y: -8 }, // +1m world Z projects 8px up on screen
    });
    const patch = computeZoneDragPatch(drag, { x: 100, y: 100 - 24 })!; // 24px up => +3m
    // The center must move along the probed LOCAL direction (world Z here);
    // the old code wrote the scalar into center[0] (world X) instead.
    approxEqual(patch.center!, [0, 0, 3]);
  });

  it('at 45° rotation the delta lands on the rotated axis, split across world X and Z', () => {
    const c = Math.SQRT1_2;
    const localX: Vec3 = { x: c, y: 0, z: c };
    const drag = makeDrag({ probeDir: localX, startRotationY: Math.PI / 4, screenPerUnit: { x: 10, y: 0 } });
    const patch = computeZoneDragPatch(drag, { x: 120, y: 100 })!; // +2 metres along localX
    approxEqual(patch.center!, [2 * c, 0, 2 * c]);
  });

  it('vertical move applies along world Y regardless of rotation', () => {
    const drag = makeDrag({
      probeDir: { x: 0, y: 1, z: 0 },
      startRotationY: 1.234,
      screenPerUnit: { x: 0, y: -12 },
      startCenter: [5, 2, -3],
    });
    const patch = computeZoneDragPatch(drag, { x: 100, y: 100 - 12 })!; // +1m up
    approxEqual(patch.center!, [5, 3, -3]);
  });

  it('resize adjusts the LOCAL size component symmetrically and never collapses below the floor', () => {
    const drag = makeDrag({ op: { kind: 'resize', axis: 'x' }, screenPerUnit: { x: 10, y: 0 } });
    const grow = computeZoneDragPatch(drag, { x: 110, y: 100 })!; // +1m half-extent
    approxEqual(grow.size!, [12, 3, 10]);
    const collapse = computeZoneDragPatch(drag, { x: 100 - 1000, y: 100 })!;
    approxEqual(collapse.size!, [MIN_RESIZE_HALF_M * 2, 3, 10]);
  });

  it('rotate converts tangential metres to an angle via arc length at the handle radius', () => {
    const drag = makeDrag({ op: { kind: 'rotate' }, screenPerUnit: { x: 10, y: 0 }, startSize: [10, 3, 10] });
    const radius = 10 / 2 + 1.2;
    const patch = computeZoneDragPatch(drag, { x: 110, y: 100 })!; // 1 metre of arc
    assert.ok(Math.abs((patch.rotationY ?? 0) - 1 / radius) < 1e-9);
  });

  it('returns null for a degenerate probe instead of a garbage patch', () => {
    const drag = makeDrag({ screenPerUnit: { x: 0, y: 0 } });
    assert.strictEqual(computeZoneDragPatch(drag, { x: 500, y: 500 }), null);
  });
});
