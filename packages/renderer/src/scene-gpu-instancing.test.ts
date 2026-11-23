/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SceneInstancePool } from './scene-gpu-instancing.js';
import { DrawGroups, ColourPalette, FreeRanges } from './gpu-instance-groups.js';
import { INSTANCE_COLOR_OFFSET, INSTANCE_FLAG_HIDDEN, INSTANCE_FLAGS_OFFSET, INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import { GpuInstancePool } from './gpu-instance-pool.js';
import { POOL_STATE_DEAD, POOL_STATE_HIDDEN, POOL_STATE_HOVER, POOL_STATE_USER_HIDDEN } from './gpu-instance-cull.js';
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
  const cpu = { positions, normals: new Float32Array(9), indices, instanceData: new ArrayBuffer(count * INSTANCE_STRIDE_BYTES), canonicalAnchors: new Float64Array(count * 3) } as InstancedTemplateCpu;
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
  const geo = (p: number[], n: number[] = Array(9).fill(0)) => ({ vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array([0, 1, 2]) });
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

/** Pool state words as last uploaded (the fake device keeps a mirror of the state buffer). */
function stateDevice(limits?: { maxBufferSize: number; maxStorageBufferBindingSize: number }): { device: GPUDevice; state: () => Uint32Array } {
  let state = new Uint32Array(0);
  const device = {
    limits,
    createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, usage: d.usage, label: d.label, destroy() {} }), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({}), createComputePipeline: () => ({}), createBindGroup: () => ({}), pushErrorScope() {}, popErrorScope: async () => null,
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: { submit() {}, writeBuffer: (b: { label?: string; size: number }, off: number, data: Uint32Array, lo = 0, n?: number) => {
      if (b.label !== 'gpu-instance-pool-state') return;
      if (state.length * 4 < b.size) { const next = new Uint32Array(b.size / 4); next.set(state); state = next; }
      state.set(data.subarray(lo, lo + (n ?? data.length - lo)), off / 4);
    } },
  } as unknown as GPUDevice;
  return { device, state: () => state };
}

describe('GPU instance pool state', () => {
  const geometry = { vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };

  it('keeps a tombstone the CPU record holds (device-recovery rebuild)', () => {
    const { device, state } = stateDevice();
    const pool = new GpuInstancePool(device);
    const records = new ArrayBuffer(2 * INSTANCE_STRIDE_BYTES);
    new DataView(records).setUint32(INSTANCE_STRIDE_BYTES + INSTANCE_FLAGS_OFFSET, INSTANCE_FLAG_HIDDEN, true);
    pool.addTemplate(0, pool.allocate(2), geometry, records, new Float64Array(6), new Float32Array(2));
    pool.flush();
    assert.deepEqual([state()[0]! & POOL_STATE_HIDDEN, state()[1]! & POOL_STATE_HIDDEN], [0, POOL_STATE_HIDDEN]);
  });

  it('brings an occurrence back once a move returns its anchor to the envelope', () => {
    const { device, state } = stateDevice();
    const pool = new GpuInstancePool(device);
    const records = new ArrayBuffer(INSTANCE_STRIDE_BYTES);
    pool.addTemplate(0, pool.allocate(1), geometry, records, new Float64Array([2e9, 0, 0]), new Float32Array(1));
    pool.flush();
    assert.equal(state()[0]! & POOL_STATE_DEAD, POOL_STATE_DEAD);
    pool.refreshTemplate(0, records, new Float64Array([10, 0, 0]), [0]);
    pool.flush();
    assert.equal(state()[0]! & POOL_STATE_DEAD, 0);
  });

  it('drops the pool when the switch turns off', () => {
    const scene = new SceneInstancePool(); scene.setEnabled(true, false);
    scene.ensure(fakeDevice().device);
    assert.equal(scene.setEnabled(false, false), true);
    assert.equal(scene.pool, null);
  });
});

describe('GPU instance palette and groups (normals, compaction)', () => {
  it('separates templates that differ only in normals', () => {
    const groups = new DrawGroups();
    const p = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const mk = (n: number[]) => ({ vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array([0, 1, 2]) });
    assert.notEqual(groups.join(0, mk(Array(9).fill(0)), 1), groups.join(1, mk([0, 0, 1, 0, 0, 1, 0, 0, 1]), 1));
  });

  it('compacts to the colours still in use, renumbered densely', () => {
    const palette = new ColourPalette();
    const idx = [0.1, 0.2, 0.3].map((r) => palette.indexOf(new Float32Array([r, 0, 0, 1])));
    for (const i of idx) palette.retain(i);
    palette.release(idx[0]!); palette.release(idx[2]!);
    const remap = palette.compact();
    assert.equal(remap[2], 1);
    assert.equal(palette.colours.length, 8);
    assert.equal(palette.indexOf(new Float32Array([Math.fround(0.2), 0, 0, 1])), 1);
  });
});

describe('GPU instance pool review wave 2', () => {
  const geometry = { vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
  const occ = (templateIndex: number, i: number, poolIndex?: number): InstancedOccurrence => ({ templateIndex, byteOffset: i * INSTANCE_STRIDE_BYTES, originalColor: [1, 1, 1, 1], poolIndex });

  it('reuses a removed template\'s range, with fresh state, and re-applies hide to it', () => {
    const { device, state } = stateDevice();
    const scene = new SceneInstancePool(); scene.setEnabled(true, false);
    const pool = scene.ensure(device)!;
    const a = pool.allocate(4);
    pool.addTemplate(0, a, geometry, new ArrayBuffer(4 * INSTANCE_STRIDE_BYTES), new Float64Array(12), new Float32Array(4));
    pool.removeTemplate(0);
    const b = pool.allocate(4);
    assert.equal(b, a, 'the dead range is reused');
    assert.equal(pool.occurrenceCount, 4, 'no growth');
    pool.addTemplate(1, b, geometry, new ArrayBuffer(4 * INSTANCE_STRIDE_BYTES), new Float64Array(12), new Float32Array(4));
    const occurrences = new Map([[7, [occ(1, 2, b + 2)]]]);
    scene.applyVisibility(occurrences, new Set([7]), null);
    pool.flush();
    assert.equal(state()[b]! & POOL_STATE_DEAD, 0);
    assert.equal(state()[b + 2]! & POOL_STATE_USER_HIDDEN, POOL_STATE_USER_HIDDEN);
  });

  it('refuses occurrences past the device buffer limits instead of binding an oversized buffer', () => {
    const { device } = stateDevice({ maxBufferSize: 100 * INSTANCE_STRIDE_BYTES, maxStorageBufferBindingSize: 100 * INSTANCE_STRIDE_BYTES });
    const pool = new GpuInstancePool(device);
    assert.equal(pool.allocate(60), 0);
    assert.equal(pool.allocate(60), -1);
    assert.equal(pool.allocate(40), 60);
  });

  it('marks the hovered model-scoped occurrences, and clears them when hover moves', () => {
    const { device, state } = stateDevice();
    const scene = new SceneInstancePool(); scene.setEnabled(true, false);
    const pool = scene.ensure(device)!;
    pool.addTemplate(0, pool.allocate(3), geometry, new ArrayBuffer(3 * INSTANCE_STRIDE_BYTES), new Float64Array(9), new Float32Array(3));
    const locs = [occ(0, 0, 0), occ(0, 1, 1)];
    scene.setHover(locs, (loc) => loc.poolIndex === 1); // only model-matching occurrence
    pool.flush();
    assert.deepEqual([state()[0]! & POOL_STATE_HOVER, state()[1]! & POOL_STATE_HOVER], [0, POOL_STATE_HOVER]);
    scene.setHover(undefined, () => true);
    pool.flush();
    assert.equal(state()[1]! & POOL_STATE_HOVER, 0);
  });

  it('compacts a full palette only once an entry loses its last user', () => {
    const { device } = stateDevice();
    const pool = new GpuInstancePool(device);
    const n = 0xffff + 2;
    pool.addTemplate(0, pool.allocate(n), geometry, new ArrayBuffer(n * INSTANCE_STRIDE_BYTES), new Float64Array(n * 3), new Float32Array(n));
    const white = [1, 1, 1, 1] as const;
    const colour = (k: number) => new Float32Array([k / n, 0.5, 0.25, 1]);
    for (let i = 0; i < 0xffff; i++) pool.writeLane(i, INSTANCE_COLOR_OFFSET, colour(i), white);
    let compactions = 0;
    const palette = (pool as unknown as { palette: ColourPalette }).palette;
    const original = palette.compact.bind(palette);
    palette.compact = () => { compactions++; return original(); };
    const warn = console.warn; console.warn = () => {};
    try {
      pool.writeLane(0xffff, INSTANCE_COLOR_OFFSET, colour(0xffff), white); // full of live colours: no compaction
      pool.writeLane(0xffff + 1, INSTANCE_COLOR_OFFSET, colour(0xffff + 1), white);
      assert.equal(compactions, 0);
      pool.writeLane(5, INSTANCE_COLOR_OFFSET, new Float32Array(white), white); // occurrence 5 back to its own colour: its entry is free
      pool.writeLane(0xffff, INSTANCE_COLOR_OFFSET, colour(0xffff), white);
      assert.equal(compactions, 1);
    } finally { console.warn = warn; }
  });

  it('counts instanced entities, not only live GPU templates, in the switch guard (recovery)', () => {
    const scene = new SceneInstancePool();
    assert.equal(scene.setEnabled(true, true), false);
  });
});

describe('GPU instance pool free ranges', () => {
  it('merges adjacent released ranges so a larger template fits', () => {
    const free = new FreeRanges();
    free.release(8, 4); free.release(0, 4); free.release(4, 4);
    assert.equal(free.take(12), 0);
    assert.equal(free.take(1), -1);
  });
});
