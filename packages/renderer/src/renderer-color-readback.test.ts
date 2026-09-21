/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  cancelRendererColorFrame,
  encodeRendererColorFrameReadback,
  requestRendererColorFrame,
  resolveRendererColorFrameReadback,
} from './renderer-color-readback.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1,
  COPY_DST: 8,
};

interface FakeBuffer {
  bytes: ArrayBuffer;
  unmaps: number;
  destroys: number;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

function fakeBuffer(size: number): FakeBuffer {
  return {
    bytes: new ArrayBuffer(size),
    unmaps: 0,
    destroys: 0,
    mapAsync: async (mode) => { assert.strictEqual(mode, 1, 'GPUMapMode.READ'); },
    getMappedRange() { return this.bytes; },
    unmap() { this.unmaps++; },
    destroy() { this.destroys++; },
  };
}

describe('renderer color-frame readback (#5051 strict GPU evidence)', () => {
  it('copies a bounded centered crop with WebGPU row padding', () => {
    const buffers: FakeBuffer[] = [];
    const copies: Array<{ origin: GPUOrigin3D; layout: GPUImageDataLayout; size: GPUExtent3D }> = [];
    const device = {
      createBuffer: ({ size }: { size: number }) => {
        const buffer = fakeBuffer(size);
        buffers.push(buffer);
        return buffer;
      },
    } as unknown as GPUDevice;
    const encoder = {
      copyTextureToBuffer(
        source: { origin: GPUOrigin3D },
        destination: { bytesPerRow?: number; rowsPerImage?: number },
        size: GPUExtent3D,
      ) {
        copies.push({ origin: source.origin, layout: destination, size });
      },
    } as unknown as GPUCommandEncoder;

    encodeRendererColorFrameReadback(device, encoder, {} as GPUTexture, 1_000, 600, 'bgra8unorm');

    assert.strictEqual(buffers.length, 1);
    assert.strictEqual(buffers[0]!.bytes.byteLength, 512 * 2_048, '512 RGBA pixels are already 256-byte aligned');
    assert.deepStrictEqual(copies, [{
      origin: { x: 244, y: 44, z: 0 },
      layout: { buffer: buffers[0], bytesPerRow: 2_048, rowsPerImage: 512 },
      size: { width: 512, height: 512, depthOrArrayLayers: 1 },
    }]);
  });

  it('releases the staging buffer when encoding its texture copy throws', () => {
    let buffer: FakeBuffer | null = null;
    const device = {
      createBuffer: ({ size }: { size: number }) => {
        buffer = fakeBuffer(size);
        return buffer;
      },
    } as unknown as GPUDevice;
    const encoder = {
      copyTextureToBuffer() { throw new Error('copy rejected'); },
    } as unknown as GPUCommandEncoder;

    assert.throws(
      () => encodeRendererColorFrameReadback(device, encoder, {} as GPUTexture, 2, 2, 'rgba8unorm'),
      /copy rejected/,
    );
    assert.strictEqual(buffer!.destroys, 1, 'ownership cannot leak before the copy descriptor returns');
  });

  it('normalizes BGRA mapped bytes to RGBA and releases the temporary buffer', async () => {
    let buffer: FakeBuffer | null = null;
    const device = {
      createBuffer: ({ size }: { size: number }) => {
        buffer = fakeBuffer(size);
        return buffer;
      },
    } as unknown as GPUDevice;
    const encoder = { copyTextureToBuffer() {} } as unknown as GPUCommandEncoder;
    const copy = encodeRendererColorFrameReadback(device, encoder, {} as GPUTexture, 2, 2, 'bgra8unorm');
    const bytes = new Uint8Array(buffer!.bytes);
    bytes.set([30, 20, 10, 255], 0);
    // A 2-pixel row has 248 bytes of WebGPU-mandated padding.
    bytes.set([70, 60, 50, 255], 256);

    const frame = await resolveRendererColorFrameReadback(copy);

    assert.deepStrictEqual([...frame!.rgba.subarray(0, 4)], [10, 20, 30, 255]);
    assert.deepStrictEqual([...frame!.rgba.subarray(8, 12)], [50, 60, 70, 255]);
    assert.strictEqual(buffer!.unmaps, 1);
    assert.strictEqual(buffer!.destroys, 1);
  });

  it('releases a failed render request so a later color capture can proceed', async () => {
    const host = {};
    const failure = new Error('render scheduling failed');
    await assert.rejects(
      requestRendererColorFrame(host, true, () => { throw failure; }),
      failure,
    );

    let requests = 0;
    const next = requestRendererColorFrame(host, true, () => { requests++; });
    assert.strictEqual(requests, 1, 'the failed request did not leave a coalesced capture behind');
    cancelRendererColorFrame(host);
    assert.strictEqual(await next, null);
  });
});
