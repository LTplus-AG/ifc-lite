/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #11373: with GPU-driven instancing on, the pool's draw groups held every
// template's positions, normals and indices (for the byte-identical geometry
// compare), so a CPU geometry release freed none of them. The release must
// reach the pool, as #11368 made it reach the placement cache.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import { Scene } from './scene.js';

const host = globalThis as Record<string, unknown>;
host.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
host.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;

function device(): GPUDevice {
  return {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, getMappedRange: () => new ArrayBuffer(size), unmap() {}, destroy() {} }),
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createShaderModule: () => ({}), createComputePipeline: () => ({}),
    createBindGroup: () => ({}), pushErrorScope() {}, popErrorScope: async () => null,
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: { submit() {}, writeBuffer() {} },
  } as unknown as GPUDevice;
}

function shard(): DecodedInstancedShard {
  return {
    templates: [{
      expressId: 0, color: [0.2, 0.3, 0.4, 1], origin: [0, 0, 0],
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    }],
    instances: [1, 2].map((i) => ({ templateIndex: 0, entityId: 40 + i, color: [0.4, 0.5, 0.6, 1] as [number, number, number, number],
      transform: new Float32Array([1, 0, 0, i, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) })),
    carriesItemIds: false,
  } as unknown as DecodedInstancedShard;
}

/** Live arrays after full GCs; WeakRef targets survive the current job, so yield and collect up to 10 times. */
async function liveAfterGc(refs: WeakRef<object>[]): Promise<number> {
  let live = refs.length;
  for (let round = 0; round < 10 && live > 0; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    live = refs.filter((ref) => ref.deref() !== undefined).length;
  }
  return live;
}

function load(scene: Scene): WeakRef<object>[] {
  const s = shard();
  const t = s.templates[0]!;
  const refs = [new WeakRef(t.positions), new WeakRef(t.normals), new WeakRef(t.indices)];
  scene.addInstancedShard(device(), s, 0);
  return refs;
}

describe('GPU instance pool releases CPU geometry with the scene (#11373)', () => {
  it('releaseGeometryData frees the template arrays the pool grouped', async () => {
    const scene = new Scene();
    assert.equal(scene.setGpuInstancing(true), true);
    const refs = load(scene);
    assert.notEqual(scene.getGpuInstancePool(), null, 'the pool holds the template');
    scene.releaseGeometryData();
    assert.equal(await liveAfterGc(refs), 0);
    assert.equal(scene.isGeometryDataReleased(), true, 'the scene (and its pool) is still reachable here');
    assert.notEqual(scene.getGpuInstancePool(), null);
  });

  it('a template registered after the release still shares its group by hash', () => {
    const scene = new Scene();
    scene.setGpuInstancing(true);
    load(scene);
    scene.releaseGeometryData();
    const before = scene.getInstancedTemplates()[0]!.poolGroup;
    scene.addInstancedShard(device(), shard(), 0);
    const templates = scene.getInstancedTemplates();
    assert.equal(templates.length, 2);
    assert.equal(templates[1]!.poolGroup, before, 'identical geometry joins the released group');
  });
});
