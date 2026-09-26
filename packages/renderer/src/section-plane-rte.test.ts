/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MathUtils } from './math.js';
import { RelativeToEyeFrame, rteRelativePositionF32 } from './relative-to-eye.js';
import { Section2DOverlayRenderer } from './section-2d-overlay.js';
import {
  SECTION_PLANE_UNIFORM_SLOTS,
  SectionPlaneRenderer,
} from './section-plane.js';
import { SECTION_2D_UNIFORM_SLOT_COUNT, SECTION_2D_UNIFORM_SLOTS } from './shaders/section-2d-overlay.wgsl.js';

// Node has no WebGPU globals; the renderers only use these numeric flags when
// allocating their buffers in this production-path packing test.
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64,
};

interface Write { size: number; data: Float32Array }

function fakeDevice(): { device: GPUDevice; writes: Write[] } {
  const writes: Write[] = [];
  const device = {
    limits: { minUniformBufferOffsetAlignment: 256 },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: ({ size }: { size: number }) => ({ size, destroy() {} }),
    queue: {
      writeBuffer: (buffer: { size: number }, _offset: number, data: ArrayBufferView) => {
        writes.push({
          size: buffer.size,
          data: new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
        });
      },
    },
  } as unknown as GPUDevice;
  return { device, writes };
}

const PASS = {
  setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, draw() {}, drawIndexed() {},
} as unknown as GPURenderPassEncoder;

function lastWrite(writes: Write[], size: number): Float32Array {
  const write = [...writes].reverse().find((candidate) => candidate.size === size);
  assert.ok(write, `expected a ${size}-byte GPU write`);
  return write.data;
}

describe('section preview and cap use the same f64 RTE plane at survey coordinates (#5049)', () => {
  it('retains centimetre plane position through both production renderers', () => {
    const eye = [5_000_000, -3_000_000, 2_000_000] as const;
    const frame = new RelativeToEyeFrame();
    frame.update(
      { x: eye[0], y: eye[1], z: eye[2] },
      MathUtils.identity(),
      MathUtils.identity(),
    );
    // The slider's midpoint lies one centimetre above the eye. Direct f32
    // absolute upload turns both values into -3,000,000.
    const planeY = -2_999_999.99;
    assert.equal(Math.fround(planeY), Math.fround(eye[1]), 'the legacy world-f32 path collapses the cut');
    const bounds = {
      min: { x: 4_999_999.98, y: -3_000_000.01, z: 1_999_999.98 },
      max: { x: 5_000_000.02, y: -2_999_999.97, z: 2_000_000.02 },
    };

    const previewGpu = fakeDevice();
    const preview = new SectionPlaneRenderer(previewGpu.device, 'bgra8unorm' as GPUTextureFormat);
    preview.draw(PASS, { axis: 'down', position: 50, bounds, isPreview: true, relativeToEyeFrame: frame });
    const previewVertices = lastWrite(previewGpu.writes, 120);
    const previewUniforms = lastWrite(previewGpu.writes, 112);
    const previewPosition = rteRelativePositionF32(
      [previewVertices[0], previewVertices[1], previewVertices[2]],
      previewUniforms.subarray(SECTION_PLANE_UNIFORM_SLOTS.drawableDelta),
    );
    assert.ok(Math.abs(previewPosition[1] - 0.01) < 1e-7, `preview plane lost its cm residual: ${previewPosition[1]}`);

    const capGpu = fakeDevice();
    const cap = new Section2DOverlayRenderer(capGpu.device, 'bgra8unorm' as GPUTextureFormat);
    // A real section-cutter result: 2D cardinal coordinates retain their
    // source-world X/Z values, so this catches an anchor that only carries Y.
    cap.uploadDrawing([{
      polygon: {
        outer: [
          { x: 4_999_999.99, y: 1_999_999.99 },
          { x: 5_000_000.01, y: 1_999_999.99 },
          { x: 5_000_000.01, y: 2_000_000.01 },
        ], holes: [],
      }, ifcType: 'IfcWall', expressId: 1,
    }], [], 'down', planeY);
    cap.draw(PASS, {
      axis: 'down', position: 50, bounds, viewProj: new Float32Array(16),
      rteViewProj: frame.getViewProjection().m, rteCamera: frame.getCameraWorld(),
      showFills: true,
      capStyle: {
        fillColor: [1, 1, 1, 1], strokeColor: [0, 0, 0, 1], patternId: 0,
        spacingPx: 8, angleRad: 0, widthPx: 1, secondaryAngleRad: 0,
      },
    });
    const capUniforms = lastWrite(capGpu.writes, 256 * SECTION_2D_UNIFORM_SLOT_COUNT);
    const capPosition = rteRelativePositionF32(
      [0, 0, 0],
      capUniforms.subarray(SECTION_2D_UNIFORM_SLOTS.originDeltaHigh),
    );
    assert.ok(Math.abs(capPosition[1] - previewPosition[1]) < 1e-7, 'cap and preview must share the plane position');
    assert.ok(Math.abs(capPosition[0] + 0.01) < 1e-7, 'cap anchor retains its centimetre in-plane X residual');
  });

  it('preserves the legacy preview for callers that only supply a world-space viewProj (#5152)', () => {
    const gpu = fakeDevice();
    const preview = new SectionPlaneRenderer(gpu.device, 'bgra8unorm' as GPUTextureFormat);
    const draws: number[] = [];
    const pass = {
      setPipeline() {}, setBindGroup() {}, setVertexBuffer() {},
      draw(vertexCount: number) { draws.push(vertexCount); },
    } as unknown as GPURenderPassEncoder;
    const viewProj = new Float32Array(MathUtils.identity().m);
    const bounds = { min: { x: -2, y: 0, z: -3 }, max: { x: 4, y: 10, z: 5 } };

    preview.draw(pass, { axis: 'down', position: 50, bounds, isPreview: true, viewProj });

    assert.deepEqual(draws, [6], 'an optional RTE frame must not suppress an otherwise valid legacy preview');
    const vertices = lastWrite(gpu.writes, 120);
    const uniforms = lastWrite(gpu.writes, 112);
    assert.equal(vertices[1], 5, 'legacy vertices remain in world space for the legacy matrix');
    assert.deepEqual(Array.from(uniforms.slice(0, 16)), [...viewProj], 'legacy matrix occupies the RTE frame slot');
    assert.deepEqual(Array.from(uniforms.slice(SECTION_PLANE_UNIFORM_SLOTS.drawableDelta)), new Array(8).fill(0),
      'legacy world vertices use a zero drawable delta');
  });

  it('skips, rather than throws for, a preview and cap outside the eye envelope (#6128)', () => {
    const frame = new RelativeToEyeFrame();
    frame.update({ x: 0, y: 0, z: 0 }, MathUtils.identity(), MathUtils.identity());
    const bounds = {
      min: { x: 2_999_999, y: -1, z: -1 },
      max: { x: 3_000_001, y: 1, z: 1 },
    };
    const draws: string[] = [];
    const pass = {
      setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {},
      draw() { draws.push('draw'); }, drawIndexed() { draws.push('drawIndexed'); },
    } as unknown as GPURenderPassEncoder;

    const previewGpu = fakeDevice();
    const preview = new SectionPlaneRenderer(previewGpu.device, 'bgra8unorm' as GPUTextureFormat);
    preview.draw(pass, { axis: 'down', position: 50, bounds, isPreview: true, relativeToEyeFrame: frame });
    assert.ok(!previewGpu.writes.some((write) => write.size === 112), 'no preview uniform is uploaded');

    const capGpu = fakeDevice();
    const cap = new Section2DOverlayRenderer(capGpu.device, 'bgra8unorm' as GPUTextureFormat);
    cap.uploadDrawing([{
      polygon: {
        outer: [{ x: 3_000_000, y: 0 }, { x: 3_000_001, y: 0 }, { x: 3_000_001, y: 1 }], holes: [],
      }, ifcType: 'IfcWall', expressId: 1,
    }], [], 'down', 0);
    cap.draw(pass, {
      axis: 'down', position: 50, bounds, viewProj: new Float32Array(16),
      rteViewProj: frame.getViewProjection().m, rteCamera: frame.getCameraWorld(),
      showFills: true,
      capStyle: {
        fillColor: [1, 1, 1, 1], strokeColor: [0, 0, 0, 1], patternId: 0,
        spacingPx: 8, angleRad: 0, widthPx: 1, secondaryAngleRad: 0,
      },
    });
    assert.deepEqual(draws, [], 'neither the preview nor the cap is drawn with an unwritten delta');
  });
});
