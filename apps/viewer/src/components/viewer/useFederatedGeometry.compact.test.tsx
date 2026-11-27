/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { adoptCompactMeshes, compactHydrationStats, loadCompactGeometry, type CompactPayload } from '@ifc-lite/geometry/compact';
import { fixtureModel } from '@/test/store-fixture.js';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release.js';
import { sameMeshUpload } from './mesh-upload-identity.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';

// Compact geometry (`?compactGeom`) is asked for on the primary load only. Adding a second model
// merges the primary's meshes into wrapper copies; those must stay compact shells, or the add decodes
// the whole primary model on the main thread (CAMPAIGN known limit, #11424).

const coordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

/** `count` one-triangle compact meshes on the 2^-10 lattice: (0,0,0), (1,0,0), (0,1,0) m, normals +z. */
function compactMeshes(count: number, firstId: number): MeshData[] {
  const payload: CompactPayload = {
    records: new Uint8Array(count * 3 * 12), indices: new Uint16Array(count * 3), table: new Uint32Array(count * 6),
    windows: new Float64Array(count * 3), bounds: new Float64Array(count * 6), cells: new Int32Array(count * 3),
  };
  const view = new DataView(payload.records.buffer);
  const meshes: MeshData[] = [];
  for (let row = 0; row < count; row++) {
    payload.table.set([row, row * 3, 3, row * 3, 3, 10], row * 6);
    payload.indices.set([0, 1, 2], row * 3);
    payload.bounds.set([0, 0, 0, 1, 1, 0], row * 6);
    [[0, 0], [1024, 0], [0, 1024]].forEach(([x, y], corner) => {
      const at = (row * 3 + corner) * 12;
      view.setUint16(at, x, true);
      view.setUint16(at + 2, y, true);
      view.setUint16(at + 6, (128 << 8) | 128, true);
    });
    meshes.push({ expressId: firstId + row, color: [1, 1, 1, 1], positions: new Float32Array(0), normals: new Float32Array(0),
      indices: new Uint32Array(0), compact: { batch: 0, row } } as unknown as MeshData);
  }
  adoptCompactMeshes(meshes, [payload]);
  return meshes;
}

function f32Mesh(id: number): MeshData {
  return { expressId: id, color: [1, 1, 1, 1], positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
}

function geometry(meshes: MeshData[]): GeometryResult {
  return { meshes, totalTriangles: meshes.length, totalVertices: meshes.length * 3, coordinateInfo };
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); });
before(async () => { await loadCompactGeometry(); });

it('adding a second model decodes none of the primary model\'s compact meshes', () => {
  const primary = compactMeshes(50, 1);
  let models = new Map([['a', { ...fixtureModel('a'), geometryResult: geometry(primary) }]]);
  let indices = new Map([['a', 0]]);
  let current: GeometryResult | null = null;
  function Probe() { current = useFederatedGeometry(models, null, indices, 0); return null; }
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  cleanups.push(() => { act(() => root.unmount()); node.remove(); });
  act(() => root.render(<Probe />));
  assert.ok(primary.every((mesh) => mesh.compact), 'the primary load delivered compact shells');

  const decodedBefore = compactHydrationStats().meshes;
  models = new Map(models).set('b', { ...fixtureModel('b'), geometryResult: geometry([f32Mesh(100)]) });
  indices = new Map([['a', 0], ['b', 1]]);
  act(() => root.render(<Probe />));
  const merged = current!.meshes;

  assert.equal(merged.length, primary.length + 1);
  assert.equal(compactHydrationStats().meshes, decodedBefore, 'no compact mesh was decoded by the add');
  merged.slice(0, primary.length).forEach((wrapper, i) => {
    assert.notEqual(wrapper, primary[i], 'a wrapper, not the store mesh');
    assert.equal(wrapper.compact, primary[i].compact, 'the wrapper is still drawn from the same records');
    assert.equal(wrapper.modelIndex, 0);
    assert.equal(wrapper.expressId, primary[i].expressId);
  });
  assert.equal(merged[primary.length].modelIndex, 1);
  // The scene filter compares the merged wrappers with the uploads it holds (the store meshes): same records, same upload.
  assert.ok(merged.slice(0, primary.length).every((wrapper, i) => sameMeshUpload(primary[i], wrapper)));
  assert.equal(compactHydrationStats().meshes, decodedBefore, 'nor by the upload identity check');

  // A consumer that does read a wrapper's arrays still gets the geometry, decoded once for the mesh and its wrapper.
  assert.deepEqual([...merged[0].positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(merged[0].positions, primary[0].positions, 'wrapper and store mesh share one decode');
  assert.equal(compactHydrationStats().meshes, decodedBefore + 1);
});

it('a rebuild of the merged list (a model removed) keeps the remaining compact meshes undecoded', () => {
  const primary = compactMeshes(10, 1);
  let models = new Map([['a', { ...fixtureModel('a'), geometryResult: geometry(primary) }],
    ['b', { ...fixtureModel('b'), geometryResult: geometry([f32Mesh(100)]) }],
    ['c', { ...fixtureModel('c'), geometryResult: geometry([f32Mesh(200)]) }]]);
  let indices = new Map([['a', 0], ['b', 1], ['c', 2]]);
  let current: GeometryResult | null = null;
  function Probe() { current = useFederatedGeometry(models, null, indices, 0); return null; }
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  cleanups.push(() => { act(() => root.unmount()); node.remove(); });
  act(() => root.render(<Probe />));
  const decodedBefore = compactHydrationStats().meshes;

  models = new Map(models); models.delete('c');
  indices = new Map([['a', 0], ['b', 1]]);
  act(() => root.render(<Probe />));
  assert.equal(current!.meshes.length, primary.length + 1);
  assert.ok(current!.meshes.slice(0, primary.length).every((mesh) => mesh.compact));
  assert.equal(compactHydrationStats().meshes, decodedBefore);
});

it('a CPU release of a compact mesh empties its merged wrappers too', () => {
  const primary = compactMeshes(2, 1);
  let models = new Map([['a', { ...fixtureModel('a'), geometryResult: geometry(primary) }]]);
  let indices = new Map([['a', 0]]);
  let current: GeometryResult | null = null;
  function Probe() { current = useFederatedGeometry(models, null, indices, 0); return null; }
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  cleanups.push(() => { act(() => root.unmount()); node.remove(); });
  act(() => root.render(<Probe />));
  models = new Map(models).set('b', { ...fixtureModel('b'), geometryResult: geometry([f32Mesh(100)]) });
  indices = new Map([['a', 0], ['b', 1]]);
  act(() => root.render(<Probe />));
  const wrapper = current!.meshes[0];
  assert.ok(wrapper.compact);

  releaseCpuMeshBuffers([primary[0]]);
  for (const mesh of [primary[0], wrapper]) {
    assert.equal(mesh.compact, undefined, 'released as an ordinary mesh');
    assert.equal(mesh.positions.length + mesh.normals.length + mesh.indices.length, 0, 'no decoded array is kept alive');
  }
  assert.ok(current!.meshes[1].compact, 'the other mesh is untouched');
});
