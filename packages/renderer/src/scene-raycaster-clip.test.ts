/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CPU raycast pick path (batched / released-geometry models) must honour the
 * section plane + crop box, otherwise a click selects geometry the user has cut
 * away. These tests drive a ray through a NEAR (clipped) surface and a FAR
 * (visible) one and assert the pick falls through to the visible surface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  raycastTriangles,
  raycastBoundingBoxes,
  clippedBoxEntryDistance,
  prepareRayDirInv,
  pointClipped,
  boxFullyClipped,
  type BoundingBox,
} from './scene-raycaster.js';
import type { PickClipState } from './types.js';

// Quad-ish triangle centred on (0,0,z), facing +z; the ray (0,0,0)->-z hits (0,0,z).
function triAt(z: number) {
  return [{
    positions: new Float32Array([-1, -1, z, 1, -1, z, 0, 1, z]),
    indices: new Uint32Array([0, 1, 2]),
  }];
}
const BBOX = (z: number): BoundingBox => ({ min: { x: -1, y: -1, z }, max: { x: 1, y: 1, z } });

const NEAR = 101; // z = -5
const FAR = 202;  // z = -10
const meshDataMap = new Map<number, ReturnType<typeof triAt>>([
  [NEAR, triAt(-5)],
  [FAR, triAt(-10)],
]);
const bboxes = new Map<number, BoundingBox>([[NEAR, BBOX(-5)], [FAR, BBOX(-10)]]);

const rayOrigin = { x: 0, y: 0, z: 0 };
const rayDir = { x: 0, y: 0, z: -1 };
const { rayDirInv, rayDirSign } = prepareRayDirInv(rayDir);

function cast(clip?: PickClipState | null) {
  return raycastTriangles(
    rayOrigin, rayDir, rayDirInv, rayDirSign,
    meshDataMap, (id) => bboxes.get(id) ?? null,
    undefined, undefined, clip,
  );
}

describe('raycastTriangles clip awareness', () => {
  it('no clip: returns the nearest surface', () => {
    assert.strictEqual(cast(null)?.expressId, NEAR);
  });

  it('section plane cutting away the near surface falls through to the far one', () => {
    // normal +z, distance -7, not flipped: clips z > -7 (the near surface at -5).
    const clip: PickClipState = { sectionPlane: { normal: [0, 0, 1], distance: -7, flipped: false } };
    assert.strictEqual(cast(clip)?.expressId, FAR);
  });

  it('flipped section flips which side is cut', () => {
    // Same plane flipped: now clips z < -7 (the far surface), near stays pickable.
    const clip: PickClipState = { sectionPlane: { normal: [0, 0, 1], distance: -7, flipped: true } };
    assert.strictEqual(cast(clip)?.expressId, NEAR);
  });

  it('crop box excluding the near surface falls through to the far one', () => {
    const clip: PickClipState = { clipBox: { min: [-2, -2, -12], max: [2, 2, -7], enabled: true } };
    assert.strictEqual(cast(clip)?.expressId, FAR);
  });

  it('disabled crop box does not clip', () => {
    const clip: PickClipState = { clipBox: { min: [-2, -2, -12], max: [2, 2, -7], enabled: false } };
    assert.strictEqual(cast(clip)?.expressId, NEAR);
  });
});

describe('raycastBoundingBoxes clip awareness (released-geometry path)', () => {
  const NEAR_B = 11; // z in [-6, -4]
  const FAR_B = 22;  // z in [-11, -9]
  const boxz = (lo: number, hi: number): BoundingBox => ({ min: { x: -1, y: -1, z: lo }, max: { x: 1, y: 1, z: hi } });
  const boxes = new Map<number, BoundingBox>([[NEAR_B, boxz(-6, -4)], [FAR_B, boxz(-11, -9)]]);
  const castBox = (clip?: PickClipState | null) =>
    raycastBoundingBoxes(rayOrigin, rayDir, rayDirInv, rayDirSign, boxes, undefined, undefined, clip);

  it('no clip: nearest box', () => {
    assert.strictEqual(castBox(null)?.expressId, NEAR_B);
  });
  it('section plane cutting away the near box returns the far one', () => {
    assert.strictEqual(castBox({ sectionPlane: { normal: [0, 0, 1], distance: -7, flipped: false } })?.expressId, FAR_B);
  });
  it('crop box excluding the near box returns the far one', () => {
    assert.strictEqual(castBox({ clipBox: { min: [-2, -2, -12], max: [2, 2, -7], enabled: true } })?.expressId, FAR_B);
  });

  it('partially clipped box reports its VISIBLE entry (at the cut), not its near face', () => {
    // Box spans z[-12,-4] (enters at t=4); section keeps z<=-7, so the visible
    // entry is the plane crossing at z=-7 (t=7), not the box's near face (t=4).
    const d = clippedBoxEntryDistance(
      rayOrigin, rayDir, rayDirInv, rayDirSign, boxz(-12, -4),
      { sectionPlane: { normal: [0, 0, 1], distance: -7, flipped: false } },
    );
    assert.ok(d !== null && Math.abs(d - 7) < 1e-9, `expected ~7, got ${d}`);
  });

  it('fully clipped box returns null entry', () => {
    const d = clippedBoxEntryDistance(
      rayOrigin, rayDir, rayDirInv, rayDirSign, boxz(-6, -4),
      { sectionPlane: { normal: [0, 0, 1], distance: -7, flipped: false } },
    );
    assert.strictEqual(d, null);
  });
});

describe('pointClipped / boxFullyClipped', () => {
  const section: PickClipState = { sectionPlane: { normal: [0, 0, 1], distance: -7, flipped: false } };
  it('pointClipped matches the section half-space', () => {
    assert.strictEqual(pointClipped(section, 0, 0, -5), true);  // z > -7 cut
    assert.strictEqual(pointClipped(section, 0, 0, -10), false); // z < -7 kept
    assert.strictEqual(pointClipped(null, 0, 0, -5), false);     // no clip
  });
  it('boxFullyClipped only when every corner is cut', () => {
    assert.strictEqual(boxFullyClipped(section, BBOX(-5)), true);   // box entirely z>-7
    assert.strictEqual(boxFullyClipped(section, BBOX(-10)), false); // box entirely z<-7
    // straddling box is NOT fully clipped (part visible)
    assert.strictEqual(boxFullyClipped(section, { min: { x: -1, y: -1, z: -9 }, max: { x: 1, y: 1, z: -5 } }), false);
  });
});
