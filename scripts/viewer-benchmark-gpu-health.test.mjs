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
  assert.match(health.reasons.join(';'), /GPU device lost 1x/);
  assert.ok(health.events.includes(LOST));
});

test('the renderer re-creating its device (re-upload path) flags the sample even with no console line', () => {
  const health = gpuHealthFrom(CLEAN_LOGS, { 'gpu.devices': 2 });
  assert.equal(health.contaminated, true);
  assert.match(health.reasons[0], /re-created its GPU device \(2 devices\)/);
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
