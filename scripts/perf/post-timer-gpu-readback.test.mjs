/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostTimerGpuReadback } from './post-timer-gpu-readback.mjs';
const limits = { maxBufferSize: 64 * 1024 * 1024, maxTextureDimension2D: 8192,
  maxUniformBufferBindingSize: 64, minUniformBufferOffsetAlignment: 16 };
function reader(overrides = {}) { return createPostTimerGpuReadback({ limits: { ...limits, ...overrides }, lost: new Promise(() => {}) }); }
const buffer = (size, usage = 40) => ({ size, usage, mapState: 'unmapped' });
const atlas = (width, height) => ({ width, height, usage: 22, format: 'rgba8unorm', dimension: '2d', sampleCount: 1, depthOrArrayLayers: 1, mipLevelCount: 1 });
test('#6537 uniform windows cover a nonaligned word range exactly within binding bounds', () => {
  const p = reader().planBuffer(buffer(160, 72), 12, 132), addressed = [];
  for (const t of p.tiles) {
    assert.equal(t.bindOffset % 16, 0); assert.equal(t.bindingSize % 16, 0);
    assert.ok(t.bindingSize <= 64 && t.bindOffset + t.bindingSize <= 160);
    for (let i = 0; i < t.bytes / 4; i++) addressed.push(t.bindOffset + (t.prefixWords + i) * 4);
  }
  assert.deepEqual(addressed, Array.from({ length: 33 }, (_, i) => 12 + i * 4));
});
test('#6537 2D buffer tiling preserves exact used bytes and adapter/staging bounds', () => {
  const p = reader().planBuffer(buffer(32 * 1024 * 1024), 0, 32 * 1024 * 1024);
  assert.ok(p.tiles.length > 1); let consumed = 0;
  for (const t of p.tiles) {
    assert.equal(t.consumed, consumed); consumed += t.bytes;
    assert.ok(t.bytes <= t.width * t.height * 4 && t.height <= 8192 && t.width <= 8192);
    assert.equal(t.pitch % 256, 0); assert.ok(t.stagingBytes <= 4 * 1024 * 1024);
  }
  assert.equal(consumed, 32 * 1024 * 1024);
});
test('#6537 atlas tiles cover the requested rectangle once without row-padding bytes', () => {
  const p = reader({ maxBufferSize: 256, maxTextureDimension2D: 128 }).planAtlas(atlas(67, 35), { x: 3, y: 2, width: 61, height: 31 });
  const pixels = new Set();
  for (const t of p.tiles) {
    assert.equal(t.stagingBytes, 256);
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
      const key = (t.dy + y) * 61 + t.dx + x; assert.ok(!pixels.has(key)); pixels.add(key);
      assert.equal(t.x + x, 3 + t.dx + x); assert.equal(t.y + y, 2 + t.dy + y);
    }
  }
  assert.equal(pixels.size, 61 * 31); assert.equal(p.length, 61 * 31 * 4);
});
test('#6537 invalid source usages/ranges/state refuse before any GPU allocation', async () => {
  let calls = 0;
  const r = createPostTimerGpuReadback({ limits, lost: new Promise(() => {}), createTexture() { calls++; throw new Error('allocation reached'); } });
  await assert.rejects(r.readBuffer(buffer(16, 41)), /original buffer usage40/);
  await assert.rejects(r.readBuffer({ ...buffer(16), mapState: 'mapped' }), /source buffer state/);
  for (const [offset, length] of [[-4, 4], [2, 4], [0, 6], [64 * 1024 * 1024, 4], [0, 0], [0, 33 * 1024 * 1024], [Number.MAX_SAFE_INTEGER, 4]]) await assert.rejects(r.readBuffer(buffer(64 * 1024 * 1024), offset, length), /word range/);
  for (const source of [{ ...atlas(2, 2), usage: 23 }, { ...atlas(2, 2), format: 'rgba8unorm-srgb' }, { ...atlas(2, 2), sampleCount: 4 }, { ...atlas(2, 2), mipLevelCount: 2 }]) await assert.rejects(r.readAtlas(source), /atlas original usage22/);
  await assert.rejects(r.readAtlas(atlas(8192, 8192)), /atlas rectangle/); await assert.rejects(r.readAtlas(atlas(2, 2), { x: 1, width: 2 }), /atlas rectangle/);
  assert.equal(calls, 0);
});
test('#6537 adapter and tile budgets refuse unbounded or invalid plans', () => {
  assert.throws(() => reader({ maxBufferSize: 128 }), /adapter limits/);
  assert.throws(() => reader({ minUniformBufferOffsetAlignment: 0 }).planBuffer(buffer(16, 72)), /uniform limits/);
  assert.throws(() => reader().planBuffer(buffer(32 * 1024 * 1024, 72)), /tile count/);
});

test('#6537 UTF8 shader diagnostic bound refuses non-ASCII before pipeline creation', async () => {
  let pipelines = 0, destroyed = 0;
  const r = createPostTimerGpuReadback({ limits, lost: new Promise(() => {}),
    pushErrorScope() {}, async popErrorScope() { return null; },
    createTexture() { return { destroy() { destroyed++; } }; },
    createBuffer() { return { destroy() { destroyed++; } }; },
    createShaderModule() { return { async getCompilationInfo() {
      return { messages: Array.from({ length: 32 }, () => ({ type: 'warning', message: '界'.repeat(1365), lineNum: 1, linePos: 1, offset: 0, length: 1 })) };
    } }; },
    async createRenderPipelineAsync() { pipelines++; throw new Error('pipeline reached'); },
  });
  await assert.rejects(r.readBuffer(buffer(4)), /total shader diagnostic budget/);
  assert.equal(pipelines, 0); assert.equal(destroyed, 2); assert.equal(r.status().status, 'refused');
});
test('#6537 oversized cleanup messages retain a bounded prefix and refuse completion', async () => {
  const r = createPostTimerGpuReadback({ limits, lost: new Promise(() => {}),
    pushErrorScope() {}, async popErrorScope() { return null; },
    createTexture() { return { destroy() { throw new Error('界'.repeat(4000)); } }; },
    createBuffer() { throw new Error('independent allocation failure'); },
  });
  await assert.rejects(r.readBuffer(buffer(4)), /independent allocation failure/);
  const receipt = r.close(); assert.equal(receipt.status, 'refused');
  assert.match(receipt.prefixRefusal, /UTF8 prefix/);
  assert.equal(receipt.cleanupFailures.length, 1);
  assert.ok(new TextEncoder().encode(receipt.cleanupFailures[0]).length <= 4096);
});
