/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from './scene.js';
import type { MeshData } from '@ifc-lite/geometry';
import { SceneTriangleCounts, TriangleCounts } from './triangle-counts.js';

it('counts split and merged indexed faces under their original objects (#10370)', () => {
  const counts = new TriangleCounts();
  const triangle = new Uint32Array([0, 1, 2]);
  counts.addMesh({ expressId: 7, indices: triangle });
  counts.addMesh({ expressId: 7, indices: triangle });
  counts.addMesh({ expressId: 999, indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    entityIds: new Uint32Array([7, 7, 7, 8, 8, 8]) });
  assert.equal(counts.byEntity.get(7), 3);
  assert.equal(counts.byEntity.get(8), 1);
  assert.equal(counts.byEntity.has(999), false);
  assert.equal([...counts.byEntity.values()].reduce((sum, count) => sum + count, 0), 4);
});

it('counts live template occurrences together with flat pieces without expanding vertices (#10370)', () => {
  const counts = new SceneTriangleCounts();
  counts.noteSources([sourceTriangle(7)]);
  const host = { templates: [{ indexCount: 3 }], instances: new Map([
    [7, [{ templateIndex: 0 }]], [8, [{ templateIndex: 0 }, { templateIndex: 0 }]],
  ]) };
  const result = counts.read(host, 1, false);
  assert.equal(result?.get(7), 2);
  assert.equal(result?.get(8), 2);
  assert.equal(counts.read(host, 1, false), result, 'unchanged topology has a stable snapshot');
  host.instances.delete(8);
  assert.equal(counts.read(host, 2, false)?.has(8), false, 'removed occurrences no longer contribute');
  assert.equal(counts.read(host, 2, true), null, 'snapshot hydration cannot publish a premature zero');
});

function sourceTriangle(expressId: number): MeshData {
  return { expressId, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] };
}

it('keeps source counts across CPU release, deletion and a new scene (#10370)', () => {
  const scene = new CpuScene();
  const mesh = sourceTriangle(7);
  scene.queueMeshes([mesh, sourceTriangle(8)]);
  flushCpu(scene);
  assert.equal(scene.getTriangleCounts()?.get(7), 1);
  scene.releaseGeometryData();
  assert.equal(scene.getTriangleCounts()?.get(7), 1, 'releasing vertices does not erase compact source metadata');
  scene.removeMeshesForEntity(7);
  assert.equal(scene.getTriangleCounts()?.has(7), false);
  assert.equal(scene.getTriangleCounts()?.get(8), 1);
  scene.clearFlatGeometry();
  assert.equal(scene.getTriangleCounts(), null, 'a reset cannot claim a measured zero before source replay');
  scene.queueMeshes([sourceTriangle(7), sourceTriangle(7)]);
  assert.equal(scene.getTriangleCounts()?.get(7), 2, 'new geometry under a reused ID has its own count');
});

it('distinguishes a fresh Scene from an explicitly empty source and a removed last object (#10370 review)', () => {
  const scene = new CpuScene();
  assert.equal(scene.getTriangleCounts(), null);
  scene.queueMeshes([]);
  assert.equal(scene.getTriangleCounts()?.size, 0, 'an explicitly supplied empty source is known zero');
  scene.queueMeshes([sourceTriangle(7)]); flushCpu(scene);
  scene.removeMeshesForEntity(7);
  assert.equal(scene.getTriangleCounts()?.size, 0, 'removing the last uploaded object is also known zero');
});

it('notifies count consumers once after a batch and stops after unsubscribe (#10370)', async () => {
  const scene = new Scene();
  const observed: number[] = [];
  const release = scene.onGeometryChange(() => observed.push(scene.getTriangleCounts()?.get(7) ?? 0));
  scene.queueMeshes([sourceTriangle(7)]);
  scene.queueMeshes([sourceTriangle(7)]);
  await Promise.resolve();
  assert.deepEqual(observed, [2]);
  release();
  scene.clearFlatGeometry();
  await Promise.resolve();
  assert.deepEqual(observed, [2]);
});

// The production queue still decides chunks/read positions; CPU registration
// lets these ownership invariants run without a Node WebGPU adapter.
class CpuScene extends Scene {
  override appendToBatches(meshes: MeshData[]): void { for (const mesh of meshes) this.addMeshData(mesh); }
}
function flushCpu(scene: CpuScene): void {
  scene.flushPending({} as GPUDevice, {} as Parameters<Scene['flushPending']>[1], Number.POSITIVE_INFINITY);
}

it('treats empty ownership arrays as dedicated object geometry (#10370 review)', () => {
  const scene = new CpuScene();
  scene.queueMeshes([7, 8].map(id => ({ ...sourceTriangle(id), entityIds: new Uint32Array(0) })));
  flushCpu(scene);
  const counts = scene.getTriangleCounts();
  assert.deepEqual([...counts!.entries()].sort(), [[7, 1], [8, 1]]);
});

it('preserves unregistered queued counts when removal cannot remove that mesh (#10370 review)', () => {
  const scene = new CpuScene();
  scene.queueMeshes([sourceTriangle(7)]);
  assert.equal(scene.removeMeshesForEntity(7), false);
  assert.equal(scene.getTriangleCounts()?.get(7), 1);
  flushCpu(scene);
  let raw = 0;
  scene.forEachMeshData(mesh => { raw += mesh.indices.length / 3; });
  assert.equal(raw, 1);
  assert.equal(scene.getTriangleCounts()?.get(7), raw);
});

it('removes uploaded contributions while retaining later queued pieces of the same object (#10370 review)', () => {
  const scene = new CpuScene();
  scene.queueMeshes([sourceTriangle(7)]); flushCpu(scene);
  scene.queueMeshes([sourceTriangle(7)]);
  assert.equal(scene.getTriangleCounts()?.get(7), 2);
  assert.equal(scene.removeMeshesForEntity(7), true);
  assert.equal(scene.getTriangleCounts()?.get(7), 1);
  flushCpu(scene);
  let raw = 0;
  scene.forEachMeshData(mesh => { raw += mesh.indices.length / 3; });
  assert.equal(raw, 1);
  assert.equal(scene.getTriangleCounts()?.get(7), raw);
  scene.removeMeshesForEntity(7);
  assert.equal(scene.getTriangleCounts()?.has(7), false, 'flushed pieces no longer count as queued');
});


it('requires a fresh explicit replay completion after source append or scene reset (#10370 review)', () => {
  const scene = new CpuScene();
  scene.queueMeshes([sourceTriangle(7)]);
  assert.equal(scene.isTriangleCountReplayComplete(), false);
  scene.setTriangleCountReplayComplete(true);
  assert.equal(scene.isTriangleCountReplayComplete(), true);
  scene.queueMeshes([sourceTriangle(8)]);
  assert.equal(scene.isTriangleCountReplayComplete(), false, 'new source invalidates an earlier receipt');
  scene.setTriangleCountReplayComplete(true);
  scene.clearFlatGeometry();
  scene.queueMeshes([sourceTriangle(7)]);
  assert.equal(scene.isTriangleCountReplayComplete(), false, 'one replayed object is not completion');
  assert.equal(scene.getTriangleCounts()?.get(7), 1, 'raw source metadata is separate from replay completion');
});
