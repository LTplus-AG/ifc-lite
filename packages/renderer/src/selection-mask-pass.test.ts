/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SelectionMaskPass, type HoveredMesh, type SelectionMaskFrame } from './selection-mask-pass.js';
import type { WebGPUDevice } from './device.js';
import type { InstancedRteDeltaStream } from './instanced-rte.js';
import { INSTANCED_VERTEX_BUFFERS } from './instanced-vertex-layout.js';
import type { WorldPoint } from './relative-to-eye.js';

/**
 * GPU resource lifetime of the selection/hover mask pass (#5390 review):
 * the views object it returns must be stable per allocation (the outline
 * bind group in `edge-pass.ts` is cached by its identity), and hovering
 * must reuse ONE uniform buffer rather than allocate a buffer and bind
 * group every frame.
 */

// The fake constructs globals WebGPU would provide in a browser.
(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };

function fakeDevice() {
  const stats = {
    buffers: [] as { size: number; destroyed: boolean }[], bindGroups: 0, writes: 0, textures: 0,
    passes: [] as { view: unknown; loadOp: string }[],
  };
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, end() {} };
  const gpu = {
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({}),
    createTexture: (desc: { label?: string }) => { stats.textures++; return { createView: () => ({ label: desc.label }), destroy() {} }; },
    createBuffer: (desc: { size: number }) => {
      const b = { size: desc.size, destroyed: false, destroy() { b.destroyed = true; } };
      stats.buffers.push(b);
      return b;
    },
    createBindGroup: () => { stats.bindGroups++; return {}; },
    queue: { writeBuffer: () => { stats.writes++; } },
  };
  const device = { getDevice: () => gpu } as unknown as WebGPUDevice;
  const encoder = {
    beginRenderPass: (d: { colorAttachments: { view: unknown; loadOp: string }[] }) => {
      stats.passes.push({ view: d.colorAttachments[0]!.view, loadOp: d.colorAttachments[0]!.loadOp });
      return pass;
    },
  } as unknown as GPUCommandEncoder;
  return { device, encoder, stats };
}

function frame(encoder: GPUCommandEncoder, hovered: HoveredMesh | readonly HoveredMesh[] | null, size = 64): SelectionMaskFrame {
  const list = hovered === null ? [] : Array.isArray(hovered) ? hovered : [hovered as HoveredMesh];
  return { encoder, width: size, height: size, depthView: {} as GPUTextureView, selected: [], hovered: list };
}

const hoverMesh = (): HoveredMesh => ({
  vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, uniforms: new Float32Array(64),
});

describe('SelectionMaskPass GPU resources (#5390)', () => {
  it('returns the same views object while the targets are unchanged, a new one after a resize', () => {
    const { device, encoder } = fakeDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    const a = pass.encode(frame(encoder, hoverMesh()));
    const b = pass.encode(frame(encoder, hoverMesh()));
    assert.strictEqual(a, b, 'a fresh object per frame defeats the identity-cached outline bind group');
    const resized = pass.encode(frame(encoder, hoverMesh(), 128));
    assert.notStrictEqual(resized, a, 'new targets must invalidate the cache');
  });

  it('writes every hover frame into one owned uniform buffer and releases it on destroy', () => {
    const { device, encoder, stats } = fakeDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    for (let i = 0; i < 5; i++) pass.encode(frame(encoder, hoverMesh()));
    assert.equal(stats.buffers.length, 1, 'hovering must not allocate a uniform buffer per frame');
    assert.equal(stats.writes, 5, 'each frame writes the fresh hover uniforms');
    pass.destroy();
    assert.equal(stats.buffers[0]!.destroyed, true);
  });

  it('draws an already-bound hovered mesh without a buffer of its own', () => {
    const { device, encoder, stats } = fakeDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    pass.encode(frame(encoder, { vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, bindGroup: {} as GPUBindGroup }));
    assert.equal(stats.buffers.length, 0);
  });

  it('clears each mask target once per frame, so hover does not wipe the selection', () => {
    const { device, encoder, stats } = fakeDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    const selected = [{ vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, bindGroup: {} as GPUBindGroup }];
    pass.encode({ ...frame(encoder, hoverMesh()), selected });
    const byView = new Map<unknown, string[]>();
    for (const p of stats.passes) byView.set(p.view, [...(byView.get(p.view) ?? []), p.loadOp]);
    for (const [view, ops] of byView) {
      assert.equal(ops[0], 'clear', `${(view as { label?: string }).label}: first pass clears`);
      assert.ok(ops.slice(1).every((op) => op === 'load'), `${(view as { label?: string }).label}: later passes must load, got ${ops}`);
    }
    assert.deepEqual([...byView.values()].map((ops) => ops.length).sort(), [1, 2], 'visible gets selected + hover, all gets selected');
  });

  it('outlines every hovered piece, each with its own reused uniform buffer', () => {
    const { device, encoder, stats } = fakeDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    for (let i = 0; i < 3; i++) pass.encode(frame(encoder, [hoverMesh(), hoverMesh(), hoverMesh()]));
    assert.equal(stats.buffers.length, 3, 'one buffer per piece, allocated once and reused across frames');
    assert.equal(stats.writes, 9, 'every piece is written every frame');
    pass.destroy();
    assert.ok(stats.buffers.every((b) => b.destroyed));
  });
});

/**
 * #5745: GPU-instanced occurrences (repeated windows, doors, furniture) keep
 * their "selected" flag in the per-instance record, so the mask must draw the
 * templates with the instanced vertex stage and buffer layout, into the same
 * targets and passes as the flat meshes. These drive the real pass against a
 * recording fake device.
 */
type Call = [string, ...unknown[]];

function recordingDevice() {
  const pipelines: { label?: string; vertex: GPUVertexState }[] = [];
  const writes: { buffer: unknown; data: ArrayBufferView }[] = [];
  const buffers: { label?: string; size: number; destroyed: boolean }[] = [];
  const passes: { view: unknown; loadOp: string; calls: Call[] }[] = [];
  let current: Call[] = [];
  const pass = {
    setPipeline: (p: unknown) => current.push(['setPipeline', p]),
    setBindGroup: (i: number, g: unknown) => current.push(['setBindGroup', i, g]),
    setVertexBuffer: (slot: number, b: unknown) => current.push(['setVertexBuffer', slot, b]),
    setIndexBuffer: (b: unknown) => current.push(['setIndexBuffer', b]),
    drawIndexed: (indexCount: number, instanceCount = 1, _firstIndex = 0, _baseVertex = 0, firstInstance = 0) =>
      current.push(firstInstance === 0 ? ['drawIndexed', indexCount, instanceCount] : ['drawIndexed', indexCount, instanceCount, firstInstance]),
    end() {},
  };
  const gpu = {
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => ({ ...d }),
    createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => ({ ...d }),
    createShaderModule: (d: { label?: string }) => ({ label: d.label }),
    createRenderPipeline: (d: { label?: string; vertex: GPUVertexState }) => {
      pipelines.push(d);
      return { label: d.label };
    },
    createTexture: (desc: { label?: string }) => ({ createView: () => ({ label: desc.label }), destroy() {} }),
    createBuffer: (desc: { label?: string; size: number }) => {
      const b = { label: desc.label, size: desc.size, destroyed: false, destroy() { b.destroyed = true; } };
      buffers.push(b);
      return b;
    },
    createBindGroup: (d: unknown) => ({ desc: d }),
    queue: { writeBuffer: (buffer: unknown, _offset: number, data: ArrayBufferView) => { writes.push({ buffer, data }); } },
  };
  const device = { getDevice: () => gpu } as unknown as WebGPUDevice;
  const encoder = {
    beginRenderPass: (d: { colorAttachments: { view: unknown; loadOp: string }[] }) => {
      current = [];
      passes.push({ view: d.colorAttachments[0]!.view, loadOp: d.colorAttachments[0]!.loadOp, calls: current });
      return pass;
    },
  } as unknown as GPUCommandEncoder;
  return { device, encoder, pipelines, writes, buffers, passes };
}

function template(indexCount: number, instanceCount: number, anchors = new Float64Array(instanceCount * 3)) {
  // The delta stream belongs to the scene's template, not the mask, so it is
  // built here rather than through the recording device.
  const rteDeltas: InstancedRteDeltaStream = {
    buffer: { tag: 'rte-deltas' } as unknown as GPUBuffer, scratch: new Float32Array(instanceCount * 8), camera: null, runs: [],
  };
  return {
    vertexBuffer: { tag: 'vertex' } as unknown as GPUBuffer,
    indexBuffer: { tag: 'index' } as unknown as GPUBuffer,
    instanceBuffer: { tag: 'instances' } as unknown as GPUBuffer,
    indexCount,
    instanceCount,
    canonicalAnchors: anchors,
    rteDeltas,
  };
}

type Tpl = ReturnType<typeof template>;

/** A frame carrying #5745's `instanced` field, built via a cast so this file also loads against the pre-#5745 pass. */
function instancedFrame(
  encoder: GPUCommandEncoder,
  instanced: { selected: Tpl[]; hovered: Tpl[]; hoveredId: number },
  rteCamera: WorldPoint = [0, 0, 0],
): SelectionMaskFrame {
  return { ...frame(encoder, null), instanced: { uniforms: new Float32Array(92), rteCamera, ...instanced } } as SelectionMaskFrame;
}

const labelOf = (v: unknown) => (v as { label?: string }).label?.replace(/-msaa$/, '');
const instancedDraws = (calls: Call[]) => calls.filter((c) => c[0] === 'drawIndexed' && c[2] !== 1);
const drawsOn = (passes: { view: unknown; calls: Call[] }[], target: string) =>
  passes.filter((p) => labelOf(p.view) === target).flatMap((p) => instancedDraws(p.calls));
const instancedPipelineCount = (pipelines: { vertex: GPUVertexState }[]) =>
  pipelines.filter((p) => p.vertex.entryPoint === 'vs_instanced').length;

describe('SelectionMaskPass outlines GPU-instanced occurrences (#5745)', () => {
  it('is not empty when only an instanced occurrence is selected or hovered', () => {
    const tpl = template(6, 4);
    const only = (instanced: unknown) => ({ selected: [], hovered: [], instanced }) as unknown as SelectionMaskFrame;
    assert.equal(SelectionMaskPass.isEmpty(only({ uniforms: new Float32Array(4), selected: [tpl], hovered: [], hoveredId: 0 })), false);
    assert.equal(SelectionMaskPass.isEmpty(only({ uniforms: new Float32Array(4), selected: [], hovered: [tpl], hoveredId: 7 })), false);
    assert.equal(SelectionMaskPass.isEmpty(only(null)), true);
  });

  it('draws a selected template once per target with every instance, via vs_instanced and the instance buffer', () => {
    const { device, encoder, passes, pipelines } = recordingDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 4);
    const tpl = template(36, 12);
    pass.encode(instancedFrame(encoder, { selected: [tpl], hovered: [], hoveredId: 0 }));

    for (const target of ['selection-mask-visible', 'selection-mask-all']) {
      const calls = passes.filter((p) => labelOf(p.view) === target).flatMap((p) => p.calls);
      assert.deepEqual(instancedDraws(calls), [['drawIndexed', 36, 12]], `${target}: one draw covering all 12 occurrences`);
      assert.ok(calls.some((c) => c[0] === 'setVertexBuffer' && c[1] === 1 && c[2] === tpl.instanceBuffer), `${target}: instance records at slot 1`);
      assert.ok(calls.some((c) => c[0] === 'setVertexBuffer' && c[1] === 2 && c[2] === tpl.rteDeltas.buffer), `${target}: RTE deltas at slot 2`);
      assert.ok(calls.some((c) => c[0] === 'setVertexBuffer' && c[1] === 0 && c[2] === tpl.vertexBuffer), `${target}: template vertices at slot 0`);
      const pipelinesSet = calls.filter((c) => c[0] === 'setPipeline').map((c) => labelOf(c[1]));
      assert.ok(pipelinesSet.some((l) => l?.includes('instanced')), `${target}: drawn with an instanced mask pipeline, got ${pipelinesSet}`);
    }
    assert.equal(passes.filter((p) => labelOf(p.view) === 'selection-mask-visible').length, 1, 'nothing hovered: no hover pass');

    assert.equal(instancedPipelineCount(pipelines), 3, 'selected-visible, hover-visible and selected-all');
    for (const p of pipelines.filter((q) => q.vertex.entryPoint === 'vs_instanced')) {
      assert.equal(p.vertex.buffers, INSTANCED_VERTEX_BUFFERS, 'the layout the main instanced draw uses');
    }
  });

  it('packs the frame camera\'s deltas itself and draws only in-envelope runs, for a template the colour pass culled (#6393)', () => {
    const { device, encoder, passes, writes } = recordingDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    const far = 3_000_000;
    // Its stream holds no camera: the colour pass never uploaded it this frame.
    const tpl = template(6, 5, new Float64Array([0, 0, 0, 1, 0, 0, far, 0, 0, 2, 0, 0, 3, 0, 0]));
    const camera: WorldPoint = [0.25, 0, 0];

    pass.encode(instancedFrame(encoder, { selected: [tpl], hovered: [], hoveredId: 0 }, camera));

    const deltaWrites = () => writes.filter((w) => w.buffer === tpl.rteDeltas.buffer);
    assert.equal(deltaWrites().length, 1, 'one upload for the template, before it is drawn');
    assert.deepEqual(tpl.rteDeltas.camera, camera);
    for (const target of ['selection-mask-visible', 'selection-mask-all']) {
      assert.deepEqual(drawsOn(passes, target), [['drawIndexed', 6, 2], ['drawIndexed', 6, 2, 3]],
        `${target}: the far occurrence is not drawn with a stale delta`);
    }

    pass.encode(instancedFrame(encoder, { selected: [tpl], hovered: [tpl], hoveredId: 1 }, camera));
    assert.equal(deltaWrites().length, 1, 'the same camera again (or selected and hovered at once) is a cache hit');
  });

  it('draws the hovered id\'s templates into the visible target only, and hands the id to the fragment stage', () => {
    const { device, encoder, passes, writes } = recordingDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    pass.encode(instancedFrame(encoder, { selected: [], hovered: [template(6, 3)], hoveredId: 4242 }));
    assert.deepEqual(drawsOn(passes, 'selection-mask-visible'), [['drawIndexed', 6, 3]], 'hover outline: visible portion only');
    assert.deepEqual(drawsOn(passes, 'selection-mask-all'), [], 'hover never draws through occluders');
    assert.ok(writes.some((w) => w.data instanceof Uint32Array && w.data[0] === 4242), 'the hovered entity id reaches a uniform');
  });

  it('keeps hover from clearing the instanced selection it shares the visible target with', () => {
    const { device, encoder, passes } = recordingDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    pass.encode(instancedFrame(encoder, { selected: [template(6, 2)], hovered: [template(6, 2)], hoveredId: 1 }));
    const visible = passes.filter((p) => labelOf(p.view) === 'selection-mask-visible');
    assert.deepEqual(visible.map((p) => p.loadOp), ['clear', 'load']);
    assert.ok(visible.every((p) => instancedDraws(p.calls).length === 1), 'selected, then hovered, each drawn');
  });

  it('builds the instanced pipelines once, only when an instanced frame arrives, and frees their buffers', () => {
    const { device, encoder, pipelines, buffers } = recordingDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    const flat = { vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, bindGroup: {} as GPUBindGroup };
    pass.encode({ ...frame(encoder, null), selected: [flat] });
    assert.equal(instancedPipelineCount(pipelines), 0, 'a session with no instanced selection pays nothing');
    for (let i = 0; i < 3; i++) pass.encode(instancedFrame(encoder, { selected: [template(6, 2)], hovered: [], hoveredId: 0 }));
    assert.equal(instancedPipelineCount(pipelines), 3);
    assert.ok(buffers.length > 0, 'the instanced mask owns its uniforms');
    pass.destroy();
    assert.ok(buffers.every((b) => b.destroyed), 'destroy releases them');
  });
});

