/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The camera fit on a `?compactGeom` load (lane L5 flag-on qualification): scanning a compact shell's
// `positions` decoded every mesh on the main thread and framed the lattice positions, which sit up to
// half a step from the source, so the flag-on home view was shifted against the f32 load's.

import { before, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { adoptCompactMeshes, compactHydrationStats, loadCompactGeometry, type CompactPayload } from '@ifc-lite/geometry/compact';
import { createRobustFitBoundsAccumulator, robustFitBoundsFull } from './robustFitBoundsAccumulator.js';

before(async () => { await loadCompactGeometry(); });

/**
 * The f32 triangle a load delivers, and the compact shell the encoder writes for it: its records snap the
 * corners to the 2^-10 m lattice, its row box is the exact f64 `origin + position` box of the source.
 */
function pair(origin: [number, number, number], corners: [number, number, number][], copies = 1, welded = 3): { f32: MeshData; compact: MeshData } {
  // `copies` repeats the corners in the f32 mesh, as a flat-shaded source repeats a vertex per face; `welded` is the
  // row's welded vertex count (only the camera fit's weighing reads it here).
  const positions = Float32Array.from(Array.from({ length: copies }, () => corners.flat()).flat());
  const f32: MeshData = { expressId: 1, color: [1, 1, 1, 1], origin, positions, normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]) };
  const world = corners.map((c) => c.map((v, axis) => origin[axis] + Math.fround(v)));
  const min = [0, 1, 2].map((axis) => Math.min(...world.map((c) => c[axis])));
  const max = [0, 1, 2].map((axis) => Math.max(...world.map((c) => c[axis])));
  const payload: CompactPayload = {
    records: new Uint8Array(36), indices: Uint16Array.from([0, 1, 2]), table: Uint32Array.from([0, 0, welded, 0, 3, 10, 3 * copies]),
    windows: Float64Array.from(min.map((v) => Math.floor(v * 1024) - 1024)), bounds: Float64Array.from([...min, ...max]), cells: new Int32Array(3),
  };
  const view = new DataView(payload.records.buffer);
  world.forEach((c, corner) => c.forEach((v, axis) => view.setUint16(corner * 12 + axis * 2, Math.round(v * 1024) - payload.windows[axis], true)));
  const compact = { expressId: 1, color: [1, 1, 1, 1], origin, positions: new Float32Array(0), normals: new Float32Array(0),
    indices: new Uint32Array(0), compact: { batch: 0, row: 0 } } as unknown as MeshData;
  adoptCompactMeshes([compact], [payload]);
  return { f32, compact };
}

it('frames a compact mesh on its exact source box without decoding it', () => {
  // Corners off the lattice by a fraction of a step, as real models are.
  const { f32, compact } = pair([1000.25, 2.5, -40], [[0.0001234, 0.3337, 0], [3.21987, 0.00042, 1.1113], [0.5, 2.99971, 0.25]]);
  const decoded = compactHydrationStats().meshes;
  const fit = createRobustFitBoundsAccumulator().update([compact]);
  assert.equal(compactHydrationStats().meshes, decoded, 'the fit read no compact geometry array');
  assert.deepEqual(fit, robustFitBoundsFull([f32]), 'the same frame as the f32 load');
  assert.deepEqual(robustFitBoundsFull([compact]), robustFitBoundsFull([f32]));
  assert.ok(compact.compact, 'still drawn from its records');
});

it('scans a compact mesh whose box has a garbage corner, keeping its valid vertices as the f32 scan does', () => {
  const { f32, compact } = pair([0, 0, 0], [[0, 0, 0], [10, 0, 0], [0, 10, 0]]);
  compact.compact!.payload.bounds.set([0, 0, 0, 1e13, 10, 0]); // one source vertex far out
  const fit = robustFitBoundsFull([compact]);
  assert.ok(fit, 'still framed');
  assert.deepEqual(fit!.full, robustFitBoundsFull([f32])!.full);
});

it('weighs a compact mesh by its source vertices, so the robust trim drops what the f32 load drops', () => {
  // Eight near meshes of 99 source (and welded) vertices, and a far mesh as large as the model (so stage 1
  // does not take it for a marker) of 60 source vertices welded to 3: by source vertices it is 7% of the mass
  // and stays framed; by welded vertices it is a 0.4% tail the trim would drop (lane L9: skolebygg's flag-on
  // fit dropped 261 far meshes where the f32 load dropped 270).
  const near = Array.from({ length: 8 }, (_, i) => pair([i * 2, 0, 0], [[0, 0, 0], [1, 0, 0], [0, 1, 0]], 33, 99));
  const far = pair([100, 0, 0], [[0, 0, 0], [20, 0, 0], [0, 20, 0]], 20, 3);
  const welded = robustFitBoundsFull([...near.map((p) => p.f32), { ...far.f32, positions: far.f32.positions.subarray(0, 9) }]);
  assert.ok(welded!.robust, 'weighed by 3 vertices, the far mesh is trimmed');
  const f32 = robustFitBoundsFull([...near.map((p) => p.f32), far.f32]);
  assert.equal(f32!.robust, null, 'the f32 load keeps the far mesh');
  assert.deepEqual(robustFitBoundsFull([...near.map((p) => p.compact), far.compact]), f32);
  assert.deepEqual(createRobustFitBoundsAccumulator().update([...near.map((p) => p.compact), far.compact]), f32);
});

it('frames a compact mesh where its origin moved it after encoding, as the f32 scan does', () => {
  const { f32, compact } = pair([10, 0, 0], [[0, 0, 0], [2, 0, 0], [0, 3, 0]]);
  f32.origin = [12, 5, -1];
  compact.origin = [12, 5, -1]; // an RTC re-anchor rewrites the origin; positions stay relative to it
  assert.deepEqual(robustFitBoundsFull([compact]), robustFitBoundsFull([f32]));
});
