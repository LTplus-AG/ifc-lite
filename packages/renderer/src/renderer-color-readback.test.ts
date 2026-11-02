/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  traceRendererColorFrameEncoder,
  discardRendererColorFrameReadback,
  beginRendererColorFrameCapture,
  encodeRendererColorFrameCapture,
  settleRendererColorFrameCapture,
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

// #8566 d394: duplicate evidence must be two copies in the same submission,
// with frame metadata retained independently of later camera/store mutations.
it('diagnostic readback preserves two independent copies and submitted metadata', async () => {
  const host = {}; const buffers: FakeBuffer[] = []; let renders = 0, copies = 0;
  const device = { createBuffer: ({ size }: { size: number }) => {
    const buffer = fakeBuffer(size); buffers.push(buffer); return buffer;
  } } as unknown as GPUDevice;
  const encoder = { copyTextureToBuffer() { copies++; } } as unknown as GPUCommandEncoder;
  const pending = requestRendererColorFrame(host, true, () => { renders++; }, true);
  const capture = beginRendererColorFrameCapture(host, {} as GPUTexture, 2, 2, 'rgba8unorm')!;
  capture.metadata = { frameId: 7, eye: [1, 2, 3] };
  const copy = encodeRendererColorFrameCapture(device, encoder, capture);
  new Uint8Array(buffers[0].bytes).set([10, 20, 30, 255]);
  new Uint8Array(buffers[1].bytes).set([11, 20, 30, 255]);
  settleRendererColorFrameCapture(host, capture, copy);
  const frame = await pending;
  assert.equal(renders, 1); assert.equal(copies, 2);
  assert.equal(frame!.rgba[0], 10); assert.equal(frame!.duplicate![0], 11);
  assert.equal(frame!.metadata!.frameId, 7);
  assert.ok(buffers.every(buffer => buffer.destroys === 1 && buffer.unmaps === 1));
});

function captureHarness(diagnostic = true, failAllocation = 0, failCopy = 0) {
  const host = {}; const buffers: FakeBuffer[] = []; let allocations = 0, copies = 0, renders = 0;
  const device = { createBuffer: ({ size }: { size: number }) => {
    if (++allocations === failAllocation) throw new Error('allocation rejected');
    const buffer = fakeBuffer(size); buffers.push(buffer); return buffer;
  } } as unknown as GPUDevice;
  const encoder = { copyTextureToBuffer() {
    if (++copies === failCopy) throw new Error('encoding rejected');
  } } as unknown as GPUCommandEncoder;
  const pending = requestRendererColorFrame(host, true, () => { renders++; }, diagnostic);
  const capture = beginRendererColorFrameCapture(host, {} as GPUTexture, 2, 2, 'rgba8unorm')!;
  return { host, buffers, device, encoder, pending, capture, counts: () => ({ allocations, copies, renders }) };
}

it('#8566 default capture forwards the original encoder and copies once without diagnostic metadata', async () => {
  const h = captureHarness(false);
  assert.strictEqual(traceRendererColorFrameEncoder(h.capture, h.encoder), h.encoder);
  const copy = encodeRendererColorFrameCapture(h.device, h.encoder, h.capture);
  settleRendererColorFrameCapture(h.host, h.capture, copy);
  const frame = await h.pending;
  assert.deepStrictEqual(h.counts(), { allocations: 1, copies: 1, renders: 1 });
  assert.equal(frame!.duplicate, undefined); assert.equal(frame!.metadata, undefined);
  assert.equal(h.buffers[0].destroys, 1);
});

for (const failure of ['allocation', 'encoding'] as const) {
  it(`#8566 second-copy ${failure} rejection releases every allocated buffer`, async () => {
    const h = captureHarness(true, failure === 'allocation' ? 2 : 0, failure === 'encoding' ? 2 : 0);
    assert.throws(() => encodeRendererColorFrameCapture(h.device, h.encoder, h.capture), /rejected/);
    // Renderer render-error path cancels the outstanding requester after encoding throws.
    cancelRendererColorFrame(h.host);
    assert.equal(await h.pending, null);
    assert.equal(h.buffers.length, failure === 'allocation' ? 1 : 2);
    assert.ok(h.buffers.every(buffer => buffer.destroys === 1 && buffer.unmaps === 0));
  });
}

for (const failedIndex of [0, 1]) {
  it(`#8566 rejected mapping of copy ${failedIndex} fails closed and frees both buffers`, async () => {
    const h = captureHarness();
    const copy = encodeRendererColorFrameCapture(h.device, h.encoder, h.capture);
    h.buffers[failedIndex].mapAsync = async () => { throw new Error('expected map rejection'); };
    settleRendererColorFrameCapture(h.host, h.capture, copy);
    assert.equal(await h.pending, null);
    assert.ok(h.buffers.every(buffer => buffer.destroys === 1));
    assert.equal(h.buffers[failedIndex].unmaps, 0);
    assert.equal(h.buffers[1 - failedIndex].unmaps, 1);
    const next = requestRendererColorFrame(h.host, true, () => {});
    cancelRendererColorFrame(h.host); assert.equal(await next, null);
  });
}

it('#8566 rejected submission discards both encoded buffers without attempting mapping', async () => {
  const h = captureHarness();
  const copy = encodeRendererColorFrameCapture(h.device, h.encoder, h.capture);
  discardRendererColorFrameReadback(copy); cancelRendererColorFrame(h.host);
  assert.equal(await h.pending, null);
  assert.ok(h.buffers.every(buffer => buffer.destroys === 1 && buffer.unmaps === 0));
});

it('#8566 a diagnostic request coalesced behind an ordinary capture cannot invent a duplicate', async () => {
  const h = captureHarness(false);
  const joined = requestRendererColorFrame(h.host, true, () => { throw new Error('extra render'); }, true);
  assert.strictEqual(joined, h.pending);
  const copy = encodeRendererColorFrameCapture(h.device, h.encoder, h.capture);
  settleRendererColorFrameCapture(h.host, h.capture, copy);
  assert.equal((await joined)!.duplicate, undefined);
  assert.equal(h.counts().copies, 1);
});
