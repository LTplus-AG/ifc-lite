/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Buffer, Device } from '@luma.gl/core';

// Exercise the actual Vite transform and upstream implementation, not a copy of
// its partitioner. On production removal, use the published renderer: its
// approximation must fail the same ordering/preservation assertions (#8564).
async function rendererClass(exact) {
  const pluginURL = new URL('../contract/exact-runs-plugin.mjs', import.meta.url);
  let plugin;
  try { plugin = await import(pluginURL.href); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== pluginURL.href) throw error;
  }
  const url = new URL('splat-renderer.js', import.meta.resolve('@luma.gl/splats'));
  const transformed = await plugin?.exactRunsPlugin(exact).load(fileURLToPath(url));
  const target = `${url.href}?contract-test=${exact}`;
  const hook = registerHooks({ load(id, context, next) {
    return id === target && transformed
      ? { format: 'module', source: transformed.code, shortCircuit: true }
      : next(id, context);
  } });
  try { return (await import(target)).SplatRenderer; }
  finally { hook.deregister(); }
}

// CPU storage at the device boundary only. Renderer partitioning, buffer reuse,
// resource ownership and luma's Buffer/Resource lifecycle run unmodified.
// These tests do not execute a GPU driver, shader, frame or command submission.
class MemoryBuffer extends Buffer {
  constructor(device, props) {
    super(device, props);
    this.bytes = new Uint8Array(props.data.buffer, props.data.byteOffset, props.data.byteLength).slice();
    this.byteLength = this.bytes.byteLength;
    this.writes = 0;
    this.destroyCalls = 0;
  }
  write(data) {
    assert.equal(this.destroyed, false, 'cannot write a released buffer');
    this.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    this.writes++;
  }
  destroy() { this.destroyCalls++; super.destroy(); }
}
class MemoryDevice extends Device {
  type = 'webgpu';
  buffers = [];
  constructor() { super({ id: 'exact-runs-cpu-resource-test' }); }
  createBuffer(props) {
    const buffer = new MemoryBuffer(this, props);
    this.buffers.push(buffer);
    return buffer;
  }
}
const references = count => Array.from({ length: count }, (_, i) => ({ batchIndex: i % 2, batchRowIndex: count - i - 1 }));
const flatten = runs => runs.flatMap(run => Array.from(run.rowIndices, row => [run.batchIndex, row]));
const expected = refs => refs.map(ref => [ref.batchIndex, ref.batchRowIndex]);
async function fixture(exact = true) {
  const Renderer = await rendererClass(exact);
  const device = new MemoryDevice();
  const renderer = new Renderer(device);
  // Partition input has two source slots. No source payload/model is required
  // by rebuildDrawRuns; sorting and rendering remain outside this CPU test.
  renderer.batches.length = 2;
  return { device, renderer, close() {
    renderer.destroy();
    // Also free allocations orphaned by a deliberate negative-control mutation.
    for (const buffer of device.buffers) if (!buffer.destroyed) buffer.destroy();
  } };
}

for (const count of [96, 128]) test(`#8564 preserves exact source/row order across ${count} runs and contiguous partitions`, async () => {
  const f = await fixture();
  try {
    const refs = references(count).flatMap((ref, i) => i % 7 ? [ref] : [ref, { ...ref, batchRowIndex: 1000 + i }]);
    f.renderer.sortedReferences = refs;
    f.renderer.rebuildDrawRuns();
    assert.deepEqual(flatten(f.renderer.drawRuns), expected(refs));
    assert.equal(f.renderer.drawRuns.length, count, 'contiguous rows share a run');
    for (const run of f.renderer.drawRuns) {
      assert.deepEqual(Array.from(new Uint32Array(run.indexBuffer.bytes.buffer)), Array.from(run.rowIndices));
    }
  } finally { f.close(); }
});

test('#8564 overflow preserves populated buffers, bytes and ownership until destroy', async () => {
  const f = await fixture();
  try {
    f.renderer.sortedReferences = references(96);
    f.renderer.rebuildDrawRuns();
    const runs = f.renderer.drawRuns;
    const buffers = runs.map(run => run.indexBuffer);
    const bytes = buffers.map(buffer => buffer.bytes.slice());
    const allocations = f.device.buffers.length;
    f.renderer.sortedReferences = references(129);
    assert.throws(() => f.renderer.rebuildDrawRuns(), /Exact source-run budget exceeded/);
    assert.strictEqual(f.renderer.drawRuns, runs, 'rejection must not detach the owned run list');
    assert.equal(f.device.buffers.length, allocations, 'rejection must not allocate');
    buffers.forEach((buffer, i) => {
      assert.equal(buffer.writes, 0, 'rejection must not overwrite the previous frame');
      assert.equal(buffer.destroyCalls, 0);
      assert.deepEqual(buffer.bytes, bytes[i]);
    });
    f.renderer.destroy();
    f.renderer.destroy();
    buffers.forEach(buffer => {
      assert.equal(buffer.destroyed, true);
      assert.equal(buffer.destroyCalls, 1, 'even after rejection, destroy reaches every prior buffer exactly once');
    });
  } finally { f.close(); }
});

test('#8564 shrinking and clearing runs releases surplus storage exactly once', async () => {
  const f = await fixture();
  try {
    f.renderer.sortedReferences = references(96);
    f.renderer.rebuildDrawRuns();
    const prior = f.renderer.drawRuns.map(run => run.indexBuffer);
    f.renderer.sortedReferences = references(2);
    f.renderer.rebuildDrawRuns();
    assert.deepEqual(flatten(f.renderer.drawRuns), expected(references(2)));
    assert.strictEqual(f.renderer.drawRuns[0].indexBuffer, prior[0]);
    assert.strictEqual(f.renderer.drawRuns[1].indexBuffer, prior[1]);
    assert.equal(prior.filter(buffer => buffer.destroyed).length, 94);
    f.renderer.sortedReferences = [];
    f.renderer.rebuildDrawRuns();
    assert.equal(f.renderer.drawRuns.length, 0);
    f.renderer.destroy();
    assert.ok(prior.every(buffer => buffer.destroyed && buffer.destroyCalls === 1));
  } finally { f.close(); }
});

test('#8564 adversarial source alternation exposes the published 64-run approximation', async () => {
  const f = await fixture(false);
  try {
    f.renderer.sortedReferences = references(96);
    f.renderer.rebuildDrawRuns();
    assert.notDeepEqual(flatten(f.renderer.drawRuns), expected(references(96)));
  } finally { f.close(); }
});
