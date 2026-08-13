/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Scene.clearFlatGeometry()` (#2073): resets flat/batched geometry state
 * exactly like `clear()` used to, but WITHOUT touching GPU-instanced
 * templates. `clear()` itself is refactored to call
 * `destroyAllInstancedTemplates()` + `clearFlatGeometry()`, so `clear()`'s
 * full-reset behaviour must be unchanged — that's the regression guard here.
 *
 * `useGeometryStreaming.ts` calls `clearFlatGeometry()` instead of `clear()`
 * on any reshape where at least one model is still present, then reconciles
 * instanced ownership with `removeInstancedTemplatesForModel` for models
 * that are NOT — see `scene-instanced-model-scope.test.ts` for that API's
 * own coverage. This file only pins `clearFlatGeometry()`'s own contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { Mesh } from './types.js';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

function fakeBuffer(): GPUBuffer & { destroyed: number } {
  const buf = {
    size: 0,
    destroyed: 0,
    destroy() { this.destroyed++; },
  };
  return buf as unknown as GPUBuffer & { destroyed: number };
}

function fakeMesh(expressId: number): Mesh & {
  vertexBuffer: GPUBuffer & { destroyed: number };
  indexBuffer: GPUBuffer & { destroyed: number };
} {
  return {
    expressId,
    vertexBuffer: fakeBuffer(),
    indexBuffer: fakeBuffer(),
    indexCount: 3,
    transform: { m: new Float32Array(16) } as unknown as Mesh['transform'],
    color: [0, 0, 0, 1],
    hydrated: true,
  } as Mesh & {
    vertexBuffer: GPUBuffer & { destroyed: number };
    indexBuffer: GPUBuffer & { destroyed: number };
  };
}

function fakeDevice(): { device: GPUDevice; created: Array<GPUBuffer & { destroyed: number }> } {
  const created: Array<GPUBuffer & { destroyed: number }> = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: { size: number }) => {
      const backing = new ArrayBuffer(desc.size);
      const buf = {
        size: desc.size,
        destroyed: 0,
        getMappedRange: () => backing,
        unmap() {},
        destroy() { this.destroyed++; },
      };
      created.push(buf as unknown as GPUBuffer & { destroyed: number });
      return buf;
    },
    queue: { writeBuffer: () => {} },
  };
  return { device: device as unknown as GPUDevice, created };
}

/** One template, one occurrence, entityId `eid`. */
function singleOccShard(eid: number): DecodedInstancedShard {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2]);
  return {
    templates: [{ positions, normals, indices, origin: [0, 0, 0] }],
    instances: [{
      templateIndex: 0,
      entityId: eid,
      color: [1, 1, 1, 1],
      transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    }],
  };
}

describe('Scene.clearFlatGeometry (#2073)', () => {
  it('destroys flat mesh buffers and resets flat bookkeeping', () => {
    const scene = new Scene();
    const m = fakeMesh(1);
    scene['meshes'] = [m];
    scene['boundingBoxes'].set(1, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } });

    scene.clearFlatGeometry();

    assert.strictEqual(m.vertexBuffer.destroyed, 1);
    assert.strictEqual(m.indexBuffer.destroyed, 1);
    assert.strictEqual(scene.getMeshes().length, 0);
    // Flat-only id: nothing keeps its box alive once the mesh is gone.
    assert.strictEqual(scene['boundingBoxes'].has(1), false);
  });

  it('leaves instanced templates fully intact — buffers NOT destroyed, still queryable', () => {
    const scene = new Scene();
    const { device, created } = fakeDevice();
    scene.addInstancedShard(device, singleOccShard(42), 3);
    assert.strictEqual(scene.getInstancedTemplates().length, 1, 'sanity: template uploaded');
    assert.deepStrictEqual(scene.getInstancedModelIndices(), [3]);

    scene.clearFlatGeometry();

    assert.strictEqual(scene.getInstancedTemplates().length, 1, 'instanced template survives clearFlatGeometry()');
    assert.deepStrictEqual(scene.getInstancedModelIndices(), [3], 'owning model unchanged');
    for (const buf of created) {
      assert.strictEqual(buf.destroyed, 0, 'clearFlatGeometry() must not destroy any instanced GPU buffer');
    }
  });

  it('keeps the bounding box of an instanced-only id, drops a flat-only id\'s box', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    scene.addInstancedShard(device, singleOccShard(42), 3);
    const instancedBoxBefore = scene['boundingBoxes'].get(42);
    assert.ok(instancedBoxBefore, 'sanity: addInstancedShard folded a world AABB for id 42');

    const flatMesh = fakeMesh(1);
    scene['meshes'] = [flatMesh];
    scene['boundingBoxes'].set(1, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } });

    scene.clearFlatGeometry();

    assert.strictEqual(scene['boundingBoxes'].has(1), false, 'flat-only id: box dropped with its mesh');
    assert.deepStrictEqual(
      scene['boundingBoxes'].get(42),
      instancedBoxBefore,
      'instanced-only id: box survives — raycast/measure must keep working for retained geometry',
    );
  });

  it('clear() still destroys instanced templates too (regression guard on the clearFlatGeometry refactor)', () => {
    const scene = new Scene();
    const { device, created } = fakeDevice();
    scene.addInstancedShard(device, singleOccShard(42), 3);
    assert.strictEqual(scene.getInstancedTemplates().length, 1);

    scene.clear();

    assert.strictEqual(scene.getInstancedTemplates().length, 0, 'clear() remains a FULL reset');
    assert.deepStrictEqual(scene.getInstancedModelIndices(), []);
    for (const buf of created) {
      assert.strictEqual(buf.destroyed, 1, 'clear() destroys every instanced GPU buffer exactly once');
    }
  });
});
