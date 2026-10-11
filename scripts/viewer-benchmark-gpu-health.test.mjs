/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6993 (folding in #7164): every benchmark sample reports whether it lost its
// GPU device, from the viewer's session counters and the console, so a
// device-lost sample is flagged instead of averaged with clean ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { gpuHealthFrom, readGpuHealth } = await tsImport('../tests/benchmark/gpu-health.ts', import.meta.url);

// What the renderer (packages/renderer/src/device.ts) and Chromium print.
const LOST = '[WebGPU] Device lost: A valid external Instance reference no longer exists. (reason: unknown)';
const INSTANCE = 'A valid external Instance reference no longer exists.';
const DESTROYED = '[WebGPU] Device lost: Device was destroyed. (reason: destroyed)';
const UNCAPTURED = '[WebGPU] Uncaptured error: Buffer is invalid due to a previous error.';
const CLEAN_LOGS = ['[useIfc] Geometry streaming complete: 4 batches, 317 meshes'];

test('a clean sample is not flagged', () => {
  const health = gpuHealthFrom(CLEAN_LOGS, { 'gpu.devices': 1, 'gpu.buffers': 40 });
  assert.equal(health.contaminated, false);
  assert.deepEqual(health.reasons, []);
  assert.equal(health.devicesCreated, 1);
  assert.equal(health.source, 'counters+console');
});

test('#7164: an instance/device loss before the first batch is flagged, counted once across both witnesses', () => {
  const health = gpuHealthFrom([...CLEAN_LOGS, INSTANCE, LOST], { 'gpu.devices': 1, 'gpu.deviceLost': 1 });
  assert.equal(health.contaminated, true);
  assert.equal(health.deviceLost, 1, 'the counter and the console saw the same loss');
  assert.equal(health.instanceErrors, 1, 'the renderer line quoting the message is the device loss, not a second instance error');
  assert.match(health.reasons.join(';'), /GPU device lost ≥1x/);
  assert.ok(health.events.includes(LOST));
});

test('a renderer replacing its own device (re-upload path) flags the sample even with no console line', () => {
  const health = gpuHealthFrom(CLEAN_LOGS, { 'gpu.devices': 2, 'gpu.deviceReplacements': 1 });
  assert.equal(health.contaminated, true);
  assert.match(health.reasons[0], /replaced its GPU device 1x/);
});

test('#6993 review: two live renderers with one device each (viewport + appearance preview) are a clean sample', () => {
  const health = gpuHealthFrom(CLEAN_LOGS, { 'gpu.devices': 2 });
  assert.equal(health.contaminated, false, health.reasons.join(';'));
  assert.equal(health.devicesCreated, 2);
  assert.equal(health.deviceReplacements, 0);
});

test('a pre-#6993 build is still classified from the console alone', () => {
  const health = gpuHealthFrom([LOST], null);
  assert.equal(health.contaminated, true);
  assert.equal(health.devicesCreated, null);
  assert.equal(health.source, 'console');
});

test('an instance error from a probe on an already-destroyed device is evidence, not a lost sample', () => {
  // Every WSL SwiftShader sample (FZK and Snowdon) logs this before the load
  // while the renderer's own device lives on (gpu.devices 1, no loss).
  const probe = '[Pipeline] quantized pipeline validation failed; staying on f32 vertices: GPUPipelineError: A valid external Instance reference no longer exists.';
  const health = gpuHealthFrom([DESTROYED, probe], { 'gpu.devices': 1 });
  assert.equal(health.contaminated, false);
  assert.equal(health.instanceErrors, 1);
  assert.ok(health.events.includes(probe));
});

test('intentional teardown and uncaptured errors alone are reported, not flagged', () => {
  const health = gpuHealthFrom([DESTROYED, UNCAPTURED, UNCAPTURED], { 'gpu.devices': 1, 'gpu.uncapturedErrors': 2 });
  assert.equal(health.contaminated, false);
  assert.equal(health.deviceLost, 0);
  assert.equal(health.uncapturedErrors, 2);
});

test('reads the viewer session counters through the page, and falls back when the page cannot answer', async () => {
  const page = { evaluate: async (fn, key) => fn.call(null, key) };
  globalThis.__IFC_LITE_LOAD_TRACE__ = { sessionCounters: () => ({ 'gpu.devices': 1, 'gpu.deviceLost': 1 }) };
  try {
    const health = await readGpuHealth(page, CLEAN_LOGS);
    assert.equal(health.contaminated, true);
    assert.equal(health.source, 'counters+console');
  } finally {
    delete globalThis.__IFC_LITE_LOAD_TRACE__;
  }
  const crashed = { evaluate: async () => { throw new Error('Target page, context or browser has been closed'); } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const health = await readGpuHealth(crashed, [LOST]);
    assert.equal(health.contaminated, true);
    assert.equal(health.source, 'console');
  } finally {
    console.warn = warn;
  }
});

// #6993 review: every loss line the renderer and viewer can print, alone and
// without session counters (a pre-counter base build), flags the sample.
const LOSS_LINES = {
  'WebGPUDevice.lost': LOST,
  'Renderer.handleDeviceLost': '[Renderer] GPU device lost — halting rendering until re-init: The object is in an invalid state.',
  reportDeviceLost: '[Viewport] GPU device lost: unknown A valid external Instance reference no longer exists.',
};

for (const [site, line] of Object.entries(LOSS_LINES)) {
  test(`#6993 the ${site} loss line alone, with no counters, flags the sample`, () => {
    const health = gpuHealthFrom([...CLEAN_LOGS, line], null);
    assert.equal(health.contaminated, true, line);
    assert.equal(health.deviceLost, 1);
    assert.equal(health.instanceErrors, 0, 'a loss line quoting the instance message is the loss, not an instance error');
  });
}

test('#6993 one loss reported through every site counts once, not three times', () => {
  const health = gpuHealthFrom([INSTANCE, ...Object.values(LOSS_LINES), DESTROYED], null);
  assert.equal(health.deviceLost, 1);
  assert.equal(health.instanceErrors, 1);
});

// Drift guards: the lines the REAL log sites print, not copies of them.
async function captureWarnings(run) {
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try { await run(); } finally { console.warn = warn; }
  return lines;
}

test('#6993 drift guard: the renderer\'s handleDeviceLost line is classified as a loss', async () => {
  const { Renderer } = await tsImport('../packages/renderer/src/index.ts', import.meta.url);
  const lines = await captureWarnings(() => {
    const renderer = new Renderer({ width: 0, height: 0, getBoundingClientRect: () => ({ width: 1, height: 1 }) });
    renderer['handleDeviceLost']({ message: 'The object is in an invalid state.', reason: 'gpu-upload-exception' });
  });
  assert.ok(lines.length > 0, 'guard: the renderer printed nothing, so this would prove nothing');
  assert.equal(gpuHealthFrom(lines, null).contaminated, true, lines.join('\n'));
});

test('#6993 drift guard: WebGPUDevice\'s device.lost line is classified; its destroyed teardown line is not', async () => {
  const { WebGPUDevice } = await tsImport('../packages/renderer/src/device.ts', import.meta.url);
  const run = async (reason) => {
    let settle;
    const device = { lost: new Promise((r) => { settle = r; }), queue: {}, createBuffer() {}, addEventListener() {} };
    const adapter = { limits: {}, features: new Set(), requestDevice: async () => device };
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' } } });
    globalThis.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10 };
    try {
      return await captureWarnings(async () => {
        const wrapper = new WebGPUDevice();
        await wrapper.init({ width: 1, height: 1, getContext: () => ({ configure() {} }) });
        settle({ message: 'A valid external Instance reference no longer exists.', reason });
        await new Promise((r) => setImmediate(r));
      });
    } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
    }
  };
  const lost = await run('unknown');
  assert.ok(lost.some((l) => l.includes('Device lost')), `guard: no loss line printed:\n${lost.join('\n')}`);
  assert.equal(gpuHealthFrom(lost, null).contaminated, true, lost.join('\n'));
  const destroyed = await run('destroyed');
  assert.ok(destroyed.some((l) => l.includes('Device lost')), 'guard: no teardown line printed');
  assert.equal(gpuHealthFrom(destroyed, null).contaminated, false, destroyed.join('\n'));
});

test('#6993 review: the loss count is always a lower bound, even when the counter agrees with every site', () => {
  // Two DISTINCT losses, each printed at a different site only (a sync loss via
  // handleDeviceLost, then an async device.lost): logs cannot tell them from
  // one loss printed twice, and the counter sees only the async one, so it
  // agrees with both sites at 1 while there were 2 losses.
  const twoSites = [LOSS_LINES['Renderer.handleDeviceLost'], LOSS_LINES['WebGPUDevice.lost']];
  for (const counters of [null, { 'gpu.devices': 3, 'gpu.deviceLost': 1 }]) {
    const health = gpuHealthFrom(twoSites, counters);
    assert.equal(health.contaminated, true);
    assert.equal(health.deviceLost, 1);
    assert.match(health.reasons[0], /GPU device lost ≥1x/, `counters=${JSON.stringify(counters)}`);
    assert.doesNotMatch(health.reasons.join(';'), /lost 1x/, 'never claimed exact');
  }
});
