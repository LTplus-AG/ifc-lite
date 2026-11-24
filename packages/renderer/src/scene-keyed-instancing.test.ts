/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import type { RenderPipeline } from './pipeline.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 };

function device(maxBufferSize = 1 << 30): GPUDevice {
  return {
    limits: { maxBufferSize, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: ({ size }: GPUBufferDescriptor) => {
      const data = new ArrayBuffer(size);
      return { size, getMappedRange: () => data, unmap() {}, destroy() {} };
    },
    createBindGroup: () => ({}),
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
}

const TEMPLATE = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  origin: [0, 0, 0] as [number, number, number],
};

/** One template record (keyed when `key` is given) with occurrences at x = ids. */
function shard(ids: number[], key?: string, template = TEMPLATE): DecodedInstancedShard {
  return {
    templates: [template],
    instances: ids.map((id) => ({
      templateIndex: 0,
      entityId: id,
      color: [0.5, 0.5, 0.5, 1] as [number, number, number, number],
      transform: new Float32Array([1, 0, 0, id, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    })),
    carriesItemIds: false,
    ...(key !== undefined ? { templateKeys: [key] } : {}),
  };
}

function keyedScene(): Scene {
  const scene = new Scene();
  scene.setKeyedInstancing(true);
  return scene;
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
const minX = (scene: Scene, id: number) => scene.getInstancedEntityBounds(id)?.min.x;
type Cpu = { instanceData: ArrayBuffer; canonicalAnchors: Float64Array };
const cpuOf = (scene: Scene) => (scene['instancedTemplateCpu'] as (Cpu | undefined)[]).filter((c): c is Cpu => !!c);

describe('keyed instanced shards (global instance plan)', () => {
  it('joins records of one key into one template and one draw across shards, growing past capacity', () => {
    const scene = keyedScene(), gpu = device();
    scene.addInstancedShard(gpu, shard(range(100, 10), '21:7'));
    scene.addInstancedShard(gpu, shard(range(200, 10), '21:7'));
    const templates = scene.getInstancedTemplates();
    assert.equal(templates.length, 1);
    assert.equal(templates[0].instanceCount, 20);
    assert.equal(templates[0].canonicalAnchors.length, 60, 'anchors are exact-length while the slot is open');
    for (const id of [...range(100, 10), ...range(200, 10)]) assert.equal(minX(scene, id), id, `#${id} is placed`);
  });

  it('keeps unkeyed records, other keys and other models apart', () => {
    const scene = keyedScene(), gpu = device();
    scene.addInstancedShard(gpu, shard([1, 2], '21:7'));
    scene.addInstancedShard(gpu, shard([3, 4], '21:8'));
    scene.addInstancedShard(gpu, shard([5, 6]));
    scene.addInstancedShard(gpu, shard([7, 8]));
    scene.addInstancedShard(gpu, shard([9, 10], '21:7'), 1);
    scene.addInstancedShard(gpu, shard([11], '21:7'));
    assert.deepEqual(scene.getInstancedTemplates().map((t) => t.instanceCount), [3, 2, 2, 2, 2]);
  });

  it('seals a model before it moves: exact records, every occurrence moved, later records upload as before', () => {
    const scene = keyedScene(), gpu = device();
    scene.addInstancedShard(gpu, shard(range(100, 10), '21:7'));
    scene.addInstancedShard(gpu, shard(range(200, 10), '21:7'));
    scene.setModelTranslation(0, [5, 0, 0]);
    const [cpu] = cpuOf(scene);
    assert.equal(cpu.instanceData.byteLength, 20 * INSTANCE_STRIDE_BYTES, 'sealed to the live count');
    assert.equal(cpu.canonicalAnchors.length, 60);
    assert.equal(minX(scene, 100), 105);
    assert.equal(minX(scene, 209), 214, 'an occurrence appended after the first shard moves too');
    scene.addInstancedShard(gpu, shard([300], '21:7'));
    assert.deepEqual(scene.getInstancedTemplates().map((t) => t.instanceCount), [20, 1]);
    assert.equal(minX(scene, 300), 305);
  });

  it('never opens a slot for a model away from the identity pose', () => {
    const scene = keyedScene(), gpu = device();
    scene.setModelTranslation(0, [5, 0, 0]);
    scene.addInstancedShard(gpu, shard([1], '21:7'));
    scene.addInstancedShard(gpu, shard([2], '21:7'));
    assert.equal(scene.getInstancedTemplates().length, 2);
    assert.equal(minX(scene, 2), 7);
  });

  it('seals before device recovery, so the replacement draws the live count, not the capacity', async () => {
    const scene = keyedScene(), gpu = device();
    scene.addInstancedShard(gpu, shard(range(100, 10), '21:7'));
    scene.addInstancedShard(gpu, shard(range(200, 7), '21:7'));
    assert.deepEqual(await scene.prepareDeviceRecovery(), { ok: true });
    scene.discardGpuResourcesForRecovery();
    scene.restoreGpuResourcesAfterRecovery(device(), {} as RenderPipeline);
    const templates = scene.getInstancedTemplates();
    assert.equal(templates.length, 1);
    assert.equal(templates[0].instanceCount, 17);
    assert.equal(minX(scene, 206), 206);
  });

  it('forgets a removed model\'s slots', () => {
    const scene = keyedScene(), gpu = device();
    scene.addInstancedShard(gpu, shard([1], '21:7'), 1);
    scene.removeInstancedTemplatesForModel(1);
    scene.addInstancedShard(gpu, shard([2], '21:7'), 1);
    assert.deepEqual(scene.getInstancedTemplates().map((t) => t.instanceCount), [1]);
    assert.equal(scene.keyedInstancing.openSlots, 1);
  });

  it('keeps slots open when the viewer re-syncs the pose a model already has', () => {
    const scene = keyedScene(), gpu = device();
    scene.addInstancedShard(gpu, shard([1], '21:7'));
    scene.setModelTranslation(0, [0, 0, 0]);
    scene.setModelRotation(0, 0, [0, 0, 0]);
    scene.addInstancedShard(gpu, shard([2], '21:7'));
    assert.deepEqual(scene.getInstancedTemplates().map((t) => t.instanceCount), [2]);
  });

  it('uploads a record whose geometry does not match its slot on its own', () => {
    const scene = keyedScene(), gpu = device();
    scene.addInstancedShard(gpu, shard([1], '21:7'));
    scene.addInstancedShard(gpu, shard([2], '21:7', { ...TEMPLATE, origin: [3, 0, 0] }));
    scene.addInstancedShard(gpu, shard([3], '21:7', { ...TEMPLATE, indices: new Uint32Array([0, 2, 1, 0, 1, 2]) }));
    scene.addInstancedShard(gpu, shard([4], '21:7', { ...TEMPLATE, positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]) }));
    scene.addInstancedShard(gpu, shard([5], '21:7', { ...TEMPLATE, normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1]) }));
    assert.deepEqual(scene.getInstancedTemplates().map((t) => t.instanceCount), [2, 1, 1, 1],
      'equal local geometry joins whatever its origin; other indices, positions or normals do not');
    assert.equal(minX(scene, 2), 5, 'a joined record keeps its own origin in its matrix');
  });

  it('uploads keyed records as before unless the host opts in (a cached keyed shard with the flag off)', () => {
    const scene = new Scene(), gpu = device();
    scene.addInstancedShard(gpu, shard([1], '21:7'));
    scene.addInstancedShard(gpu, shard([2], '21:7'));
    assert.deepEqual(scene.getInstancedTemplates().map((t) => t.instanceCount), [1, 1]);
  });

  it('keeps records with equal counts and bounds but different geometry apart', () => {
    const scene = keyedScene(), gpu = device();
    const quad = (x: number) => ({ ...TEMPLATE, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, x, 0.2, 0]), normals: new Float32Array(12), indices: new Uint32Array([0, 1, 2, 0, 3, 2]) });
    scene.addInstancedShard(gpu, shard([1], '21:7', quad(0.2)));
    scene.addInstancedShard(gpu, shard([2], '21:7', quad(0.7)));
    scene.addInstancedShard(gpu, shard([3], '21:7', quad(0.2)));
    assert.deepEqual(scene.getInstancedTemplates().map((t) => t.instanceCount), [2, 1], 'the 0.7 variant draws with its own geometry');
  });

  it('never grows a slot past the device buffer limit: the overflowing record uploads on its own', () => {
    const scene = keyedScene(), gpu = device(24 * INSTANCE_STRIDE_BYTES);
    scene.addInstancedShard(gpu, shard(range(100, 10), '21:7'));
    scene.addInstancedShard(gpu, shard(range(200, 10), '21:7'));
    assert.deepEqual(scene.getInstancedTemplates().map((t) => t.instanceCount), [20], 'grows to the limit, not only to a power of two');
    scene.addInstancedShard(gpu, shard(range(300, 10), '21:7'));
    assert.deepEqual(scene.getInstancedTemplates().map((t) => t.instanceCount), [20, 10]);
    assert.equal(minX(scene, 305), 305);
  });
});
