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
import { buildRayQuerySources } from './pointcloud/point-cloud-ray-transform.js';
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

/**
 * Aligned-scan reconciliation (#1804 x #1860).
 *
 * The spatial index stores RAW decoder positions while the shader draws
 * points through the node's `model` matrix. Without folding that matrix
 * into the query, a measurement on a georeferenced scan snaps to where the
 * point sat BEFORE alignment — visibly off from the dot the user clicked.
 * Neither feature's own tests could catch this; it only exists in their
 * composition.
 */
describe('queryPointClouds with an aligned point cloud', () => {
  /** Index holding a single raw point, cell size 0.5m. */
  function indexWithPointAt(x: number, y: number, z: number): PointCloudSpatialIndex {
    const index = new PointCloudSpatialIndex(0.5);
    index.insertRange(new Float32Array([x, y, z]), 1);
    return index;
  }

  /** Column-major 4x4: uniform scale `k`, rotation `deg` about Y, translation `t`. */
  function makeModel(k: number, deg: number, t: [number, number, number]): Float32Array {
    const r = (deg * Math.PI) / 180;
    const a = Math.cos(r);
    const b = Math.sin(r);
    return new Float32Array([
      k * a, 0, k * b, 0,
      0, k, 0, 0,
      -k * b, 0, k * a, 0,
      t[0], t[1], t[2], 1,
    ]);
  }

  function sourceWith(index: PointCloudSpatialIndex, model?: Float32Array): PointCloudRaySource[] {
    return [{ expressId: 7, index, model }];
  }

  /** Ray straight down -Z from the origin, which is how these fixtures are aimed. */
  function rayToward(x: number, y: number) {
    return { origin: { x, y, z: 0 }, direction: { x: 0, y: 0, z: -1 } };
  }

  it('snaps to the RENDERED position, not the raw indexed one (pure translation)', () => {
    // Raw point at (0,0,-10); model shifts it +3 in x. The user sees a dot
    // at x=3, so a ray down x=3 must find it and report x=3.
    const index = indexWithPointAt(0, 0, -10);
    const model = makeModel(1, 0, [3, 0, 0]);
    const hit = queryPointClouds(() => sourceWith(index, model), rayToward(3, 0), CAMERA, 100);
    assert.ok(hit, 'ray aimed at the rendered position must hit');
    assert.ok(Math.abs(hit!.position.x - 3) < 1e-3, `expected world x=3, got ${hit!.position.x}`);
    assert.ok(Math.abs(hit!.distance - 10) < 1e-3, `expected world distance 10, got ${hit!.distance}`);
  });

  it('does not snap at the raw position once the cloud is aligned', () => {
    // The mirror of the above: a ray down the RAW x=0 must now MISS,
    // because nothing is rendered there any more.
    const index = indexWithPointAt(0, 0, -10);
    const model = makeModel(1, 0, [3, 0, 0]);
    const hit = queryPointClouds(() => sourceWith(index, model), rayToward(0, 0), CAMERA, 100);
    assert.strictEqual(hit, null, 'stale raw position must not be snappable');
  });

  it('handles rotation + translation', () => {
    // 90deg about Y: the matrix maps pz onto column 2 = (-1, 0, 0), so raw
    // (0,0,-10) contributes -10 * (-1,0,0) = (10,0,0), plus the [5,0,0]
    // translation => rendered at (15,0,0).
    const index = indexWithPointAt(0, 0, -10);
    const model = makeModel(1, 90, [5, 0, 0]);
    const hit = queryPointClouds(
      () => sourceWith(index, model),
      { origin: { x: 15, y: 0, z: 5 }, direction: { x: 0, y: 0, z: -1 } },
      CAMERA,
      100,
    );
    assert.ok(hit, 'rotated+translated point must be found at its rendered position');
    assert.ok(Math.abs(hit!.position.x - 15) < 1e-2, `expected world x=15, got ${hit!.position.x}`);
    assert.ok(Math.abs(hit!.position.z - 0) < 1e-2, `expected world z=0, got ${hit!.position.z}`);
  });

  it('reports distance in WORLD units under a scaled matrix', () => {
    // k=2 doubles every distance: a raw point 10 local units away renders
    // 20 world units away, and `distance` feeds the measure tool directly.
    const index = indexWithPointAt(0, 0, -10);
    const model = makeModel(2, 0, [0, 0, 0]);
    const hit = queryPointClouds(() => sourceWith(index, model), rayToward(0, 0), CAMERA, 100);
    assert.ok(hit, 'scaled point must be found');
    assert.ok(Math.abs(hit!.position.z - -20) < 1e-2, `expected world z=-20, got ${hit!.position.z}`);
    assert.ok(Math.abs(hit!.distance - 20) < 1e-2, `expected world distance 20, got ${hit!.distance}`);
  });

  it('stays exact at georeferenced magnitudes (LV95)', () => {
    // The f32 precision case #1804 exists for: a Swiss-scale translation
    // must not smear the snapped position.
    const index = indexWithPointAt(0, 0, -10);
    const model = makeModel(1, 0, [2_600_000, 1_200_000, 450]);
    const hit = queryPointClouds(
      () => sourceWith(index, model),
      { origin: { x: 2_600_000, y: 1_200_000, z: 450 }, direction: { x: 0, y: 0, z: -1 } },
      CAMERA,
      100,
    );
    assert.ok(hit, 'point must still be found at LV95 magnitude');
    assert.ok(Math.abs(hit!.position.x - 2_600_000) < 0.5, `x drifted: ${hit!.position.x}`);
    assert.ok(Math.abs(hit!.distance - 10) < 0.5, `distance drifted: ${hit!.distance}`);
  });

  it('is unchanged for an absent or identity matrix', () => {
    const index = indexWithPointAt(0, 0, -10);
    const bare = queryPointClouds(() => sourceWith(index, undefined), rayToward(0, 0), CAMERA, 100);
    const identity = queryPointClouds(
      () => sourceWith(index, makeModel(1, 0, [0, 0, 0])),
      rayToward(0, 0),
      CAMERA,
      100,
    );
    assert.ok(bare, 'unaligned cloud must still snap');
    assert.ok(identity, 'identity matrix must behave like no matrix');
    assert.deepStrictEqual(identity!.position, bare!.position);
    assert.strictEqual(identity!.distance, bare!.distance);
  });
});

/**
 * Renderer -> query wiring (#1804 x #1860).
 *
 * The reconciliation is only real if the renderer actually HANDS the
 * matrix to the query. The original gap survived precisely because nothing
 * exercised this seam — `getRayQuerySources` needs a GPUDevice, so the
 * source-building is extracted as a pure function to make it testable.
 */
describe('buildRayQuerySources', () => {
  const MASK = new Uint32Array(8).fill(0xffffffff);
  const model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]);

  function node(expressId: number, pointCount: number, m?: Float32Array) {
    return { meta: { expressId, modelIndex: 3 }, spatialIndex: { pointCount }, model: m };
  }

  it('forwards each node\'s model matrix to the query', () => {
    const [src] = buildRayQuerySources([node(1, 5, model)], MASK);
    assert.strictEqual(src.model, model, 'the alignment matrix must reach the snap query');
    assert.strictEqual(src.expressId, 1);
    assert.strictEqual(src.modelIndex, 3);
    assert.strictEqual(src.classMask, MASK);
  });

  it('leaves model undefined for an unaligned node', () => {
    const [src] = buildRayQuerySources([node(2, 5, undefined)], MASK);
    assert.strictEqual(src.model, undefined);
  });

  it('skips empty nodes', () => {
    const out = buildRayQuerySources([node(1, 0, model), node(2, 4, model)], MASK);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].expressId, 2);
  });
});
