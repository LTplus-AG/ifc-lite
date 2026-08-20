/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// WebGPU global enums exist in the browser, not in Node — polyfill the bits
// ShadowPass reads at construction (mirrors the other renderer tests).
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
(globalThis as Record<string, unknown>).GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };

import {
  collectShadowOccluders,
  originModelMatrix,
  classifyBatchVisibility,
  type ShadowOccluderSources,
} from './shadow-occluders.js';
import { ShadowPass } from './shadow-pass.js';
import type { BatchedMesh, Mesh } from './types.js';
import type { InstancedTemplateGPU, TexturedMesh } from './scene.js';

/** A distinct buffer stand-in per call so occluders can be told apart. */
function buf(tag: string): GPUBuffer {
  return { label: tag } as unknown as GPUBuffer;
}

function flatBatch(id: number): BatchedMesh {
  return {
    id,
    colorKey: `c${id}`,
    vertexBuffer: buf(`flat-v${id}`),
    indexBuffer: buf(`flat-i${id}`),
    indexCount: 36,
    color: [1, 1, 1, 1],
    expressIds: [100 + id],
    origin: [1, 2, 3],
  };
}

function quantBatch(id: number): BatchedMesh {
  return {
    ...flatBatch(id),
    vertexBuffer: buf(`quant-v${id}`),
    quantized: { min: [-1, -2, -3], step: 0.001 },
  };
}

function instancedTemplate(): InstancedTemplateGPU {
  return {
    modelIndex: 0,
    vertexBuffer: buf('inst-v'),
    indexBuffer: buf('inst-i'),
    indexCount: 24,
    instanceBuffer: buf('inst-inst'),
    instanceCount: 5,
    bounds: null,
    maxOccRadius: 1,
    selectedCount: 0,
  };
}

function texturedMesh(): TexturedMesh {
  return {
    expressId: 900,
    vertexBuffer: buf('tex-v'),
    indexBuffer: buf('tex-i'),
    indexCount: 12,
    uniformBuffer: buf('tex-u'),
    texture: {} as unknown as GPUTexture,
    sampler: {} as unknown as GPUSampler,
    bindGroup: {} as unknown as GPUBindGroup,
    color: [1, 1, 1, 1],
    origin: [4, 5, 6],
  };
}

function allFourPaths(): ShadowOccluderSources {
  return {
    batches: [flatBatch(1), quantBatch(2)],
    instanced: [instancedTemplate()],
    textured: [texturedMesh()],
  };
}

describe('collectShadowOccluders', () => {
  it('emits one occluder per geometry path (the #2670 acceptance criterion)', () => {
    const draws = collectShadowOccluders(allFourPaths());
    const kinds = draws.map((d) => d.kind).sort();
    assert.deepEqual(kinds, ['flat', 'instanced', 'quantized', 'textured']);
  });

  it('carries dequant params only for the quantized path', () => {
    const draws = collectShadowOccluders(allFourPaths());
    const quant = draws.find((d) => d.kind === 'quantized');
    const flat = draws.find((d) => d.kind === 'flat');
    assert.deepEqual(quant?.quantParams, [-1, -2, -3, 0.001]);
    assert.equal(flat?.quantParams, undefined);
  });

  it('passes the instance buffer + count through for the instanced path', () => {
    const draws = collectShadowOccluders(allFourPaths());
    const inst = draws.find((d) => d.kind === 'instanced');
    assert.ok(inst?.instanceBuffer, 'instance buffer missing');
    assert.equal(inst?.instanceCount, 5);
  });

  it('skips an evicted (non-resident) batch', () => {
    const evicted: BatchedMesh = { ...flatBatch(1), gpuResident: false };
    const draws = collectShadowOccluders({ batches: [evicted], instanced: [], textured: [] });
    assert.equal(draws.length, 0);
  });

  it('skips a batch with no visible element under hide/isolate', () => {
    const draws = collectShadowOccluders(allFourPaths(), { hiddenIds: new Set([101, 102, 900]) });
    // flat id 101 and quant id 102 hidden, textured 900 hidden; instanced always casts.
    const kinds = draws.map((d) => d.kind).sort();
    assert.deepEqual(kinds, ['instanced']);
  });

  it('lets a transparent (glass) batch pass light — it does not cast', () => {
    const glass: BatchedMesh = { ...flatBatch(1), color: [0.6, 0.8, 1, 0.3] };
    const draws = collectShadowOccluders({ batches: [glass], instanced: [], textured: [] });
    assert.equal(draws.length, 0, 'glass should not cast a shadow');
  });

  it('still casts a near-opaque (>= threshold) batch', () => {
    const tinted: BatchedMesh = { ...flatBatch(1), color: [1, 1, 1, 0.95] };
    const draws = collectShadowOccluders({ batches: [tinted], instanced: [], textured: [] });
    assert.equal(draws.length, 1);
  });

  it('skips a transparent textured mesh', () => {
    const glassTex = { ...texturedMesh(), color: [1, 1, 1, 0.2] as [number, number, number, number] };
    const draws = collectShadowOccluders({ batches: [], instanced: [], textured: [glassTex] });
    assert.equal(draws.length, 0);
  });

  it('honours a custom minCastAlpha', () => {
    const semi: BatchedMesh = { ...flatBatch(1), color: [1, 1, 1, 0.6] };
    assert.equal(collectShadowOccluders({ batches: [semi], instanced: [], textured: [] }).length, 0);
    assert.equal(
      collectShadowOccluders({ batches: [semi], instanced: [], textured: [] }, undefined, { minCastAlpha: 0.5 }).length,
      1,
      'a lower floor lets the semi-transparent batch cast',
    );
  });

  it('builds an origin-translation model matrix', () => {
    const m = originModelMatrix([7, 8, 9]);
    assert.equal(m[12], 7);
    assert.equal(m[13], 8);
    assert.equal(m[14], 9);
    assert.equal(m[0], 1);
    assert.equal(m[5], 1);
    assert.equal(m[10], 1);
    assert.equal(m[15], 1);
  });

  it('casts individual meshes (the addMesh / no-batch fallback path)', () => {
    const mesh = {
      expressId: 500,
      vertexBuffer: buf('mesh-v'),
      indexBuffer: buf('mesh-i'),
      indexCount: 18,
      transform: { m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]) },
      color: [1, 1, 1, 1] as [number, number, number, number],
    } as unknown as Mesh;
    const draws = collectShadowOccluders({ batches: [], instanced: [], textured: [], meshes: [mesh] });
    assert.equal(draws.length, 1);
    assert.equal(draws[0].kind, 'flat');
    // the mesh's full transform is the model matrix (translation carried)
    assert.equal(draws[0].model?.[12], 2);
    assert.equal(draws[0].model?.[14], 4);
  });

  it('skips a hydrated mesh (selection copy) so it does not double-cast', () => {
    const hydrated = {
      expressId: 500,
      vertexBuffer: buf('h-v'),
      indexBuffer: buf('h-i'),
      indexCount: 18,
      transform: { m: new Float32Array(16) },
      color: [1, 1, 1, 1] as [number, number, number, number],
      hydrated: true,
    } as unknown as Mesh;
    const draws = collectShadowOccluders({ batches: [], instanced: [], textured: [], meshes: [hydrated] });
    assert.equal(draws.length, 0);
  });

  it('skips a transparent individual mesh (glass)', () => {
    const glass = {
      expressId: 500,
      vertexBuffer: buf('g-v'),
      indexBuffer: buf('g-i'),
      indexCount: 18,
      transform: { m: new Float32Array(16) },
      color: [0.6, 0.8, 1, 0.3] as [number, number, number, number],
    } as unknown as Mesh;
    const draws = collectShadowOccluders({ batches: [], instanced: [], textured: [], meshes: [glass] });
    assert.equal(draws.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Drive the REAL ShadowPass with a mock GPU device, asserting every path
// issues a depth draw through its own pipeline — the boundary-level half of
// the acceptance criterion (collection alone can't prove the pass draws them).
// ---------------------------------------------------------------------------

interface MockRecord {
  drawPipelines: string[]; // pipeline label per drawIndexed, in order
  passesBegun: number;
  dynamicOffsets: number[];
}

/** What a device saw built/written, for the clipping assertions. */
interface DeviceRecord {
  pipelines: { label: string; hasFragment: boolean; buffers?: readonly GPUVertexBufferLayout[] }[];
  /** Last data written to the buffer labelled 'shadow-clip-uniform'. */
  clipWrite: Float32Array | null;
}

function mockShadowDevice(rec?: DeviceRecord): GPUDevice {
  const queue = {
    writeBuffer(buffer: { label?: string }, _offset: number, data: ArrayBufferView) {
      if (rec && buffer?.label === 'shadow-clip-uniform') {
        rec.clipWrite = new Float32Array(
          (data as Float32Array).slice() as unknown as ArrayLike<number>,
        );
      }
    },
  };

  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      switch (prop) {
        case 'limits':
          return { minUniformBufferOffsetAlignment: 256 };
        case 'queue':
          return queue;
        case 'createBuffer':
          return (d: { label?: string }) => ({ label: d?.label, destroy() { /* no-op */ } });
        case 'createTexture':
          return () => ({ createView: () => ({}), destroy() { /* no-op */ } });
        case 'createSampler':
          return () => ({});
        case 'createBindGroupLayout':
          return () => ({});
        case 'createBindGroup':
          return () => ({});
        case 'createShaderModule':
          return () => ({});
        case 'createPipelineLayout':
          return () => ({});
        case 'createRenderPipeline':
          return (d: { label?: string; fragment?: unknown; vertex?: { buffers?: readonly GPUVertexBufferLayout[] } }) => {
            rec?.pipelines.push({
              label: d?.label ?? '',
              hasFragment: d?.fragment != null,
              buffers: d?.vertex?.buffers,
            });
            return { label: d?.label };
          };
        default:
          return () => undefined;
      }
    },
  }) as unknown as GPUDevice;
}

function mockEncoder(rec: MockRecord): GPUCommandEncoder {
  return {
    beginRenderPass: () => {
      rec.passesBegun++;
      return new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
          switch (prop) {
            case 'setPipeline':
              return (p: { label?: string }) => { (rec as unknown as { _cur: string })._cur = p?.label ?? ''; };
            case 'drawIndexed':
              return () => { rec.drawPipelines.push((rec as unknown as { _cur: string })._cur); };
            case 'setBindGroup':
              return (_i: number, _bg: unknown, offsets?: number[]) => {
                if (offsets) rec.dynamicOffsets.push(...offsets);
              };
            default:
              return () => undefined;
          }
        },
      });
    },
  } as unknown as GPUCommandEncoder;
}

function emptyRecord(): MockRecord {
  return { drawPipelines: [], passesBegun: 0, dynamicOffsets: [] };
}

describe('ShadowPass.render', () => {
  it('draws every geometry path through its own depth pipeline', () => {
    const rec = emptyRecord();
    const device = mockShadowDevice();
    const pass = new ShadowPass(device, 1024);

    const draws = collectShadowOccluders(allFourPaths());
    const encoder = mockEncoder(rec);

    pass.render(encoder, { m: new Float32Array(16) }, draws);

    assert.equal(rec.passesBegun, 1, 'exactly one depth pass');
    assert.equal(rec.drawPipelines.length, 4, 'one draw per path');
    const labels = rec.drawPipelines.slice().sort();
    assert.deepEqual(labels, [
      'shadow-pipeline-vs_shadow_flat',
      'shadow-pipeline-vs_shadow_instanced',
      'shadow-pipeline-vs_shadow_quantized',
      'shadow-pipeline-vs_shadow_textured',
    ]);
    // Each draw binds a distinct 256-aligned dynamic offset.
    assert.deepEqual(rec.dynamicOffsets, [0, 256, 512, 768]);
  });
});

// ---------------------------------------------------------------------------
// Clipping: the colour pass discards section/crop-clipped fragments, so the
// shadow pass must cut the same geometry — otherwise a sliced-off roof keeps
// shadowing the floor it no longer covers (greptile review, #2670).
// ---------------------------------------------------------------------------

describe('ShadowPass clipping', () => {
  const draws = () => collectShadowOccluders(allFourPaths());
  const section = { normal: [0, 0, 1] as const, distance: 12.5 };
  const box = { min: [-1, -2, -3] as const, max: [4, 5, 6] as const };

  it('stays fragment-less (depth-only) when nothing is clipped', () => {
    const dev: DeviceRecord = { pipelines: [], clipWrite: null };
    const rec = emptyRecord();
    const pass = new ShadowPass(mockShadowDevice(dev), 1024);
    pass.render(mockEncoder(rec), { m: new Float32Array(16) }, draws(), null);

    assert.equal(dev.pipelines.length, 4, 'only the four depth-only pipelines');
    assert.ok(dev.pipelines.every((p) => !p.hasFragment), 'no fragment stage without a clip');
    assert.ok(rec.drawPipelines.every((l) => !l.endsWith('-clipped')));
    assert.equal(dev.clipWrite, null, 'clip uniform untouched when nothing is cut');
  });

  it('routes every path through a clipping pipeline when a section plane is on', () => {
    const dev: DeviceRecord = { pipelines: [], clipWrite: null };
    const rec = emptyRecord();
    const pass = new ShadowPass(mockShadowDevice(dev), 1024);
    pass.render(mockEncoder(rec), { m: new Float32Array(16) }, draws(), { section });

    assert.equal(rec.drawPipelines.length, 4, 'one draw per path, still');
    assert.deepEqual(rec.drawPipelines.slice().sort(), [
      'shadow-pipeline-vs_shadow_flat-clipped',
      'shadow-pipeline-vs_shadow_instanced-clipped',
      'shadow-pipeline-vs_shadow_quantized-clipped',
      'shadow-pipeline-vs_shadow_textured-clipped',
    ]);
    const clipped = dev.pipelines.filter((p) => p.label.endsWith('-clipped'));
    assert.equal(clipped.length, 4);
    assert.ok(clipped.every((p) => p.hasFragment), 'clipping pipelines discard in a fragment stage');
  });

  it('packs the section plane and its flipped bit like the colour pass', () => {
    const dev: DeviceRecord = { pipelines: [], clipWrite: null };
    const pass = new ShadowPass(mockShadowDevice(dev), 1024);
    pass.render(mockEncoder(emptyRecord()), { m: new Float32Array(16) }, draws(), { section });

    const w = dev.clipWrite!;
    assert.deepEqual(Array.from(w.slice(0, 4)), [0, 0, 1, 12.5]);
    assert.equal(new Uint32Array(w.buffer)[12], 1, 'bit 0 = section enabled');

    pass.render(mockEncoder(emptyRecord()), { m: new Float32Array(16) }, draws(), {
      section: { ...section, flipped: true },
    });
    assert.equal(new Uint32Array(dev.clipWrite!.buffer)[12], 1 | 2, 'bit 1 = flipped');
  });

  it('packs the clip box bounds and enable bit', () => {
    const dev: DeviceRecord = { pipelines: [], clipWrite: null };
    const pass = new ShadowPass(mockShadowDevice(dev), 1024);
    pass.render(mockEncoder(emptyRecord()), { m: new Float32Array(16) }, draws(), { box });

    const w = dev.clipWrite!;
    assert.deepEqual(Array.from(w.slice(4, 7)), [-1, -2, -3]);
    assert.deepEqual(Array.from(w.slice(8, 11)), [4, 5, 6]);
    assert.equal(new Uint32Array(w.buffer)[12], 4, 'bit 2 = clip box enabled');
  });

  it('builds the clipping pipelines once, on the first clipped frame', () => {
    const dev: DeviceRecord = { pipelines: [], clipWrite: null };
    const pass = new ShadowPass(mockShadowDevice(dev), 1024);
    assert.equal(dev.pipelines.length, 4, 'construction builds only the depth-only set');

    pass.render(mockEncoder(emptyRecord()), { m: new Float32Array(16) }, draws(), { box });
    assert.equal(dev.pipelines.length, 8, 'first clipped frame adds the clipping set');
    pass.render(mockEncoder(emptyRecord()), { m: new Float32Array(16) }, draws(), { box });
    assert.equal(dev.pipelines.length, 8, 'later frames reuse them');
  });
});

// ---------------------------------------------------------------------------
// Phase 2b: per-element hide/isolate must not cast a phantom shadow.
//
// Batch geometry is filtered UPSTREAM (the renderer feeds the collector the
// visible subset via classifyBatchVisibility); instanced geometry is filtered
// in the depth shader via a per-occurrence flag, which requires the instanced
// shadow pipeline to bind the flags lane. Both halves are pinned here.
// ---------------------------------------------------------------------------

describe('classifyBatchVisibility', () => {
  it('is "all" when no filter is active (both nullish and empty-hidden)', () => {
    assert.deepEqual(classifyBatchVisibility([1, 2, 3], undefined, undefined), { kind: 'all' });
    assert.deepEqual(classifyBatchVisibility([1, 2, 3], new Set(), null), { kind: 'all' });
  });

  it('is "none" when every element is hidden (a fully-hidden batch stops casting)', () => {
    assert.deepEqual(classifyBatchVisibility([1, 2], new Set([1, 2]), undefined), { kind: 'none' });
  });

  it('is "partial" with the visible subset when some elements are hidden', () => {
    const v = classifyBatchVisibility([1, 2, 3], new Set([2]), undefined);
    assert.equal(v.kind, 'partial');
    assert.deepEqual([...(v as { visibleIds: Set<number> }).visibleIds].sort(), [1, 3]);
  });

  it('treats isolate as an allowlist: an empty isolate set hides everything', () => {
    assert.deepEqual(classifyBatchVisibility([1, 2], undefined, new Set()), { kind: 'none' });
  });

  it('is "all" when the isolate set covers every element', () => {
    assert.deepEqual(classifyBatchVisibility([1, 2], undefined, new Set([1, 2])), { kind: 'all' });
  });

  it('narrows to the isolated subset when isolation is partial', () => {
    const v = classifyBatchVisibility([1, 2, 3], undefined, new Set([2, 3]));
    assert.equal(v.kind, 'partial');
    assert.deepEqual([...(v as { visibleIds: Set<number> }).visibleIds].sort(), [2, 3]);
  });

  it('lets hiding win over isolation (an isolated-but-hidden element is excluded)', () => {
    const v = classifyBatchVisibility([1, 2], new Set([1]), new Set([1, 2]));
    assert.equal(v.kind, 'partial');
    assert.deepEqual([...(v as { visibleIds: Set<number> }).visibleIds], [2]);
  });
});

describe('ShadowPass instanced pipeline', () => {
  it('binds the per-occurrence flags lane so a hidden instance can be culled in-shader', () => {
    const dev: DeviceRecord = { pipelines: [], clipWrite: null };
    new ShadowPass(mockShadowDevice(dev), 1024);

    const inst = dev.pipelines.find((p) => p.label === 'shadow-pipeline-vs_shadow_instanced');
    assert.ok(inst, 'instanced shadow pipeline built');
    const instanceLayout = inst!.buffers?.find((b) => b.stepMode === 'instance');
    assert.ok(instanceLayout, 'slot-1 instance-step layout present');
    const flags = [...instanceLayout!.attributes].find((a) => a.shaderLocation === 9);
    assert.ok(flags, 'flags lane (shaderLocation 9) bound');
    // Offset 84 within the 88-byte INSTANCE_STRIDE_BYTES layout (mat4 + id + rgba + flags).
    assert.equal(flags!.offset, 84);
    assert.equal(flags!.format, 'uint32');
    // The mat4 columns (3..6) stay bound so the transform still arrives.
    const locs = [...instanceLayout!.attributes].map((a) => a.shaderLocation).sort((x, y) => x - y);
    assert.deepEqual(locs, [3, 4, 5, 6, 9]);
  });
});
