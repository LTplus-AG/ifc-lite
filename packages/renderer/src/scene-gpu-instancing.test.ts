/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SceneInstancePool } from './scene-gpu-instancing.js';
import { DrawGroups, ColourPalette } from './gpu-instance-groups.js';
import { INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import type { InstancedOccurrence, InstancedTemplateCpu, InstancedTemplateGPU } from './scene-instance-types.js';

const host = globalThis as Record<string, unknown>;
host.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 };
host.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

/** A device with no-op GPU objects: enough for the pool's CPU bookkeeping. */
function fakeDevice(): { device: GPUDevice } {
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, usage: d.usage, destroy() {} }), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({}), createComputePipeline: () => ({}), createBindGroup: () => ({}), pushErrorScope() {}, popErrorScope: async () => null,
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }), queue: { submit() {}, writeBuffer() {} },
  } as unknown as GPUDevice;
  return { device };
}

function template(count: number): { gpu: InstancedTemplateGPU; cpu: InstancedTemplateCpu } {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const gpu = { vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, instanceCount: count } as InstancedTemplateGPU;
  const cpu = { positions, indices, instanceData: new ArrayBuffer(count * INSTANCE_STRIDE_BYTES), canonicalAnchors: new Float64Array(count * 3) } as InstancedTemplateCpu;
  return { gpu, cpu };
}

describe('scene GPU instance pool', () => {
  it('stays off (no pool) until enabled', () => {
    const scene = new SceneInstancePool();
    assert.equal(scene.ensure(fakeDevice().device), null);
    assert.equal(scene.pool, null);
    assert.equal(scene.gpuBytes(), 0);
    scene.setEnabled(true, false);
    assert.notEqual(scene.ensure(fakeDevice().device), null);
  });

  it('rebuilds after device loss, re-pointing occurrences and sharing a group for identical geometry', () => {
    const scene = new SceneInstancePool(); scene.setEnabled(true, false);
    const a = template(2), b = template(3);
    const occurrences = new Map<number, InstancedOccurrence[]>([
      [10, [{ templateIndex: 0, byteOffset: INSTANCE_STRIDE_BYTES, originalColor: [1, 1, 1, 1] }]],
      [20, [{ templateIndex: 1, byteOffset: 2 * INSTANCE_STRIDE_BYTES, originalColor: [1, 1, 1, 1] }]],
    ]);
    scene.rebuild(fakeDevice().device, [a.gpu, b.gpu], [a.cpu, b.cpu], occurrences, new Map([[0, new Float32Array(2)], [1, new Float32Array(3)]]));
    assert.equal(scene.pool!.occurrenceCount, 5);
    assert.deepEqual([occurrences.get(10)![0]!.poolIndex, occurrences.get(20)![0]!.poolIndex], [1, 4]);
    assert.equal(a.gpu.poolGroup, b.gpu.poolGroup, 'byte-identical geometry shares one indirect draw');
  });

  it('applies hide/isolate only to changed ids once the occurrence set is stable', () => {
    const scene = new SceneInstancePool(); scene.setEnabled(true, false);
    const t = template(4);
    const occurrences = new Map<number, InstancedOccurrence[]>([1, 2, 3, 4].map((id, i) => [id, [{ templateIndex: 0, byteOffset: i * INSTANCE_STRIDE_BYTES, originalColor: [1, 1, 1, 1] }]]));
    const fake = fakeDevice();
    scene.rebuild(fake.device, [t.gpu], [t.cpu], occurrences, new Map([[0, new Float32Array(4)]]));
    const pool = scene.pool!;
    const bits: [number, number, boolean][] = [];
    const original = pool.setVisibilityBit.bind(pool);
    pool.setVisibilityBit = (o, bit, on) => { bits.push([o, bit, on]); original(o, bit, on); };
    scene.applyVisibility(occurrences, new Set([2]), null); // first apply after a rebuild: full
    scene.applyVisibility(occurrences, new Set([2, 3]), null);
    const second = bits.slice(1);
    assert.deepEqual(second.map(([o, , on]) => [o, on]), [[2, true]], 'only the newly hidden id is written');
    scene.applyVisibility(occurrences, new Set([3]), new Set([4]));
    assert.ok(bits.some(([o, , on]) => o === 1 && !on), 'the unhidden id is cleared');
    assert.ok(bits.some(([o, , on]) => o === 3 && on), 'the isolated id is set');
  });

  it('refuses to switch paths while instanced templates exist', () => {
    const scene = new SceneInstancePool();
    assert.equal(scene.setEnabled(true, true), false);
    assert.equal(scene.enabled, false);
    assert.equal(scene.setEnabled(true, false), true);
    assert.equal(scene.setEnabled(false, true), false, 'turning it off with pooled templates would orphan them');
    assert.equal(scene.enabled, true);
  });

  it('clears to the per-template path', () => {
    const scene = new SceneInstancePool(); scene.setEnabled(true, false);
    scene.ensure(fakeDevice().device);
    scene.clear();
    assert.equal(scene.pool, null);
  });
});

describe('GPU instance draw groups and palette', () => {
  const geo = (p: number[]) => ({ vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, positions: new Float32Array(p), indices: new Uint32Array([0, 1, 2]) });
  it('lays out one compacted region per group and drops a removed template from it', () => {
    const groups = new DrawGroups();
    const g0 = groups.join(0, geo([0, 0, 0, 1, 0, 0, 0, 1, 0]), 5);
    const g1 = groups.join(1, geo([0, 0, 0, 2, 0, 0, 0, 2, 0]), 2);
    assert.equal(groups.join(2, geo([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3), g0);
    const args = groups.layout(5);
    assert.deepEqual([groups.at(g0)!.base, groups.at(g0)!.capacity, groups.at(g1)!.base, groups.at(g1)!.capacity], [0, 8, 8, 2]);
    assert.deepEqual([args[0], args[1], args[5]], [3, 0, 3]);
    groups.leave(g0, 2);
    groups.layout(5);
    assert.deepEqual([groups.at(g0)!.capacity, groups.at(g1)!.base], [5, 5]);
  });
  it('keeps entry 0 for the record colour and reuses entries', () => {
    const palette = new ColourPalette();
    const red = new Float32Array([1, 0, 0, 1]);
    assert.equal(palette.indexOf(red), 1);
    assert.equal(palette.indexOf(new Float32Array([1, 0, 0, 1])), 1);
    assert.equal(palette.indexOf(new Float32Array([0, 1, 0, 1])), 2);
    assert.equal(palette.colours.length, 12);
  });
});
