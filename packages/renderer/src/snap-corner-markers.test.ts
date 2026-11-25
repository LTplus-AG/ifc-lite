/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Snap markers of the CAD-style corner search (#11504): `ScreenCornerIndex.candidatesNear`
 * and the channel the engine publishes them through. Orthographic camera down -Z,
 * 15 px per world unit: the screen position of a corner is (400 + 15 x, 300 - 15 y).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { RaycastEngine } from './raycast-engine.js';
import { Camera } from './camera.js';
import { Scene } from './scene.js';
import { buildGeometryCache } from './snap-geometry-cache.js';
import { ScreenCornerIndex, type ScreenCornerSnapOptions } from './snap-screen-corners.js';
import type { Mesh } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 1, INDEX: 2, VERTEX: 4 };

type V3 = [number, number, number];

function makeBox(expressId: number, min: V3, max: V3, modelIndex = 0): MeshData {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? max[0] : min[0];
    positions[i * 3 + 1] = i & 2 ? max[1] : min[1];
    positions[i * 3 + 2] = i & 4 ? max[2] : min[2];
  }
  const indices = new Uint32Array([
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4,
    2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
  ]);
  return { expressId, modelIndex, positions, normals: new Float32Array(24), indices, color: [1, 1, 1, 1] };
}

function cameraDownZ(): Camera {
  const camera = new Camera();
  camera.setAspect(800 / 600);
  camera.setProjectionMode('orthographic');
  camera.setOrthoSize(20);
  camera.setPosition(0, 0, 50);
  camera.setTarget(0, 0, 0);
  camera.setUp(0, 1, 0);
  return camera;
}

const viewport = { width: 800, height: 600 };

/** Run one index query at (x, y), as the engine does before it asks for markers. */
function run(index: ScreenCornerIndex, pieces: MeshData[], at: { x: number; y: number }, opts: {
  options?: ScreenCornerSnapOptions; hitDistance?: number | null; viewKey?: string; clock?: () => number;
} = {}) {
  const camera = cameraDownZ();
  return index.query({
    x: at.x, y: at.y, ray: camera.unprojectToRay(at.x, at.y, viewport.width, viewport.height), camera,
    viewKey: opts.viewKey ?? 'v0', viewport, pieces, geometryFor: (m) => buildGeometryCache(m),
    options: { settleMs: 0, buildBudgetMs: 1e9, ...opts.options }, hitDistance: opts.hitDistance ?? null, now: opts.clock,
  });
}

/** Unit boxes along the x axis at x = 0, 2, 4, ...: their near corners project 30 px apart. */
const row = (n: number) => Array.from({ length: n }, (_, i) => makeBox(i + 1, [i * 2, 0, 0], [i * 2 + 1, 1, 1]));

describe('ScreenCornerIndex.candidatesNear (#11504)', () => {
  it('lists the eligible corners near the cursor, nearest first', () => {
    const index = new ScreenCornerIndex();
    run(index, row(3), { x: 430, y: 285 });
    const found = index.candidatesNear(430, 285, 48, 12);
    assert.ok(found.length >= 4);
    const distances = found.map((c) => c.distancePx);
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b), 'sorted by distance');
    assert.ok(distances.every((d) => d <= 48), 'all inside the radius');
    // Box 2 (x 2..3) corner (2, 1) is at (430, 285): under the cursor. Its z = 1 corner (nearer the viewer) leads the z = 0 one.
    assert.deepEqual(found.slice(0, 2).map((c) => [Math.round(c.distancePx), c.position.x, c.position.y, c.position.z, c.expressId]), [[0, 2, 1, 1, 2], [0, 2, 1, 0, 2]]);
    assert.deepEqual([Math.round(found[0].screen.x), Math.round(found[0].screen.y)], [430, 285]);
  });

  it('caps the list at the limit and keeps the nearest', () => {
    const index = new ScreenCornerIndex();
    run(index, row(6), { x: 430, y: 300 });
    const all = index.candidatesNear(430, 300, 300, 100);
    const capped = index.candidatesNear(430, 300, 300, 3);
    assert.ok(all.length > 3);
    assert.equal(capped.length, 3);
    assert.deepEqual(capped.map((c) => c.distancePx), all.slice(0, 3).map((c) => c.distancePx));
    assert.deepEqual(index.candidatesNear(430, 300, 300, 0), []);
    assert.deepEqual(index.candidatesNear(430, 300, 0, 12), []);
  });

  it('lists only corners of the eligible models, hidden and isolated entities excluded', () => {
    const pieces = [makeBox(1, [0, 0, 0], [1, 1, 1], 0), makeBox(2, [2, 0, 0], [3, 1, 1], 1)];
    const ids = (index: ScreenCornerIndex) => [...new Set(index.candidatesNear(430, 300, 100, 12).map((c) => c.expressId))].sort();
    const index = new ScreenCornerIndex();
    run(index, pieces, { x: 430, y: 300 });
    assert.deepEqual(ids(index), [1, 2], 'both models by default');
    const only1 = new ScreenCornerIndex();
    run(only1, pieces, { x: 430, y: 300, }, { options: { eligibleModelIndices: new Set([1]) } });
    assert.deepEqual(ids(only1), [2], 'model 1 only');
    const hidden = new ScreenCornerIndex();
    const camera = cameraDownZ();
    hidden.query({
      x: 430, y: 300, ray: camera.unprojectToRay(430, 300, 800, 600), camera, viewKey: 'v0', viewport, pieces,
      geometryFor: (m) => buildGeometryCache(m), options: { settleMs: 0, buildBudgetMs: 1e9 }, hiddenIds: new Set([1]),
    });
    assert.deepEqual(ids(hidden), [2], 'entity 1 hidden');
  });

  it('skips corners behind the ray hit unless occlusion is ignored', () => {
    // A is the unit box at the origin (corners z 0 and 1); F (z 4..6) covers it; the ray hits F at depth 44.
    const pieces = [makeBox(1, [0, 0, 0], [1, 1, 1]), makeBox(2, [-1, -1, 4], [3, 3, 6])];
    const idsNear = (options?: ScreenCornerSnapOptions) => {
      const index = new ScreenCornerIndex();
      run(index, pieces, { x: 405, y: 295 }, { hitDistance: 44, options });
      return new Set(index.candidatesNear(405, 295, 48, 12).map((c) => c.expressId));
    };
    assert.deepEqual([...idsNear()], [2], 'only the corners of the covering box');
    assert.deepEqual([...idsNear({ ignoreOcclusion: true })].sort(), [1, 2], 'x-ray lists the hidden corners too');
    const nothingHit = new ScreenCornerIndex();
    run(nothingHit, pieces, { x: 405, y: 295 }, { hitDistance: null });
    assert.equal(new Set(nothingHit.candidatesNear(405, 295, 48, 12).map((c) => c.expressId)).size, 2, 'no ray hit: nothing is occluded');
  });

  it('lists nothing until a query reached a built grid, and nothing after the camera moved', () => {
    const pieces = row(2);
    const index = new ScreenCornerIndex();
    assert.deepEqual(index.candidatesNear(430, 300, 48, 12), [], 'before any query');
    let clock = 0;
    run(index, pieces, { x: 430, y: 300 }, { options: { settleMs: 120 }, clock: () => clock });
    assert.deepEqual(index.candidatesNear(430, 300, 48, 12), [], 'the settle window has not elapsed');
    clock = 130;
    run(index, pieces, { x: 430, y: 300 }, { options: { settleMs: 120 }, clock: () => clock });
    assert.ok(index.candidatesNear(430, 300, 48, 12).length > 0, 'settled');
    clock = 140;
    run(index, pieces, { x: 430, y: 300 }, { viewKey: 'moved', options: { settleMs: 120 }, clock: () => clock });
    assert.deepEqual(index.candidatesNear(430, 300, 48, 12), [], 'the camera moved: the old grid is not offered');
    index.dropLive();
    clock = 400;
    run(index, pieces, { x: 430, y: 300 }, { viewKey: 'moved', options: { settleMs: 120 }, clock: () => clock });
    assert.ok(index.candidatesNear(430, 300, 48, 12).length > 0);
    index.dropLive();
    assert.deepEqual(index.candidatesNear(430, 300, 48, 12), [], 'dropLive forgets the last query');
  });
});

describe('corner marker channel through the engine (#11504)', () => {
  const canvas = { width: 800, height: 600, getBoundingClientRect: () => ({ width: 800, height: 600 }) } as unknown as HTMLCanvasElement;
  const lock = { edge: null, meshExpressId: null, lockStrength: 0 };
  const base = { snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 4 };

  function sceneWith(...boxes: MeshData[]): Scene {
    const scene = new Scene();
    for (const box of boxes) {
      scene.addMeshData(box);
      const mesh: Mesh = {
        expressId: box.expressId, modelIndex: box.modelIndex,
        vertexBuffer: { destroy() {} } as GPUBuffer, indexBuffer: { destroy() {} } as GPUBuffer,
        indexCount: box.indices.length, transform: { m: new Float32Array(16) }, color: box.color,
      };
      scene.addMesh(mesh);
    }
    return scene;
  }

  const pickWith = (engine: RaycastEngine, x: number, y: number, screenCornerSnap: ScreenCornerSnapOptions | undefined) =>
    engine.raycastSceneMagnetic(x, y, lock, { snapOptions: { ...base, screenCornerSnap } });

  it('publishes the corners near the cursor and marks the one the pick used', () => {
    const engine = new RaycastEngine(cameraDownZ(), sceneWith(...row(3)), canvas);
    // Cursor 5 px right of box 2's near corner (2, 0, *) at (430, 300).
    const result = pickWith(engine, 435, 300, { settleMs: 0, markers: true });
    assert.equal(result.snapTarget?.type, 'vertex');
    const markers = engine.cornerMarkers.get();
    assert.ok(markers && markers.candidates.length > 1);
    assert.ok(markers.activeIndex >= 0);
    const active = markers.candidates[markers.activeIndex];
    assert.deepEqual([active.position.x, active.position.y], [result.snapTarget?.position.x, result.snapTarget?.position.y]);
    assert.equal(markers.candidates[0].distancePx <= markers.candidates[1].distancePx, true);
  });

  it('publishes nothing unless the pick asks for markers, and does not clear another pick\'s', () => {
    const engine = new RaycastEngine(cameraDownZ(), sceneWith(...row(2)), canvas);
    pickWith(engine, 435, 300, { settleMs: 0 });
    assert.equal(engine.cornerMarkers.get(), null, 'no markers option: nothing published');
    pickWith(engine, 435, 300, { settleMs: 0, markers: true });
    assert.ok(engine.cornerMarkers.get());
    pickWith(engine, 435, 300, undefined);
    assert.ok(engine.cornerMarkers.get(), 'a pick without the corner search leaves the markers alone');
  });

  it('notifies subscribers only when the markers change', () => {
    const engine = new RaycastEngine(cameraDownZ(), sceneWith(...row(2)), canvas);
    let calls = 0;
    const off = engine.cornerMarkers.subscribe(() => { calls++; });
    pickWith(engine, 435, 300, { settleMs: 0, markers: true });
    pickWith(engine, 435, 300, { settleMs: 0, markers: true });
    assert.equal(calls, 1, 'an identical second pick is not a change');
    pickWith(engine, 369, 300, { settleMs: 0, markers: true });
    assert.equal(calls, 2);
    off();
    pickWith(engine, 435, 300, { settleMs: 0, markers: true });
    assert.equal(calls, 2, 'unsubscribed');
  });

  it('with ignoreOcclusion the markers include corners behind the surface under the cursor', () => {
    const hiddenBehind = () => new RaycastEngine(cameraDownZ(), sceneWith(makeBox(1, [0, 0, 0], [1, 1, 1]), makeBox(2, [-1, -1, 4], [3, 3, 6])), canvas);
    const ids = (engine: RaycastEngine) => new Set(engine.cornerMarkers.get()?.candidates.map((c) => c.expressId));
    const shaded = hiddenBehind();
    pickWith(shaded, 405, 295, { settleMs: 0, markers: true });
    assert.deepEqual([...ids(shaded)], [2]);
    const xray = hiddenBehind();
    pickWith(xray, 405, 295, { settleMs: 0, markers: true, ignoreOcclusion: true });
    assert.deepEqual([...ids(xray)].sort(), [1, 2]);
  });
});
