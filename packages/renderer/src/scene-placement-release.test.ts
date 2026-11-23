/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `ModelTranslations.placeMesh` caches a placed copy of each source mesh, and
// that copy shares the source's typed arrays. The store keeps the source
// object alive, so while the cache entry exists, releasing the geometry in
// place (swapping the source's arrays for empty ones) frees nothing: the
// placed copy still points at the old arrays. A CPU release has to drop
// those placements: on a full release and when ephemeral streaming ends.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { ModelTranslations } from './model-translation.js';
import type { RenderPipeline } from './pipeline.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;

function gpu() {
  const device = {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, getMappedRange: () => new ArrayBuffer(size), unmap() {}, destroy() {} }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: { submit() {}, writeBuffer() {} },
  } as unknown as GPUDevice;
  const pipeline = { getUniformBufferSize: () => 512, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
  return { device, pipeline };
}

function triangle(expressId: number): MeshData {
  return { expressId, modelIndex: 0, origin: [0, 0, 0], color: [1, 1, 1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]) };
}

/** Swap the sources' arrays for empty ones, as an in-place CPU release does; return weak refs to the old arrays. */
function releaseInPlace(sources: MeshData[]): WeakRef<object>[] {
  const refs: WeakRef<object>[] = [];
  for (const source of sources) {
    refs.push(new WeakRef(source.positions), new WeakRef(source.normals), new WeakRef(source.indices));
    source.positions = new Float32Array(0); source.normals = new Float32Array(0); source.indices = new Uint32Array(0);
  }
  return refs;
}

/** Live old arrays after a full GC (WeakRef targets stay alive until the current job ends). */
async function liveAfterGc(refs: WeakRef<object>[]): Promise<number> {
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

describe('released geometry is not kept alive by placement copies', () => {
  it('releaseGeometryData drops the placed copies, so an in-place release frees the arrays', async () => {
    const scene = new Scene(), { device, pipeline } = gpu();
    const store = [triangle(1), triangle(2)]; // the sources stay alive, as the viewer store keeps them
    scene.appendToBatches(store, device, pipeline);
    scene.releaseGeometryData();
    const refs = releaseInPlace(store);
    assert.equal(await liveAfterGc(refs), 0);
    assert.equal(store.length, 2);
  });

  it('finishing ephemeral streaming drops the placed copies', async () => {
    const scene = new Scene(), { device, pipeline } = gpu();
    scene.setEphemeralStreamingMode(true);
    const store = [triangle(1), triangle(2)];
    scene.appendToBatches(store, device, pipeline, true);
    scene.finishEphemeralStreaming();
    const refs = releaseInPlace(store);
    assert.equal(await liveAfterGc(refs), 0);
    assert.equal(store.length, 2);
  });

  it('a placed copy still held after the release keeps resolving to its source, placed once', () => {
    const scene = new Scene(), { device, pipeline } = gpu();
    scene.setModelTranslation(0, [100, 0, 0]);
    const source = triangle(1);
    scene.appendToBatches([source], device, pipeline);
    const translations = (scene as unknown as { modelTranslations: ModelTranslations }).modelTranslations;
    const placed = translations.placeMesh(source); // the scene's cached copy, as a highlight or appearance part holds it
    assert.deepEqual(placed.origin, [100, 0, 0]);
    scene.releaseGeometryData();
    assert.equal(translations.sourceMesh(placed), source);
    assert.equal(translations.sourceFromPlaced(placed), source);
    assert.equal(translations.placeMesh(placed), placed, 'not re-placed as if it were a source');
    assert.deepEqual(placed.origin, [100, 0, 0]);
    assert.notEqual(translations.placeMesh(source), placed, 'the source gets a fresh placement on demand');
  });
});
