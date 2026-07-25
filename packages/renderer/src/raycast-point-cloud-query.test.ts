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

import {
  pointCloudSnapEnabled,
  pointCloudSnapToleranceAt,
  pointCloudWinsOverMeshSnap,
  queryPointClouds,
  type PointCloudRaySource,
  type PointCloudRayResult,
  type PointCloudSnapCamera,
} from './raycast-point-cloud-query.js';
import { PointCloudSpatialIndex } from './pointcloud/point-cloud-spatial-index.js';
import { SnapType, type SnapTarget } from './snap-detector.js';

/** A representative measure-tool camera: ~60deg vertical FOV, 800px-tall canvas. */
const CAMERA_FOV = 1.0472; // 60 degrees in radians
const CANVAS_HEIGHT_PX = 800;
const CAMERA: PointCloudSnapCamera = { fov: CAMERA_FOV, canvasHeightPx: CANVAS_HEIGHT_PX, orthoHalfHeight: null };

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
    const near = pointCloudSnapToleranceAt(1, CAMERA);
    const far = pointCloudSnapToleranceAt(100, CAMERA);
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
      camera: CAMERA,
    });
    assert.strictEqual(wins, false, 'a scan point coincident with the mesh surface must not steal the vertex snap');
  });

  it('point snap WINS when it clearly occludes the mesh surface (t=8 vs mesh at t=10)', () => {
    const wins = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(8),
      meshSnapTarget: VERTEX_SNAP,
      meshIntersectionDistance: 10.0,
      camera: CAMERA,
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
      camera: CAMERA,
    });
    assert.strictEqual(wins, true);
  });

  it('point snap wins when there was no mesh hit at all (point-cloud-only scene)', () => {
    const wins = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(50),
      meshSnapTarget: null,
      meshIntersectionDistance: null,
      camera: CAMERA,
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
    const c = pointCloudSnapToleranceAt(1, CAMERA); // tolerance per unit distance
    const boundary = meshDistance / (1 + c);

    const atBoundary = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(boundary),
      meshSnapTarget: VERTEX_SNAP,
      meshIntersectionDistance: meshDistance,
      camera: CAMERA,
    });
    assert.strictEqual(atBoundary, false, 'strict inequality: exactly at the threshold must not win');

    const justInFront = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(boundary - 0.01),
      meshSnapTarget: VERTEX_SNAP,
      meshIntersectionDistance: meshDistance,
      camera: CAMERA,
    });
    assert.strictEqual(justInFront, true, 'a point just past the threshold, further in front, must win');
  });

  it('a point well beyond the tolerance margin in front of the mesh wins', () => {
    const meshDistance = 10.0;
    const margin = pointCloudSnapToleranceAt(meshDistance, CAMERA);
    const wins = pointCloudWinsOverMeshSnap({
      pointHit: pointHitAt(meshDistance - margin - 0.5),
      meshSnapTarget: VERTEX_SNAP,
      meshIntersectionDistance: meshDistance,
      camera: CAMERA,
    });
    assert.strictEqual(wins, true);
  });
});

describe('pointCloudSnapToleranceAt — orthographic camera', () => {
  // In ortho projection a screen pixel spans the same world distance at
  // every depth, so the snap tolerance must NOT grow with t (the
  // perspective formula would inflate the snap radius for far points and
  // starve near ones as the user zooms an ortho view).
  const ORTHO: PointCloudSnapCamera = { fov: CAMERA_FOV, canvasHeightPx: CANVAS_HEIGHT_PX, orthoHalfHeight: 25 };

  it('is depth-independent', () => {
    const near = pointCloudSnapToleranceAt(1, ORTHO);
    const far = pointCloudSnapToleranceAt(500, ORTHO);
    assert.ok(near > 0);
    assert.strictEqual(near, far);
  });

  it('scales with ortho zoom (halfHeight), not with fov', () => {
    const zoomedIn: PointCloudSnapCamera = { ...ORTHO, orthoHalfHeight: 2.5 };
    assert.ok(
      pointCloudSnapToleranceAt(10, zoomedIn) < pointCloudSnapToleranceAt(10, ORTHO),
      'zooming in (smaller orthoHalfHeight) must tighten the world-space tolerance',
    );
    const otherFov: PointCloudSnapCamera = { ...ORTHO, fov: CAMERA_FOV / 2 };
    assert.strictEqual(pointCloudSnapToleranceAt(10, otherFov), pointCloudSnapToleranceAt(10, ORTHO));
  });
});

describe('queryPointClouds — multi-asset dispatch (real indices, no mocks)', () => {
  // Constant 0.1m world tolerance at every depth: ortho camera,
  // (8px / 800px) * (2 * 5m) = 0.1m — deterministic for assertions.
  const ORTHO_CAMERA: PointCloudSnapCamera = { fov: CAMERA_FOV, canvasHeightPx: 800, orthoHalfHeight: 5 };
  const RAY = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };

  /** A real spatial index holding one on-axis point at depth z. */
  function sourceAt(expressId: number, z: number, classification?: number): PointCloudRaySource {
    const index = new PointCloudSpatialIndex(0.5);
    index.insertRange(
      new Float32Array([0, 0, z]),
      1,
      classification === undefined ? null : new Uint8Array([classification]),
    );
    return { expressId, index };
  }

  it('returns null for a null provider or no sources', () => {
    assert.strictEqual(queryPointClouds(null, RAY, ORTHO_CAMERA, 100), null);
    assert.strictEqual(queryPointClouds(() => [], RAY, ORTHO_CAMERA, 100), null);
  });

  it('picks the nearest hit ACROSS assets and reports its owning expressId', () => {
    const provider = () => [sourceAt(11, 8), sourceAt(22, 3)];
    const hit = queryPointClouds(provider, RAY, ORTHO_CAMERA, 100);
    assert.ok(hit);
    assert.strictEqual(hit!.expressId, 22);
    assert.strictEqual(hit!.distance, 3);
    // Source order must not matter (the per-source bound narrows to the
    // current best, never excludes a nearer later source).
    const reversed = queryPointClouds(() => [sourceAt(22, 3), sourceAt(11, 8)], RAY, ORTHO_CAMERA, 100);
    assert.ok(reversed);
    assert.strictEqual(reversed!.expressId, 22);
  });

  it('hiddenIds filters whole assets: a hidden nearer cloud yields to a visible farther one', () => {
    const provider = () => [sourceAt(11, 8), sourceAt(22, 3)];
    const hit = queryPointClouds(provider, RAY, ORTHO_CAMERA, 100, { hiddenIds: new Set([22]) });
    assert.ok(hit);
    assert.strictEqual(hit!.expressId, 11);
    assert.strictEqual(
      queryPointClouds(provider, RAY, ORTHO_CAMERA, 100, { hiddenIds: new Set([11, 22]) }),
      null,
    );
  });

  it('isolatedIds restricts snapping to the isolated assets', () => {
    const provider = () => [sourceAt(11, 8), sourceAt(22, 3)];
    const hit = queryPointClouds(provider, RAY, ORTHO_CAMERA, 100, { isolatedIds: new Set([11]) });
    assert.ok(hit);
    assert.strictEqual(hit!.expressId, 11);
    // null isolation set means "no isolation" (everything participates).
    const none = queryPointClouds(provider, RAY, ORTHO_CAMERA, 100, { isolatedIds: null });
    assert.ok(none);
    assert.strictEqual(none!.expressId, 22);
  });

  it('maxDistance bounds the search and each source honours its own classMask', () => {
    assert.strictEqual(queryPointClouds(() => [sourceAt(11, 8)], RAY, ORTHO_CAMERA, 5), null);
    // Hide class 7 on the nearer source only: the farther, unmasked one wins.
    const mask = new Uint32Array(8).fill(0xffffffff);
    mask[0] &= ~(1 << 7);
    const masked: PointCloudRaySource = { ...sourceAt(22, 3, 7), classMask: mask };
    const hit = queryPointClouds(() => [masked, sourceAt(11, 8, 7)], RAY, ORTHO_CAMERA, 100);
    assert.ok(hit);
    assert.strictEqual(hit!.expressId, 11);
  });
});

describe('pointCloudSnapEnabled — snap toggle gating', () => {
  it('defaults ON when no snap options are supplied (legacy callers)', () => {
    assert.strictEqual(pointCloudSnapEnabled(undefined), true);
    assert.strictEqual(pointCloudSnapEnabled({}), true); // absent fields mean ON, mirroring SnapDetector defaults
  });

  it('follows the viewer snap toggle: all mesh snaps explicitly off disables point snapping', () => {
    // Exactly what the measure tool passes when the user turns snapping OFF.
    assert.strictEqual(
      pointCloudSnapEnabled({ snapToVertices: false, snapToEdges: false, snapToFaces: false, screenSnapRadius: 0 }),
      false,
    );
    // ...and the snap-ON shape keeps it enabled.
    assert.strictEqual(
      pointCloudSnapEnabled({ snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 60 }),
      true,
    );
  });

  it('an explicit snapToPointClouds wins over the derived default in both directions', () => {
    assert.strictEqual(
      pointCloudSnapEnabled({ snapToVertices: true, snapToEdges: true, snapToFaces: true, snapToPointClouds: false }),
      false,
    );
    assert.strictEqual(
      pointCloudSnapEnabled({ snapToVertices: false, snapToEdges: false, snapToFaces: false, snapToPointClouds: true }),
      true,
    );
  });
});
