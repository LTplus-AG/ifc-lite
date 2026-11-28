/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The placement cache holds one entry per loaded mesh. As WeakMap entries (ephemerons) they made every full
// garbage collection slower with each model loaded: at four 275k-mesh models, most of each collection was
// ephemeron marking, and each later federation slot loaded slower than the one before. The regression guard
// below counts WeakMap writes while a scene uploads an unmoved model: they must not grow with its mesh count.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { MeshPlacementCache } from './mesh-placement-cache.js';
import { ModelTranslations } from './model-translation.js';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';

(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

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

function triangle(expressId: number, x = 0): MeshData {
  return { expressId, modelIndex: 0, origin: [x, 0, 0], color: [1, 1, 1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]) };
}

/** WeakMap writes made while `run` runs. */
function weakMapWrites(run: () => void): number {
  const original = WeakMap.prototype.set;
  let writes = 0;
  WeakMap.prototype.set = function (this: WeakMap<WeakKey, unknown>, key: WeakKey, value: unknown) { writes++; return original.call(this, key, value); };
  try { run(); } finally { WeakMap.prototype.set = original; }
  return writes;
}

describe('MeshPlacementCache keeps no per-mesh WeakMap entries', () => {
  it('uploading an unmoved model makes WeakMap writes independent of its mesh count', () => {
    const writesFor = (count: number) => {
      const scene = new Scene(), { device, pipeline } = gpu();
      const meshes = Array.from({ length: count }, (_, i) => triangle(i + 1, i));
      return weakMapWrites(() => scene.appendToBatches(meshes, device, pipeline));
    };
    const small = writesFor(50), large = writesFor(2000);
    assert.ok(large - small < 50, `WeakMap writes grow with the mesh count: ${small} for 50 meshes, ${large} for 2000`);
  });

  it('placing meshes writes no WeakMap entry', () => {
    const translations = new ModelTranslations();
    const sources = Array.from({ length: 100 }, (_, i) => triangle(i + 1));
    assert.equal(weakMapWrites(() => { for (const source of sources) translations.placeMesh(source); }), 0);
  });
});

describe('MeshPlacementCache identity', () => {
  it('returns the same placed copy while it is held, and the copy resolves to its source', () => {
    const translations = new ModelTranslations();
    const source = triangle(1);
    const placed = translations.placeMesh(source);
    assert.notEqual(placed, source, 'a copy, so moving the model never rewrites the source');
    assert.equal(placed.positions, source.positions, 'sharing the source arrays');
    assert.equal(translations.placeMesh(source), placed);
    assert.equal(translations.placeMesh(placed), placed, 'a placed copy is not placed again');
    assert.equal(translations.sourceMesh(placed), source);
    assert.equal(translations.sourceFromPlaced(placed), source);
  });

  it('moves the held copy in place when the model moves', () => {
    const translations = new ModelTranslations();
    const source = triangle(1);
    const placed = translations.placeMesh(source);
    translations.set(0, [5, 0, 0]);
    assert.equal(translations.placeMesh(source), placed);
    assert.deepEqual(placed.origin, [5, 0, 0]);
    assert.deepEqual(source.origin, [0, 0, 0], 'the source keeps its coordinates');
  });

  it('gives a source a fresh placement after forgetSources, while a held copy keeps its source', () => {
    const cache = new MeshPlacementCache();
    const source = triangle(1), placed = { ...source };
    cache.set({ source, placed });
    cache.forgetSources();
    assert.equal(cache.get(source), undefined);
    assert.equal(cache.get(placed)?.source, source);
  });

  it('does not link a copy of a linked mesh, whether spread or copied with every own property', () => {
    const cache = new MeshPlacementCache();
    const source = triangle(1), placed = { ...source };
    cache.set({ source, placed });
    const spread = { ...source };
    const full = Object.defineProperties({}, Object.getOwnPropertyDescriptors(source)) as MeshData;
    assert.equal(cache.get(spread), undefined);
    assert.equal(cache.get(full), undefined, 'a compact shell copy duplicates the link property: its owner is not the copy');
    assert.equal(Object.keys(source).some((key) => key.includes('Placement')), false, 'the link is not enumerable');
  });

  it('keeps the placements of two caches (two scenes) on one mesh apart', () => {
    const a = new MeshPlacementCache(), b = new MeshPlacementCache();
    const source = triangle(1), placedA = { ...source }, placedB = { ...source };
    a.set({ source, placed: placedA });
    b.set({ source, placed: placedB });
    assert.equal(a.get(source)?.placed, placedA);
    assert.equal(b.get(source)?.placed, placedB);
    a.forgetSources();
    assert.equal(a.get(source), undefined);
    assert.equal(b.get(source)?.placed, placedB);
  });

  it('falls back for frozen meshes', () => {
    const cache = new MeshPlacementCache();
    const source = Object.freeze(triangle(1)), placed = Object.freeze({ ...triangle(1) });
    cache.set({ source, placed });
    assert.equal(cache.get(source)?.placed, placed);
    assert.equal(cache.get(placed)?.source, source);
    cache.forgetSources();
    assert.equal(cache.get(source), undefined);
  });
});
