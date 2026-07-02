/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { Intersection } from './raycaster.js';
import { SnapDetector, SnapType } from './snap-detector.js';

/**
 * Regression test for issue #1405: measure-snap missed all-but-one occurrence of
 * GPU-instanced geometry.
 *
 * `Scene.getInstancedMeshDataPieces` materializes one MeshData per occurrence, all
 * sharing the same `expressId` but holding distinct world-space positions. The
 * snap-geometry cache used to key on `expressId` alone, so the first occurrence's
 * deduped vertices/edges were served for every later occurrence — whose true world
 * positions are elsewhere — and snap silently fell back to a free-point face hit.
 * The fix keys the cache on the per-occurrence `occurrenceKey` when present.
 */

// Unit cube [0,1]^3, 8 verts / 12 tris. Adjacent faces meet at 90°, so all 12 cube
// edges survive the cache's coplanar-diagonal filter and are real snap edges.
const CUBE_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3, // bottom z=0
  4, 6, 5, 4, 7, 6, // top    z=1
  0, 5, 1, 0, 4, 5, // front  y=0
  3, 2, 6, 3, 6, 7, // back   y=1
  0, 3, 7, 0, 7, 4, // left   x=0
  1, 5, 6, 1, 6, 2, // right  x=1
]);

function makeCube(expressId: number, offsetX: number, occurrenceKey?: string): MeshData {
  const base = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const positions = new Float32Array(base.length * 3);
  for (let i = 0; i < base.length; i++) {
    positions[i * 3] = base[i][0] + offsetX;
    positions[i * 3 + 1] = base[i][1];
    positions[i * 3 + 2] = base[i][2];
  }
  return {
    expressId,
    positions,
    normals: new Float32Array(positions.length), // cache derives normals from positions
    indices: CUBE_INDICES,
    color: [0.5, 0.5, 0.5, 1],
    occurrenceKey,
  };
}

// A raycast hit landing exactly on `corner` of the mesh at meshes[meshIndex].
function hitAtCorner(meshIndex: number, expressId: number, corner: [number, number, number]): Intersection {
  return {
    point: { x: corner[0], y: corner[1], z: corner[2] },
    normal: { x: -1, y: 0, z: 0 },
    distance: 100,
    meshIndex,
    triangleIndex: 0,
    expressId,
    barycentricCoord: { u: 1, v: 0, w: 0 },
  };
}

// fov in RADIANS, matching Camera.getFOV() (the real snap call site).
const CAMERA = { position: { x: 0, y: 0, z: 100 }, fov: Math.PI / 4 };
const SCREEN_H = 800;

test('snap finds a vertex on EVERY instanced occurrence, not just the first (#1405)', () => {
  // Two occurrences of one instanced entity: same expressId, distinct world placement.
  const occA = makeCube(100, 0, '100:inst:0:0');
  const occB = makeCube(100, 10, '100:inst:0:64');
  const meshes = [occA, occB];
  const detector = new SnapDetector();

  // Hit occurrence A's corner first — this populates the cache.
  const snapA = detector.detectSnapTarget(
    { origin: CAMERA.position, direction: { x: 0, y: 0, z: -1 } },
    meshes,
    hitAtCorner(0, 100, [0, 0, 0]),
    CAMERA,
    SCREEN_H,
  );
  assert.ok(snapA, 'occurrence A should produce a snap target');
  assert.equal(snapA!.type, SnapType.VERTEX, 'occurrence A should snap to a vertex');

  // Now hit occurrence B's corresponding corner (offset +10 in x). Pre-fix this
  // returned occurrence A's cached geometry (≥9 units away → no vertex/edge), so it
  // fell back to a FACE hit. The fix must snap to B's own corner.
  const snapB = detector.detectSnapTarget(
    { origin: CAMERA.position, direction: { x: 0, y: 0, z: -1 } },
    meshes,
    hitAtCorner(1, 100, [10, 0, 0]),
    CAMERA,
    SCREEN_H,
  );
  assert.ok(snapB, 'occurrence B should produce a snap target');
  assert.equal(snapB!.type, SnapType.VERTEX, 'occurrence B should snap to a vertex, not free-point face');
  assert.ok(
    Math.abs(snapB!.position.x - 10) < 1e-4,
    `occurrence B snap must use B's own world geometry (x≈10), got x=${snapB!.position.x}`,
  );
});

test('snap is independent of which occurrence populates the cache first (#1405)', () => {
  const occA = makeCube(100, 0, '100:inst:0:0');
  const occB = makeCube(100, 10, '100:inst:0:64');
  const meshes = [occA, occB];
  const detector = new SnapDetector();

  // Reverse order: hit B first, then A.
  const snapB = detector.detectSnapTarget(
    { origin: CAMERA.position, direction: { x: 0, y: 0, z: -1 } },
    meshes,
    hitAtCorner(1, 100, [10, 0, 0]),
    CAMERA,
    SCREEN_H,
  );
  const snapA = detector.detectSnapTarget(
    { origin: CAMERA.position, direction: { x: 0, y: 0, z: -1 } },
    meshes,
    hitAtCorner(0, 100, [0, 0, 0]),
    CAMERA,
    SCREEN_H,
  );

  assert.equal(snapB!.type, SnapType.VERTEX);
  assert.ok(Math.abs(snapB!.position.x - 10) < 1e-4, `B snap x≈10, got ${snapB!.position.x}`);
  assert.equal(snapA!.type, SnapType.VERTEX);
  assert.ok(Math.abs(snapA!.position.x - 0) < 1e-4, `A snap x≈0, got ${snapA!.position.x}`);
});

test('flat meshes (no occurrenceKey) still snap, keyed by expressId', () => {
  // Distinct flat meshes with distinct expressIds: the expressId fallback must hold.
  const a = makeCube(1, 0);
  const b = makeCube(2, 10);
  const meshes = [a, b];
  const detector = new SnapDetector();

  const snap = detector.detectSnapTarget(
    { origin: CAMERA.position, direction: { x: 0, y: 0, z: -1 } },
    meshes,
    hitAtCorner(1, 2, [10, 0, 0]),
    CAMERA,
    SCREEN_H,
  );
  assert.equal(snap!.type, SnapType.VERTEX);
  assert.ok(Math.abs(snap!.position.x - 10) < 1e-4, `flat-mesh snap x≈10, got ${snap!.position.x}`);
});

const RAY = { origin: CAMERA.position, direction: { x: 0, y: 0, z: -1 } };

test('snap finds a vertex on EVERY flat sub-piece of one expressId, not just the first', () => {
  // Mesh fragmentation emits ONE entity as several flat pieces sharing an
  // expressId with NO occurrenceKey (e.g. an IfcMechanicalFastener "Bolt
  // assembly" materialized as many pieces). Distinct world positions; here the
  // sub-pieces differ in their local positions.
  const pieceA = makeCube(500, 0);
  const pieceB = makeCube(500, 10);
  const meshes = [pieceA, pieceB];
  const detector = new SnapDetector();

  // Fill the cache from A first.
  detector.detectSnapTarget(RAY, meshes, hitAtCorner(0, 500, [0, 0, 0]), CAMERA, SCREEN_H);
  // Pre-fix B (same expressId) reused A's cached geometry → no nearby vertex → face fallback.
  const snapB = detector.detectSnapTarget(RAY, meshes, hitAtCorner(1, 500, [10, 0, 0]), CAMERA, SCREEN_H);
  assert.equal(snapB!.type, SnapType.VERTEX, 'second flat piece must snap to its own vertex');
  assert.ok(Math.abs(snapB!.position.x - 10) < 1e-4, `piece B snap x≈10, got ${snapB!.position.x}`);
});

test('snap distinguishes flat mapped copies that share local positions and differ only by origin', () => {
  // The IfcMappedItem bolt case: same expressId, identical LOCAL geometry, distinct
  // `origin` (placement). The cache lifts local+origin to world, so the two copies
  // hold different world geometry and must not share a cache entry.
  const local = makeCube(600, 0);
  const copyA: MeshData = { ...local, origin: [0, 0, 0] };
  const copyB: MeshData = { ...local, origin: [10, 0, 0] };
  const meshes = [copyA, copyB];
  const detector = new SnapDetector();

  detector.detectSnapTarget(RAY, meshes, hitAtCorner(0, 600, [0, 0, 0]), CAMERA, SCREEN_H);
  const snapB = detector.detectSnapTarget(RAY, meshes, hitAtCorner(1, 600, [10, 0, 0]), CAMERA, SCREEN_H);
  assert.equal(snapB!.type, SnapType.VERTEX, 'mapped copy B should snap to its own corner, not copy A geometry');
  assert.ok(Math.abs(snapB!.position.x - 10) < 1e-4, `copy B snap x≈10, got ${snapB!.position.x}`);
});
