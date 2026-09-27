/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6128 — the shadow pre-pass is the one site that keeps a per-draw skip flag
 * and a separate instance-run list in parallel. Pin that a far flat occluder
 * is skipped, a mixed instanced occluder draws only its in-envelope runs, and
 * an instanced draw without canonical anchors still draws every instance.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MathUtils } from './math.js';
import { ShadowPass } from './shadow-pass.js';
import type { ShadowOccluderDraw } from './shadow-types.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, VERTEX: 32, UNIFORM: 64 };
(globalThis as Record<string, unknown>).GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };

type Draw = { vertexBuffer: unknown; args: number[] };

const device = {
  limits: { minUniformBufferOffsetAlignment: 256 },
  queue: { writeBuffer() {} },
  createBuffer: () => ({ destroy() {} }),
  createTexture: () => ({ createView: () => ({}), destroy() {} }),
  createBindGroupLayout: () => ({}),
  createBindGroup: () => ({}),
  createShaderModule: () => ({}),
  createPipelineLayout: () => ({}),
  createRenderPipeline: () => ({}),
} as unknown as GPUDevice;

/** A render pass that records each indexed draw against its slot-0 vertex buffer. */
function recordingEncoder(): { encoder: GPUCommandEncoder; draws: Draw[] } {
  const draws: Draw[] = [];
  let bound: unknown = null;
  const pass = {
    setPipeline() {}, setBindGroup() {}, setIndexBuffer() {}, end() {},
    setVertexBuffer(slot: number, buffer: unknown) { if (slot === 0) bound = buffer; },
    drawIndexed(...args: number[]) { draws.push({ vertexBuffer: bound, args }); },
  };
  return { encoder: { beginRenderPass: () => pass } as unknown as GPUCommandEncoder, draws };
}

describe('shadow pass and the RTE eye envelope (#6128)', () => {
  it('skips far occluders and draws only in-envelope instance runs', () => {
    const shadow = new ShadowPass(device, 512);
    const near = { tag: 'near' } as unknown as GPUBuffer;
    const far = { tag: 'far' } as unknown as GPUBuffer;
    const inst = { tag: 'instanced' } as unknown as GPUBuffer;
    const legacy = { tag: 'legacy-instanced' } as unknown as GPUBuffer;
    const index = {} as GPUBuffer;
    const occluders: ShadowOccluderDraw[] = [
      { kind: 'flat', vertexBuffer: near, indexBuffer: index, indexCount: 3, origin: [10, 0, 0] },
      { kind: 'flat', vertexBuffer: far, indexBuffer: index, indexCount: 3, origin: [3_000_000, 0, 0] },
      {
        kind: 'instanced', vertexBuffer: inst, indexBuffer: index, indexCount: 6,
        instanceBuffer: {} as GPUBuffer, instanceCount: 3,
        canonicalAnchors: new Float64Array([0, 0, 0, 3_000_000, 0, 0, 5, 0, 0]),
      },
      { kind: 'instanced', vertexBuffer: legacy, indexBuffer: index, indexCount: 6, instanceBuffer: {} as GPUBuffer, instanceCount: 4 },
    ];

    const { encoder, draws } = recordingEncoder();
    shadow.render(encoder, MathUtils.identity(), occluders, null, { cameraWorld: [0, 0, 0] });

    assert.deepEqual(draws.map((d) => [(d.vertexBuffer as { tag: string }).tag, d.args]), [
      ['near', [3]],
      ['instanced', [6, 1, 0, 0, 0]],
      ['instanced', [6, 1, 0, 0, 2]],
      ['legacy-instanced', [6, 4, 0, 0, 0]],
    ]);
  });
});
