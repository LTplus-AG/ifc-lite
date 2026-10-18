/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferOpaqueVisibilityFrame, OpaqueVisibilityPass } from './opaque-visibility-pass.js';

Object.assign(globalThis, {
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
  GPUTextureUsage: { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 },
});

function harness() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const validation = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const stats = { sync: 0, async: 0, draws: 0, pipelines: 0, textures: 0, destroyed: 0 };
  const pipeline = () => ({ getBindGroupLayout: () => ({}) });
  const pass = { setPipeline: () => { stats.pipelines++; }, setBindGroup: () => {},
    drawIndexed: () => { stats.draws++; }, end: () => {} };
  const encoder = { beginRenderPass: () => pass, finish: () => ({}) } as unknown as GPUCommandEncoder;
  const device = {
    createRenderPipeline: () => { stats.sync++; return pipeline(); },
    createRenderPipelineAsync: async () => { stats.async++; await validation; return pipeline(); },
    createShaderModule: () => ({}), createPipelineLayout: () => ({}),
    createBindGroupLayout: () => ({}), createBindGroup: () => ({}),
    createCommandEncoder: () => encoder,
    createTexture: () => { stats.textures++; return { createView: () => ({}), destroy: () => { stats.destroyed++; } }; },
  } as unknown as GPUDevice;
  const visibility = new OpaqueVisibilityPass(device, 1);
  const module = {} as GPUShaderModule;
  const base = visibility.create({ layout: 'auto', vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } });
  const begin = (orthographic = true) => visibility.begin(encoder, { colorAttachments: [] }, orthographic, 64, 64);
  return { visibility, base, begin, stats, resolve, reject };
}

test('#6729 pending async validation defers the frame without an unconstrained draw', async () => {
  const h = harness(); let wakes = 0;
  try {
    const pass = h.begin();
    assert.throws(() => pass.setPipeline(h.base), error => deferOpaqueVisibilityFrame(error, () => { wakes++; }));
    assert.equal(h.stats.pipelines, 0, 'neither the base nor an invalid variant may reach the pass');
    assert.equal(h.stats.sync, 1, 'only the existing base pipeline uses synchronous creation');
    h.resolve(); await h.visibility.prepare(); await Promise.resolve();
    assert.equal(wakes, 1, 'completed validation requests a replacement frame');
    pass.setPipeline(h.base); pass.drawIndexed(3); pass.end();
    assert.equal(h.stats.draws, 2, 'validated opaque draws reach both geometric depth and colour');
    assert.equal(h.stats.async, 2, 'colour and depth were each asynchronously validated once');
  } finally { h.visibility.destroy(); }
});

test('#6729 rejected async validation is reported and never cached as a drawable pipeline', async () => {
  const h = harness(); const failure = new Error('controlled GPU validation rejection');
  try {
    const pass = h.begin();
    assert.throws(() => pass.setPipeline(h.base), error => deferOpaqueVisibilityFrame(error, () => {}));
    h.reject(failure);
    await assert.rejects(h.visibility.prepare(), error => error === failure);
    assert.throws(() => pass.setPipeline(h.base), error => error === failure);
    assert.equal(h.stats.pipelines, 0); assert.equal(h.stats.draws, 0);
    assert.equal(h.stats.async, 1, 'a rejected colour variant never publishes or starts a depth variant');
    assert.equal(deferOpaqueVisibilityFrame(failure, () => {}), false, 'real validation failures go to renderer diagnostics');
  } finally { h.visibility.destroy(); }
});

test('#6729 perspective releases orthographic storage and a later orthographic frame recreates it', () => {
  const h = harness();
  try {
    h.begin().end(); assert.equal(h.stats.textures, 1);
    h.begin(false).end(); assert.equal(h.stats.destroyed, 1);
    h.begin(false).end(); assert.equal(h.stats.destroyed, 1, 'perspective does not allocate or repeatedly destroy');
    h.begin().end(); assert.equal(h.stats.textures, 2);
  } finally { h.visibility.destroy(); }
  assert.equal(h.stats.destroyed, 2, 'both allocated textures are released exactly once');
});
