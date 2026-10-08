/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { GpuFrameTimingRecorder } from './frame-timing-gpu.js';
import { Renderer } from './index.js';
import { timingDevice } from './test/frame-timing-device.js';

it('#6975 pending readback blocks reuse and preserves the recorded label until unmap', async () => {
  const gpu = timingDevice();
  const recorder = GpuFrameTimingRecorder.create(gpu.device, 2)!;
  recorder.beginFrame();
  recorder.beginPass('main');
  recorder.endFrame(gpu.encoder());
  const reading = recorder.readback();
  recorder.beginFrame();
  assert.doesNotThrow(() => {
    recorder.beginPass('next-frame');
    recorder.endFrame(gpu.encoder());
  });
  assert.equal(gpu.resolves(), 1);
  assert.equal(await recorder.readback(), null);
  gpu.settle();
  assert.deepEqual(await reading, [{ label: 'main', startNs: 1_000_000n, endNs: 3_000_000n }]);
  assert.equal(gpu.buffers[1]!.mapped, false);
  assert.equal(recorder.beginFrame(), true);
  recorder.destroy();
});

it('#6975 rejected mapping releases its lease; destroy cancels pending mapping', async () => {
  const gpu = timingDevice();
  const recorder = GpuFrameTimingRecorder.create(gpu.device)!;
  recorder.beginPass('main');
  recorder.endFrame(gpu.encoder());
  const reading = recorder.readback();
  gpu.fail();
  await assert.rejects(reading, /map failed/);
  assert.equal(recorder.beginFrame(), true);
  recorder.beginPass('main');
  recorder.endFrame(gpu.encoder());
  const cancelled = recorder.readback();
  recorder.destroy();
  recorder.destroy();
  await assert.rejects(cancelled, /map cancelled/);
  assert.equal(recorder.beginFrame(), false);
  assert.equal(gpu.queryDestroyed(), true);
  assert.ok(gpu.buffers.every((buffer) => buffer.destroyed && !buffer.mapped && !buffer.pending));
});


it('#6975 toggling while a map is deferred advances resource epochs and cannot append old samples', async () => {
  const owner = new Renderer({} as HTMLCanvasElement), first = timingDevice();
  assert.equal(owner.getGpuFrameTiming?.()?.mode, 'disabled');
  const { configureRendererGpuTiming, beginRendererGpuTiming, renderPassTimestampWrites, submitRendererGpuTiming, readRendererGpuTiming } = await import('./renderer-frame-timing.js');
  configureRendererGpuTiming(owner, true);
  const encoder = first.encoder();
  beginRendererGpuTiming(owner, first.device, encoder);
  renderPassTimestampWrites(encoder, 'old');
  submitRendererGpuTiming(owner, first.device, encoder);
  const oldEpoch = readRendererGpuTiming(owner).epoch;
  configureRendererGpuTiming(owner, false);
  configureRendererGpuTiming(owner, true);
  const replacement = timingDevice(), next = replacement.encoder();
  beginRendererGpuTiming(owner, replacement.device, next);
  renderPassTimestampWrites(next, 'new');
  submitRendererGpuTiming(owner, replacement.device, next);
  replacement.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const snapshot = readRendererGpuTiming(owner);
  assert.ok(snapshot.epoch > oldEpoch);
  assert.equal(snapshot.sampled, 1);
  assert.deepEqual(snapshot.frames.map((frame) => frame.passesMs), [{ new: 2 }]);
  assert.ok(first.buffers.every((buffer) => buffer.destroyed && !buffer.pending));
  configureRendererGpuTiming(owner, false);
});
