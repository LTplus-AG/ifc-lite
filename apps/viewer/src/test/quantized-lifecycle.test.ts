/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { recoveryAllocationDevice } from './recovery-allocation-device';

type Allocation = ReturnType<typeof recoveryAllocationDevice>;
const triangle: MeshData = {
  expressId: 42, modelIndex: 2,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]), color: [0.2, 0.4, 0.6, 1],
};

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(1);
  assert.ok(predicate(), 'bounded allocation-boundary observation reached');
}

async function request(allocation: Allocation, index: number, deviceIndex: number) {
  await until(() => allocation.quantizedRequests.length > index);
  const result = allocation.quantizedRequests[index];
  assert.equal(result.deviceIndex, deviceIndex);
  assert.equal(result.descriptor.vertex.entryPoint, 'vs_main_quantized');
  assert.equal(Array.from(result.descriptor.vertex.buffers ?? [])[0]?.arrayStride, 12);
  return result;
}

async function admit(allocation: Allocation, work: Promise<boolean>, deviceIndex: number, first: number) {
  const opaque = await request(allocation, first, deviceIndex);
  assert.equal(opaque.descriptor.depthStencil?.depthWriteEnabled, true);
  opaque.resolve();
  const transparent = await request(allocation, first + 1, deviceIndex);
  assert.equal(transparent.descriptor.depthStencil?.depthWriteEnabled, false);
  transparent.resolve();
  assert.equal(await work, true);
}

/** Inspect the production upload, independently decode its positions and owner
 * lane, and require exactly the input triangle. No mocked admission/Scene path. */
function upload(renderer: Renderer, allocation: Allocation, quantized: boolean, deviceIndex: number) {
  const scene = renderer.getScene();
  scene.clear(); scene.setLodBuildsEnabled(false);
  assert.deepEqual(renderer.loadGeometry([triangle]), { ok: true, value: undefined });
  assertUploadedTriangle(renderer, allocation, quantized, deviceIndex);
}

function assertUploadedTriangle(renderer: Renderer, allocation: Allocation, quantized: boolean, deviceIndex: number) {
  const batches = renderer.getScene().getBatchedMeshes();
  assert.equal(batches.length, 1);
  const batch = batches[0]; assert.ok(batch.origin);
  const stride = quantized ? 12 : 28;
  assert.equal(Boolean(batch.quantized), quantized, 'only current admitted pipelines authorize 12-byte vertices');
  assert.equal(batch.vertexBuffer.size, 3 * stride);
  assert.equal(batch.indexCount, 3);
  assert.deepEqual(batch.expressIds, [42]); assert.deepEqual(batch.modelIndices, [2]);
  assert.equal(allocation.bufferDeviceIndex(batch.vertexBuffer), deviceIndex);
  assert.equal(allocation.bufferDeviceIndex(batch.indexBuffer), deviceIndex);
  const bytes = allocation.bufferBytes(batch.vertexBuffer);
  assert.equal(bytes.byteLength, 3 * stride);
  assert.deepEqual([...new Uint32Array(allocation.bufferBytes(batch.indexBuffer))], [0, 1, 2]);
  const view = new DataView(bytes);
  for (let vertex = 0; vertex < 3; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      const position = batch.quantized
        ? view.getUint16(vertex * stride + axis * 2, true) * batch.quantized.step + batch.quantized.min[axis]
        : view.getFloat32(vertex * stride + axis * 4, true);
      assert.equal(position + batch.origin[axis], triangle.positions[vertex * 3 + axis]);
    }
    assert.equal(view.getUint32(vertex * stride + (quantized ? 8 : 24), true) & 0x00ff_ffff, 42);
  }
}

async function fixture(run: (renderer: Renderer, allocation: Allocation) => Promise<void>, extra = false) {
  const allocation = recoveryAllocationDevice({ deferQuantizedPipelines: true, extraRecoveryAttempt: extra });
  const renderer = new Renderer(allocation.canvas);
  try { await renderer.init(); await run(renderer, allocation); }
  finally { renderer.destroy(); allocation.restore(); mock.restoreAll(); }
}

it('#7655 unchanged live owner admits only after BOTH production variants validate', { timeout: 10_000 }, async () => {
  await fixture(async (renderer, allocation) => {
    upload(renderer, allocation, false, 0);
    const work = renderer.enableQuantizedBatches(), pipeline = renderer.getPipeline(); assert.ok(pipeline);
    (await request(allocation, 0, 0)).resolve();
    const transparent = await request(allocation, 1, 0);
    upload(renderer, allocation, false, 0);
    transparent.resolve(); assert.equal(await work, true);
    assert.equal(pipeline.getQuantizedPipelineVariant('opaque'), allocation.quantizedRequests[0].pipeline);
    assert.equal(pipeline.getQuantizedPipelineVariant('transparent'), transparent.pipeline);
    upload(renderer, allocation, true, 0);
    assert.equal(await renderer.enableQuantizedBatches(), true);
    assert.equal(allocation.quantizedRequests.length, 2, 'validated variants are reused');
  });
});

for (const retireAt of ['opaque', 'transparent'] as const) {
  it(`#7655 pipeline destroyed during ${retireAt} wait cannot cache or start retired work`, { timeout: 10_000 }, async () => {
    await fixture(async (renderer, allocation) => {
      const pipeline = renderer.getPipeline(); assert.ok(pipeline);
      const work = pipeline.ensureQuantizedPipelines();
      let pending = await request(allocation, 0, 0);
      if (retireAt === 'transparent') { pending.resolve(); pending = await request(allocation, 1, 0); }
      pipeline.destroy(); pending.resolve();
      await delay(0);
      assert.equal(allocation.quantizedRequests.length, retireAt === 'opaque' ? 1 : 2,
        'retired completion must not initiate the next variant');
      assert.equal(await work, false);
      assert.equal(allocation.quantizedRequests.length, retireAt === 'opaque' ? 1 : 2);
      assert.equal(pipeline.getQuantizedPipelineVariant('opaque'), null);
      assert.equal(pipeline.getQuantizedPipelineVariant('transparent'), null);
      assert.equal(await pipeline.ensureQuantizedPipelines(), false);
      assert.equal(allocation.quantizedRequests.length, retireAt === 'opaque' ? 1 : 2);
    });
  });
}

it('#7655 retired validation rejection cannot report a current-owner failure', { timeout: 10_000 }, async () => {
  await fixture(async (renderer, allocation) => {
    const warnings: unknown[][] = [];
    mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const work = renderer.enableQuantizedBatches();
    const opaque = await request(allocation, 0, 0);
    renderer.destroy(); opaque.reject(new Error('Controlled retired-device rejection'));
    assert.equal(await work, false);
    assert.deepEqual(warnings, []);
    allocation.releaseReplacement(); await renderer.init();
    upload(renderer, allocation, false, 1);
  });
});

it('#7655 reinit while old opaque probe waits leaves successor f32 until its OWN validation', { timeout: 10_000 }, async () => {
  await fixture(async (renderer, allocation) => {
    const work = renderer.enableQuantizedBatches();
    const old = await request(allocation, 0, 0);
    allocation.releaseReplacement(); await renderer.init();
    old.resolve(); assert.equal(await work, false);
    assert.equal(allocation.quantizedRequests.length, 1);
    upload(renderer, allocation, false, 1);
    await admit(allocation, renderer.enableQuantizedBatches(), 1, 1);
    upload(renderer, allocation, true, 1);
  });
});

it('#7655 renderer fences a completed pipeline result before public init tears it down', { timeout: 10_000 }, async () => {
  await fixture(async (renderer, allocation) => {
    const pipeline = renderer.getPipeline(); assert.ok(pipeline);
    await admit(allocation, pipeline.ensureQuantizedPipelines(), 0, 0);
    // Production ensure returns cached success synchronously. Public init now
    // revokes the generation before enable's queued continuation can publish.
    const work = renderer.enableQuantizedBatches();
    // Observe bytes after enable's continuation but before the queued init body.
    // Its generation is already revoked; a stale publication must not re-admit
    // the old Scene even in this window. Teardown's reset cannot mask this fence.
    const observed = new Promise<void>((resolve, reject) => queueMicrotask(() => {
      try { upload(renderer, allocation, false, 0); resolve(); }
      catch (error) { reject(error); }
    }));
    allocation.releaseReplacement(); const replacement = renderer.init();
    await observed;
    assert.equal(await work, false);
    await replacement;
    upload(renderer, allocation, false, 1);
  });
});

it('#7655 renderer fences cached success when device loss latches before publication', { timeout: 10_000 }, async () => {
  await fixture(async (renderer, allocation) => {
    const pipeline = renderer.getPipeline(); assert.ok(pipeline);
    await admit(allocation, pipeline.ensureQuantizedPipelines(), 0, 0);
    allocation.loseInitialDevice('Controlled loss before cached success publication');
    const work = renderer.enableQuantizedBatches();
    assert.equal(await work, false);
    assert.equal(renderer.isDeviceLost(), true);
  });
});

it('#7655 ordinary init resets admitted layout while preserving requested recovery policy', { timeout: 10_000 }, async () => {
  await fixture(async (renderer, allocation) => {
    await admit(allocation, renderer.enableQuantizedBatches(), 0, 0);
    upload(renderer, allocation, true, 0);
    allocation.releaseReplacement(); await renderer.init();
    upload(renderer, allocation, false, 1);
    // No second enable call: recovery must remember the user's requested policy.
    allocation.loseDevice(1, 'Controlled successor device loss');
    await until(() => renderer.isDeviceLost());
    const recovery = renderer.recoverDevice();
    await admit(allocation, recovery.then(result => result.ok), 2, 2);
    assert.equal(renderer.isReady(), true);
    assertUploadedTriangle(renderer, allocation, true, 2);
    upload(renderer, allocation, true, 2);
  }, true);
});

for (const variant of ['opaque', 'transparent'] as const) {
  it(`#7655 live ${variant} validation refusal remains observable and falls back to actual f32 upload`, { timeout: 10_000 }, async () => {
    await fixture(async (renderer, allocation) => {
      const warnings: unknown[][] = [];
      mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
      const work = renderer.enableQuantizedBatches();
      let pending = await request(allocation, 0, 0);
      if (variant === 'transparent') { pending.resolve(); pending = await request(allocation, 1, 0); }
      const error = new Error('Controlled live-owner validation refusal'); pending.reject(error);
      assert.equal(await work, false);
      assert.equal(warnings.length, 1); assert.equal(warnings[0][1], error);
      upload(renderer, allocation, false, 0);
      assert.equal(await renderer.enableQuantizedBatches(), false, 'live failure is not retried every frame');
    });
  });
}

for (const supersede of ['init', 'destroy', 'loss'] as const) {
  it(`#7655 recovery superseded by ${supersede} during probe cannot restore GPU batches`, { timeout: 10_000 }, async () => {
    await fixture(async (renderer, allocation) => {
      await admit(allocation, renderer.enableQuantizedBatches(), 0, 0);
      upload(renderer, allocation, true, 0);
      allocation.loseInitialDevice('Controlled loss entering recovery');
      await until(() => renderer.isDeviceLost());
      allocation.releaseReplacement(); const recovery = renderer.recoverDevice();
      const opaque = await request(allocation, 2, 1);
      const before = allocation.allocations.length;
      let successor: Promise<void> | undefined;
      if (supersede === 'init') successor = renderer.init();
      else if (supersede === 'destroy') renderer.destroy();
      else { allocation.loseDevice(1, 'Controlled replacement loss during validation'); await delay(0); }
      opaque.resolve();
      if (supersede !== 'destroy') (await request(allocation, 3, 1)).resolve();
      const result = await recovery;
      assert.equal(result.ok, false);
      // The observation is at allocation, BEFORE a queued ordinary init runs.
      assert.equal(allocation.allocations.slice(before).filter(({ buffer, deviceIndex }) =>
        deviceIndex === 1 && (buffer.usage & GPUBufferUsage.VERTEX) !== 0).length, 0,
      'retired recovery must not upload the retained triangle before its later readiness fence');
      assert.equal(!result.ok && result.reason, supersede === 'loss' ? 'device-init-failed' : 'renderer-destroyed');
      if (successor) { await successor; upload(renderer, allocation, false, 2); }
      if (supersede === 'destroy') {
        assert.equal(renderer.isReady(), false);
        await renderer.init(); upload(renderer, allocation, false, 2);
      }
    }, true);
  });
}
