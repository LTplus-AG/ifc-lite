/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { MeshData } from '@ifc-lite/geometry';
import { BVH } from './bvh.js';
import { StreamingFragmentPieces } from './scene-fragment-pieces.js';
import { StreamAssembly } from './scene-stream-assembly.js';

// Loaded after asserting the module exists, so a reverted walk fails on an
// assertion rather than as a file that cannot load.
async function load(): Promise<typeof import('./cpu-geometry-visit.js')> {
  assert.ok(existsSync(new URL('./cpu-geometry-visit.ts', import.meta.url)), 'src/cpu-geometry-visit.ts must exist');
  return import('./cpu-geometry-visit.js');
}

function mesh(n: number, extra: Partial<MeshData> = {}): MeshData {
  return { expressId: 1, positions: new Float32Array(n * 3), normals: new Float32Array(n * 3), indices: new Uint32Array(n), color: [1, 1, 1, 1], ...extra };
}

describe('scene CPU geometry walk (#10264)', () => {
  it('reports fragment and stream-work arrays until finalize, with shared buffers visited per owner', async () => {
    const { visitSceneCpuGeometry } = await load();
    const shared = new Float32Array(12);
    const meshData = mesh(0, { positions: shared });
    const fragment = { id: 1 } as Parameters<StreamingFragmentPieces['record']>[0];
    const fragments = new StreamingFragmentPieces();
    const splitPiece = mesh(1);
    fragments.record(fragment, [meshData, splitPiece], new Map([[splitPiece, meshData]]));
    const streamWork = new StreamAssembly();
    const captured = new ArrayBuffer(64);
    streamWork.keepBytes(fragment, captured);
    streamWork.record(fragment, [meshData]);
    const source = {
      buckets: new Map(), meshDataMap: new Map(), meshQueue: [], meshQueueReadIndex: 0,
      instancedTemplateCpu: [], texturedMeshes: [], texturedSources: new WeakMap(),
      fragmentPieces: fragments, streamWork,
    };
    const calls: { owner: string; buffer: ArrayBufferLike; bytes: number }[] = [];
    const walk = () => visitSceneCpuGeometry(source, (owner, array) => calls.push({ owner, buffer: array.buffer, bytes: array.byteLength }));
    walk();
    const stream = calls.filter(entry => entry.owner === 'scene.fragmentPieces' || entry.owner === 'scene.streamWork');
    assert.ok(stream.some(entry => entry.buffer === splitPiece.positions.buffer));
    assert.equal(calls.filter(entry => entry.owner === 'scene.streamWork' && entry.buffer === captured).length, 1);
    assert.ok(calls.some(entry => entry.owner === 'scene.fragmentPieces' && entry.buffer === shared.buffer));
    assert.ok(calls.some(entry => entry.owner === 'scene.streamWork' && entry.buffer === shared.buffer));
    const retiring = streamWork.beginFinalize([fragment]);
    streamWork.endFinalize(retiring);
    fragments.retainOnly([]);
    calls.length = 0;
    walk();
    assert.equal(calls.filter(entry => entry.owner === 'scene.fragmentPieces' || entry.owner === 'scene.streamWork').reduce((sum, entry) => sum + entry.bytes, 0), 0);
  });
  it('counts a built batch snapshot after its bucket drops the mesh (#10506)', async () => {
    const { visitSceneCpuGeometry } = await load();
    const retained = mesh(3);
    const batch = { id: 90 } as Parameters<StreamingFragmentPieces['record']>[0];
    const fragments = new StreamingFragmentPieces();
    const bucket = { batchedMesh: batch, meshData: [retained] };
    fragments.recordBuilt(bucket);
    bucket.meshData.length = 0;
    const source = {
      buckets: new Map(), meshDataMap: new Map(), meshQueue: [], meshQueueReadIndex: 0,
      instancedTemplateCpu: [], texturedMeshes: [], texturedSources: new WeakMap(),
      fragmentPieces: fragments, streamWork: new StreamAssembly(),
    };
    const buffers = new Set<ArrayBufferLike>();
    visitSceneCpuGeometry(source, (_owner, array) => buffers.add(array.buffer));
    assert.ok(buffers.has(retained.positions.buffer));
    assert.ok(buffers.has(retained.normals.buffer));
    assert.ok(buffers.has(retained.indices.buffer));
    fragments.retainOnly([]);
    buffers.clear();
    visitSceneCpuGeometry(source, (_owner, array) => buffers.add(array.buffer));
    assert.equal(buffers.size, 0);
  });

  it('visits each holder, the queue from its read index, and a colour-merged mesh once', async () => {
    const { visitSceneCpuGeometry } = await load();
    const a = mesh(3), merged = mesh(3, { entityIds: new Uint32Array(3) }), queued = [mesh(1), mesh(2)];
    const textured = mesh(3, { uvs: new Float32Array(6) });
    const drawable = {};
    const texturedSources = new WeakMap([[drawable, { positions: textured.positions,
      fields: [textured.indices, textured.normals, textured.uvs, undefined].map((f) => f && new WeakRef(f)) }]]);
    const template = { positions: new Float32Array(6), normals: new Float32Array(6), indices: new Uint32Array(3), instanceData: new ArrayBuffer(64), canonicalAnchors: new Float64Array(3) };
    const visits: string[] = [];
    visitSceneCpuGeometry({
      buckets: new Map([['k', { meshData: [a, merged] }]]),
      meshDataMap: new Map([[1, [a, merged]], [2, [merged]]]),
      meshQueue: queued, meshQueueReadIndex: 1,
      instancedTemplateCpu: [undefined, template],
      texturedMeshes: [drawable], texturedSources,
      fragmentPieces: { visitMeshes: () => {} }, streamWork: { visitMeshes: () => {} },
    }, (owner, array, kind) => visits.push(`${owner}:${kind}:${array.byteLength}`));
    const count = (owner: string) => visits.filter((v) => v.startsWith(`${owner}:`)).length;
    assert.equal(count('scene.buckets'), 3 + 4);       // a: 3 arrays, merged: 3 + entityIds
    assert.equal(count('scene.meshDataMap'), 3 + 4);   // merged listed under ids 1 and 2, visited once
    assert.deepEqual(visits.filter((v) => v.startsWith('scene.meshQueue:')), ['scene.meshQueue:positions:24', 'scene.meshQueue:normals:24', 'scene.meshQueue:indices:8']);
    assert.equal(count('scene.instancedTemplates'), 5); // 3 arrays + instance records + anchors
    assert.equal(count('scene.textured'), 4);           // positions, indices, normals, uvs
  });

  it('visits a released (zero-length) mesh without inventing bytes', async () => {
    const { visitMeshArrays } = await load();
    const sizes: number[] = [];
    visitMeshArrays('store.models', mesh(0), (_o, array) => sizes.push(array.byteLength));
    assert.deepEqual(sizes, [0, 0, 0]);
  });

  it('exposes the BVH arrays it holds, and none after clear', () => {
    const bvh = new BVH();
    assert.equal(typeof bvh.visitArrays, 'function', 'BVH.visitArrays must exist');
    const pieces = Array.from({ length: 8 }, (_, i) => mesh(3, { positions: new Float32Array([i, 0, 0, i + 1, 1, 1, i, 1, 0]) }));
    bvh.build(pieces);
    let arrays = 0;
    bvh.visitArrays(() => arrays++);
    assert.equal(arrays, 4);
    bvh.clear();
    arrays = 0;
    bvh.visitArrays(() => arrays++);
    assert.equal(arrays, 0);
  });
});
