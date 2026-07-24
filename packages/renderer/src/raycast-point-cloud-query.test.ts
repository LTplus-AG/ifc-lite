/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mesh-vs-point-cloud snap override decision (#1860 review finding 2):
 * a point-cloud hit must not steal an existing mesh vertex/edge/face
 * snap just because it lands a few millimetres nearer along the ray —
 * scan points sit on scanned surfaces plus/minus capture noise, so a
 * naive "nearer wins" rule would non-deterministically steal intended
 * corner/edge snaps on essentially every measurement over scanned-over
 * geometry (a scan of the as-built building draped over its model is
 * the common case, not an edge case).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { pointCloudWinsOverMeshSnap, pointCloudSnapToleranceAt, type PointCloudRayResult } from './raycast-point-cloud-query.js';
import { SnapType, type SnapTarget } from './snap-detector.js';

/** A representative measure-tool camera: ~60deg vertical FOV, 800px-tall canvas. */
const CAMERA_FOV = 1.0472; // 60 degrees in radians
const CANVAS_HEIGHT_PX = 800;

const VERTEX_SNAP: SnapTarget = {
  type: SnapType.VERTEX,
  position: { x: 1, y: 2, z: 10 },
  expressId: 42,
  confidence: 0.9,
};

function pointHitAt(distance: number): PointCloudRayResult {
  return { position: { x: 0, y: 0, z: distance }, expressId: 99, distance };
}

describe('pointCloudSnapToleranceAt', () => {
  it('is positive and grows with depth for a fixed FOV/canvas', () => {
    const near = pointCloudSnapToleranceAt(1, CAMERA_FOV, CANVAS_HEIGHT_PX);
    const far = pointCloudSnapToleranceAt(100, CAMERA_FOV, CANVAS_HEIGHT_PX);
    assert.ok(near > 0);
    assert.ok(far > near);
  });
});

describe('pointCloudWinsOverMeshSnap — coincident-surface guard (#1860 review finding 2)', () => {
  it('mesh vertex snap SURVIVES a scan point only 5mm nearer (coincident scan noise)', () => {
    // Mesh intersection at t=10.00 with a vertex snapTarget; scan point
    // at t=9.995 is within capture-noise distance of the same surface —
    // must NOT steal the vertex snap.
    const wins = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(9.995),
      meshSnapTarget: VERTEX_SNAP,
      meshIntersectionDistance: 10.0,
      cameraFov: CAMERA_FOV,
      canvasHeightPx: CANVAS_HEIGHT_PX,
    });
    assert.strictEqual(wins, false, 'a scan point coincident with the mesh surface must not steal the vertex snap');
  });

  it('point snap WINS when it clearly occludes the mesh surface (t=8 vs mesh at t=10)', () => {
    const wins = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(8),
      meshSnapTarget: VERTEX_SNAP,
      meshIntersectionDistance: 10.0,
      cameraFov: CAMERA_FOV,
      canvasHeightPx: CANVAS_HEIGHT_PX,
    });
    assert.strictEqual(wins, true, 'a point genuinely in front of the mesh surface should win');
  });

  it('point snap wins when the mesh path found no snap target at all (bare face hit)', () => {
    // No vertex/edge/face snap — just a raw mesh intersection. Existing
    // "point wins when present/nearer" behavior is preserved.
    const wins = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(9.995),
      meshSnapTarget: null,
      meshIntersectionDistance: 10.0,
      cameraFov: CAMERA_FOV,
      canvasHeightPx: CANVAS_HEIGHT_PX,
    });
    assert.strictEqual(wins, true);
  });

  it('point snap wins when there was no mesh hit at all (point-cloud-only scene)', () => {
    const wins = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(50),
      meshSnapTarget: null,
      meshIntersectionDistance: null,
      cameraFov: CAMERA_FOV,
      canvasHeightPx: CANVAS_HEIGHT_PX,
    });
    assert.strictEqual(wins, true);
  });

  it('boundary: a point right at the decision threshold does not win, one just past it does', () => {
    // `toleranceAt` is LINEAR in t (screenToWorldRadius = C * t for a
    // fixed FOV/canvas), so the decision `d < meshDistance - C*d`
    // reduces to `d < meshDistance / (1 + C)` — a single fixed point,
    // not something that can be derived by subtracting a margin
    // computed AT meshDistance (that margin is evaluated at the wrong
    // depth: `toleranceAt` is re-evaluated at the CANDIDATE point's own
    // distance, per the decision's definition, not at the mesh's).
    const meshDistance = 10.0;
    const c = pointCloudSnapToleranceAt(1, CAMERA_FOV, CANVAS_HEIGHT_PX); // tolerance per unit distance
    const boundary = meshDistance / (1 + c);

    const atBoundary = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(boundary),
      meshSnapTarget: VERTEX_SNAP,
      meshIntersectionDistance: meshDistance,
      cameraFov: CAMERA_FOV,
      canvasHeightPx: CANVAS_HEIGHT_PX,
    });
    assert.strictEqual(atBoundary, false, 'strict inequality: exactly at the threshold must not win');

    const justInFront = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(boundary - 0.01),
      meshSnapTarget: VERTEX_SNAP,
      meshIntersectionDistance: meshDistance,
      cameraFov: CAMERA_FOV,
      canvasHeightPx: CANVAS_HEIGHT_PX,
    });
    assert.strictEqual(justInFront, true, 'a point just past the threshold, further in front, must win');
  });

  it('a point well beyond the tolerance margin in front of the mesh wins', () => {
    const meshDistance = 10.0;
    const margin = pointCloudSnapToleranceAt(meshDistance, CAMERA_FOV, CANVAS_HEIGHT_PX);
    const wins = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(meshDistance - margin - 0.5),
      meshSnapTarget: VERTEX_SNAP,
      meshIntersectionDistance: meshDistance,
      cameraFov: CAMERA_FOV,
      canvasHeightPx: CANVAS_HEIGHT_PX,
    });
    assert.strictEqual(wins, true);
  });
});
