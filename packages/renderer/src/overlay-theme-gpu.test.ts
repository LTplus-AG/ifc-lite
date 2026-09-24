/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renderer.setOverlayTheme (#5484): the selection uniform and the
 * section-plane preview colour follow the theme pushed in, and the selection
 * write happens only when the theme changes — never once per frame like the
 * lighting environment uniform.
 *
 * Two test seams, matching the existing house pattern
 * (section-plane-rte.test.ts): a fake `GPUDevice` that records every
 * `queue.writeBuffer` call, driving the real `RenderPipeline` for the
 * selection uniform and the real `SectionPlaneRenderer` for the plane
 * preview. Neither needs a browser.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RenderPipeline } from './pipeline.js';
import { SectionPlaneRenderer, SECTION_PLANE_UNIFORM_SLOTS } from './section-plane.js';
import { DEFAULT_OVERLAY_THEME } from './overlay-theme.js';

// Node has no WebGPU globals; the fakes only use these numeric flags when
// allocating their buffers/textures in this production-path packing test.
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, STORAGE: 128,
};
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
};

interface Write { size: number; data: Float32Array }

/** A `GPUDevice` faithful enough to construct the real `RenderPipeline` (every
 *  `create*` call it makes in its constructor), recording every uniform write. */
function fakePipelineDevice(): { device: GPUDevice; writes: Write[] } {
  const writes: Write[] = [];
  const texture = { createView: () => ({}), destroy() {} };
  const device = {
    limits: { maxSampleCount: 1, maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 },
    createTexture: () => texture,
    createBuffer: ({ size }: { size: number }) => ({ size, destroy() {} }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: () => ({}),
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({}),
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

function lastWrite(writes: Write[], size: number): Float32Array {
  const write = [...writes].reverse().find((candidate) => candidate.size === size);
  assert.ok(write, `expected a ${size}-byte GPU write`);
  return write.data;
}

/** Minimal `WebGPUDevice`-shaped wrapper: `RenderPipeline`'s constructor only
 *  calls `.getDevice()` and `.getFormat()` on it. */
function fakeWebgpuDevice(gpu: GPUDevice) {
  return {
    getDevice: () => gpu,
    getFormat: () => 'bgra8unorm' as GPUTextureFormat,
  } as unknown as ConstructorParameters<typeof RenderPipeline>[0];
}

describe('RenderPipeline selection colour uniform (#5484)', () => {
  it('seeds the 16-byte selection buffer with DEFAULT_OVERLAY_THEME.selection at construction', () => {
    const { device, writes } = fakePipelineDevice();
    new RenderPipeline(fakeWebgpuDevice(device), 4, 4);
    assert.deepEqual([...lastWrite(writes, 16)], [...DEFAULT_OVERLAY_THEME.selection].map(Math.fround));
  });

  it('updateSelectionColor writes exactly the given RGBA into the 16-byte buffer, and only that call', () => {
    const { device, writes } = fakePipelineDevice();
    const pipeline = new RenderPipeline(fakeWebgpuDevice(device), 4, 4);
    const before = writes.filter((w) => w.size === 16).length;

    pipeline.updateSelectionColor([0.11, 0.22, 0.33, 0.44]);

    const selectionWrites = writes.filter((w) => w.size === 16);
    assert.equal(selectionWrites.length, before + 1, 'exactly one new 16-byte write, no per-frame duplication');
    assert.deepEqual([...selectionWrites.at(-1)!.data], [0.11, 0.22, 0.33, 0.44].map(Math.fround));
  });

  it('updateEnvironment (the per-frame lighting write) does not touch the 16-byte selection buffer', () => {
    const { device, writes } = fakePipelineDevice();
    const pipeline = new RenderPipeline(fakeWebgpuDevice(device), 4, 4);
    const selectionWritesAtStart = writes.filter((w) => w.size === 16).length;

    pipeline.updateEnvironment();
    pipeline.updateEnvironment();
    pipeline.updateEnvironment();

    assert.equal(
      writes.filter((w) => w.size === 16).length,
      selectionWritesAtStart,
      'three simulated frames must not add a 16-byte write — selection is theme-driven, not per-frame',
    );
  });
});

describe('SectionPlaneRenderer accent colour (#5484)', () => {
  const PASS = {
    setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {},
  } as unknown as GPURenderPassEncoder;
  const bounds = { min: { x: -2, y: 0, z: -3 }, max: { x: 4, y: 10, z: 5 } };
  const viewProj = new Float32Array(16);

  function fakeSectionPlaneDevice(): { device: GPUDevice; writes: Write[] } {
    const writes: Write[] = [];
    const device = {
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

  it('one accent tint draws for every axis alike — no more per-axis colours', () => {
    const { device, writes } = fakeSectionPlaneDevice();
    const renderer = new SectionPlaneRenderer(device, 'bgra8unorm' as GPUTextureFormat, 1);
    renderer.setPlaneColor([0.5, 0.25, 0.75, 1]);

    for (const axis of ['down', 'front', 'side'] as const) {
      renderer.draw(PASS, { axis, position: 50, bounds, isPreview: true, viewProj });
      const uniforms = lastWrite(writes, 112);
      // Float32Array.slice() stays a Float32Array; spread it into a plain array
      // so deepEqual compares against the plain-array literal below by value.
      // eslint-disable-next-line unicorn/no-useless-spread
      const rgb = [...uniforms.slice(SECTION_PLANE_UNIFORM_SLOTS.planeColor, SECTION_PLANE_UNIFORM_SLOTS.planeColor + 3)];
      assert.deepEqual(rgb, [0.5, 0.25, 0.75], `axis ${axis} must use the theme accent, not a per-axis colour`);
    }
  });

  it('a face-picked (custom normal+distance) plane also takes the theme accent, not the old violet', () => {
    const { device, writes } = fakeSectionPlaneDevice();
    const renderer = new SectionPlaneRenderer(device, 'bgra8unorm' as GPUTextureFormat, 1);
    renderer.setPlaneColor([0.5, 0.25, 0.75, 1]);

    renderer.draw(PASS, {
      axis: 'down', position: 50, bounds, isPreview: true, viewProj,
      normal: [0, 1, 0], distance: 3,
    });

    const uniforms = lastWrite(writes, 112);
    // eslint-disable-next-line unicorn/no-useless-spread -- Float32Array -> plain array for deepEqual
    const rgb = [...uniforms.slice(SECTION_PLANE_UNIFORM_SLOTS.planeColor, SECTION_PLANE_UNIFORM_SLOTS.planeColor + 3)];
    assert.deepEqual(rgb, [0.5, 0.25, 0.75]);
    // The historic custom-plane violet (#9C6BDE ~ [0.612, 0.420, 0.871]) must
    // be gone, not merely overridable.
    assert.notDeepEqual(rgb, [0.612, 0.420, 0.871]);
  });

  it('changing the theme changes the drawn colour on the next draw (no stale cache)', () => {
    const { device, writes } = fakeSectionPlaneDevice();
    const renderer = new SectionPlaneRenderer(device, 'bgra8unorm' as GPUTextureFormat, 1);

    renderer.setPlaneColor([1, 0, 0, 1]);
    renderer.draw(PASS, { axis: 'down', position: 50, bounds, isPreview: true, viewProj });
    const first = lastWrite(writes, 112).slice(SECTION_PLANE_UNIFORM_SLOTS.planeColor, SECTION_PLANE_UNIFORM_SLOTS.planeColor + 3);
    assert.deepEqual([...first], [1, 0, 0]);

    renderer.setPlaneColor([0, 1, 0, 1]);
    renderer.draw(PASS, { axis: 'down', position: 50, bounds, isPreview: true, viewProj });
    const second = lastWrite(writes, 112).slice(SECTION_PLANE_UNIFORM_SLOTS.planeColor, SECTION_PLANE_UNIFORM_SLOTS.planeColor + 3);
    assert.deepEqual([...second], [0, 1, 0]);
  });
});
