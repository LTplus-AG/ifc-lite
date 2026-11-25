/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CAD-style screen-space corner snapping (#11504), through the real
 * `RaycastEngine.raycastSceneMagnetic` with a real orthographic `Camera` and
 * `Scene`. Scale: 15 px per world unit, so the screen position of a corner is
 * (400 + 15 x, 300 - 15 y).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { RaycastEngine } from './raycast-engine.js';
import { Camera } from './camera.js';
import { Scene } from './scene.js';
import { buildGeometryCache } from './snap-geometry-cache.js';
import { ScreenCornerIndex, closestPointOnSegmentToRay } from './snap-screen-corners.js';
import type { Mesh } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 1, INDEX: 2, VERTEX: 4 };

type V3 = [number, number, number];

/** Axis-aligned box as an 8-vertex indexed mesh (vertex bit 0 = x, 1 = y, 2 = z). */
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

const canvas = { width: 800, height: 600, getBoundingClientRect: () => ({ width: 800, height: 600 }) } as unknown as HTMLCanvasElement;
const lock = { edge: null, meshExpressId: null, lockStrength: 0 };
const base = { snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 4 };
const withCorners = { ...base, screenCornerSnap: { settleMs: 0 } };

function pick(scene: Scene, x: number, y: number, options: Record<string, unknown> = {}, clip?: Parameters<RaycastEngine['raycastSceneMagnetic']>[4]) {
  const engine = new RaycastEngine(cameraDownZ(), scene, canvas);
  return engine.raycastSceneMagnetic(x, y, lock, { snapOptions: withCorners, ...options }, clip);
}

// Box A top corner (0, 2, 2) projects to (400, 270).
const boxA = () => makeBox(1, [-4, -2, 0], [0, 2, 2]);

describe('screen-space corner snapping (#11504)', () => {
  it('(a) snaps a corner 5 px outside the element, over background', () => {
    const result = pick(sceneWith(boxA()), 405, 265);
    assert.equal(result.intersection, null, 'the ray hits nothing');
    assert.equal(result.snapTarget?.type, 'vertex');
    assert.equal(result.snapTarget?.expressId, 1);
    assert.deepEqual([result.snapTarget?.position.x, result.snapTarget?.position.y, result.snapTarget?.position.z], [0, 2, 2]);
  });

  it('falls back to an edge within 6 px when no corner is within 10 px', () => {
    // Top edge y = 2 runs from x = -4 to 0; (-200 px, ...) mid-edge is far from both ends.
    const result = pick(sceneWith(boxA()), 370, 265);
    assert.equal(result.snapTarget?.type, 'edge');
    assert.ok(Math.abs((result.snapTarget?.position.y ?? 0) - 2) < 1e-6);
    assert.ok(Math.abs((result.snapTarget?.position.x ?? 0) + 2) < 0.01);
    assert.equal(pick(sceneWith(boxA()), 370, 258).snapTarget, null, '12 px off the edge is outside both radii');
  });

  it('(b) a corner of another element wins over the element under the ray', () => {
    // B is taller and sits to the right of A's corner; the cursor is over B,
    // 6.4 px from A's corner (0, 2, 2) and 0.5 px from B's own left edge.
    const scene = sceneWith(boxA(), makeBox(2, [0.3, -2, 0], [4, 4, 1]));
    const result = pick(scene, 405, 274);
    assert.equal(result.intersection?.expressId, 2, 'the ray hits B');
    assert.equal(result.snapTarget?.type, 'vertex');
    assert.equal(result.snapTarget?.expressId, 1);
    assert.deepEqual([result.snapTarget?.position.x, result.snapTarget?.position.y, result.snapTarget?.position.z], [0, 2, 2]);
  });

  it('(c) ignores corners of a model that is not eligible', () => {
    const scene = sceneWith(makeBox(1, [-4, -2, 0], [0, 2, 2], 1));
    const only = (indices: number[]) => ({ snapOptions: { ...base, screenCornerSnap: { settleMs: 0, eligibleModelIndices: new Set(indices) } } });
    assert.equal(pick(scene, 405, 265, only([0])).snapTarget, null);
    assert.equal(pick(scene, 405, 265, only([1])).snapTarget?.type, 'vertex');
  });

  it('(d) ignores corners of hidden entities, and of anything outside the isolated set', () => {
    const scene = sceneWith(boxA());
    assert.equal(pick(scene, 405, 265, { hiddenIds: new Set([1]) }).snapTarget, null);
    assert.equal(pick(scene, 405, 265, { isolatedIds: new Set([99]) }).snapTarget, null);
    assert.equal(pick(scene, 405, 265, { isolatedIds: new Set([1]) }).snapTarget?.type, 'vertex');
  });

  it('(e) ignores a corner the section plane cut away', () => {
    // The plane removes z > 1: the top corner (0, 2, 2) is gone, the bottom one (0, 2, 0) stays.
    const clip = { sectionPlane: { normal: [0, 0, 1] as [number, number, number], distance: 1, flipped: false } };
    const result = pick(sceneWith(boxA()), 405, 265, {}, clip);
    assert.equal(result.snapTarget?.type, 'vertex');
    assert.equal(result.snapTarget?.position.z, 0, 'the kept corner, not the clipped one');
    const gone = pick(sceneWith(makeBox(1, [-4, -2, 2], [0, 2, 4])), 405, 265, {}, clip);
    assert.equal(gone.snapTarget, null, 'every corner of the element is clipped');
  });

  it('(f) changes nothing with snapping off', () => {
    const scene = sceneWith(boxA());
    assert.equal(pick(scene, 405, 265, { snapOptions: base }).snapTarget, null, 'no screenCornerSnap option');
    const off = { ...withCorners, snapToVertices: false, snapToEdges: false };
    assert.equal(pick(scene, 405, 265, { snapOptions: off }).snapTarget, null, 'vertex and edge snapping both off');
    // Over the element the ray-based result is untouched when the option is absent.
    const inside = pick(sceneWith(makeBox(1, [-4, -2, 0], [4, 2, 2])), 400, 300, { snapOptions: base });
    assert.equal(inside.snapTarget?.type, 'face');
  });

  it('skips a corner hidden behind a box unless occlusion is ignored', () => {
    // F (z 4..6) covers A's corner (0, 2, 2) in the view; the ray hits F at depth 44.
    const scene = () => sceneWith(boxA(), makeBox(2, [-1, -3, 4], [3, 3, 6]));
    const shaded = pick(scene(), 405, 265);
    assert.equal(shaded.intersection?.expressId, 2);
    assert.equal(shaded.snapTarget?.expressId, 2, 'the hidden corner of A does not win');
    assert.notEqual(shaded.snapTarget?.type, 'vertex');
    const xray = pick(scene(), 405, 265, { snapOptions: { ...base, screenCornerSnap: { settleMs: 0, ignoreOcclusion: true } } });
    assert.equal(xray.snapTarget?.type, 'vertex');
    assert.deepEqual([xray.snapTarget?.expressId, xray.snapTarget?.position.z], [1, 2]);
  });

  it('keeps the ray-based point when nothing is within the screen radii', () => {
    const inside = pick(sceneWith(makeBox(1, [-4, -2, 0], [4, 2, 2])), 400, 300);
    assert.equal(inside.snapTarget?.type, 'face');
    assert.equal(inside.snapTarget?.position.z, 2);
  });
});

describe('closestPointOnSegmentToRay', () => {
  it('is the segment point nearest the ray, clamped to the segment', () => {
    const ray = { origin: { x: 1, y: 5, z: 10 }, direction: { x: 0, y: 0, z: -1 } };
    assert.deepEqual(closestPointOnSegmentToRay({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, ray), { x: 1, y: 0, z: 0 });
    assert.deepEqual(closestPointOnSegmentToRay({ x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, ray), { x: 2, y: 0, z: 0 });
  });
});

describe('screen corner grid rebuild', () => {
  it('never rebuilds the grid inside a camera move: queries answer null until the view has been still', () => {
    const pieces: MeshData[] = [];
    for (let i = 0; i < 80; i++) for (let j = 0; j < 79; j++) pieces.push(makeBox(i * 100 + j + 1, [i * 0.5, j * 0.5, 0], [i * 0.5 + 0.3, j * 0.5 + 0.3, 0.3]));
    const camera = cameraDownZ();
    camera.setOrthoSize(30);
    const index = new ScreenCornerIndex();
    const ray = camera.unprojectToRay(400, 300, 800, 600);
    let clock = 0;
    const query = (viewKey: string) => index.query({
      x: 400, y: 300, ray, camera, viewKey, viewport: { width: 800, height: 600 }, pieces,
      geometryFor: (m) => buildGeometryCache(m), options: { buildBudgetMs: 1e9 }, now: () => clock,
    });
    assert.equal(query('v0'), null, 'first query of a view only starts the settle timer');
    clock = 130;
    assert.ok(query('v0'), 'still for 130 ms: the grid is built and answers');
    // The camera moves: every query inside the settle window returns at once.
    clock = 200;
    const t = performance.now();
    assert.equal(query('v1'), null);
    clock = 250;
    assert.equal(query('v2'), null, 'a further change restarts the timer');
    const blocked = performance.now() - t;
    assert.ok(blocked < 20, `queries during a camera move took ${blocked} ms; the ~100 ms grid rebuild must not run`);
    clock = 400;
    assert.ok(query('v2'), 'settled: rebuilt lazily on the first query');
  });
});

describe('screen corner query cost', () => {
  it('answers a query over ~50k corners in well under a frame', () => {
    // 80 x 79 grid of boxes, 8 corners each: 50.5k feature corners.
    const pieces: MeshData[] = [];
    for (let i = 0; i < 80; i++) {
      for (let j = 0; j < 79; j++) pieces.push(makeBox(i * 100 + j + 1, [i * 0.5, j * 0.5, 0], [i * 0.5 + 0.3, j * 0.5 + 0.3, 0.3]));
    }
    const camera = cameraDownZ();
    camera.setOrthoSize(30);
    const index = new ScreenCornerIndex();
    const geometryFor = (m: MeshData) => buildGeometryCache(m);
    const ray = camera.unprojectToRay(400, 300, 800, 600);
    const query = (x: number, y: number, viewKey: string) => index.query({
      x, y, ray, camera, viewKey, viewport: { width: 800, height: 600 }, pieces, geometryFor,
      options: { buildBudgetMs: 1e9, settleMs: 0 },
    });
    let t = performance.now();
    query(400, 300, 'v0'); // builds every piece's candidates and the grid
    const buildMs = performance.now() - t;
    t = performance.now();
    query(401, 300, 'v1'); // new camera: grid rebuild only
    const gridMs = performance.now() - t;
    const runs = 200;
    t = performance.now();
    for (let k = 0; k < runs; k++) query(300 + k, 200 + (k % 50), 'v1');
    const perMoveMs = (performance.now() - t) / runs;
    console.log(`screen-corner bench: ${pieces.length * 8} corners; candidate build ${buildMs.toFixed(0)} ms (once), grid rebuild ${gridMs.toFixed(1)} ms (per camera change), query ${perMoveMs.toFixed(3)} ms (per move)`);
    assert.ok(perMoveMs < 2, `per-move query took ${perMoveMs} ms`);
  });
});
