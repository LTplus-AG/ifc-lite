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
  type ShadowOccluderSources,
} from './shadow-occluders.js';
import { ShadowPass } from './shadow-pass.js';
import type { BatchedMesh } from './types.js';
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

function mockShadowDevice(): GPUDevice {
  const queue = { writeBuffer() { /* no-op */ } };

  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      switch (prop) {
        case 'limits':
          return { minUniformBufferOffsetAlignment: 256 };
        case 'queue':
          return queue;
        case 'createBuffer':
          return () => ({ destroy() { /* no-op */ } });
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
          return (d: { label?: string }) => ({ label: d?.label });
        default:
          return () => undefined;
      }
    },
  }) as unknown as GPUDevice;
}

describe('ShadowPass.render', () => {
  it('draws every geometry path through its own depth pipeline', () => {
    const rec: MockRecord = { drawPipelines: [], passesBegun: 0, dynamicOffsets: [] };
    const device = mockShadowDevice();
    const pass = new ShadowPass(device, 1024);

    const draws = collectShadowOccluders(allFourPaths());
    const encoder = {
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
