/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GpuFramePacer, GPU_FRAMES_IN_FLIGHT, GPU_FRAME_STALE_MS, type PacedDevice } from './gpuFramePacer.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/** A device whose queue hands out the given completion promises, in order. */
function deviceWith(...completions: Array<Promise<unknown>>): PacedDevice {
  const queue = [...completions];
  return { queue: { onSubmittedWorkDone: () => queue.shift() ?? new Promise<void>(() => undefined) } };
}

describe('GpuFramePacer (#5865)', () => {
  it('lets the loop render until the allowed depth is outstanding, then holds it back', () => {
    const pacer = new GpuFramePacer();
    const device = deviceWith();
    for (let i = 0; i < GPU_FRAMES_IN_FLIGHT; i++) {
      assert.equal(pacer.saturated(device, i), false, `frame ${i + 1} may be submitted`);
      pacer.noteSubmit(device, i);
    }
    assert.equal(pacer.saturated(device, GPU_FRAMES_IN_FLIGHT), true);
  });

  it('frees a slot as soon as the GPU reports a frame finished', async () => {
    const pacer = new GpuFramePacer(2);
    const first = deferred();
    const device = deviceWith(first.promise);
    pacer.noteSubmit(device, 0);
    pacer.noteSubmit(device, 1);
    assert.equal(pacer.saturated(device, 2), true);
    first.resolve();
    await tick();
    assert.equal(pacer.saturated(device, 3), false);
  });

  it('frees the slot of a frame whose completion rejected', async () => {
    const pacer = new GpuFramePacer(1);
    const lost = deferred();
    const device = deviceWith(lost.promise);
    pacer.noteSubmit(device, 0);
    assert.equal(pacer.saturated(device, 1), true);
    lost.reject(new Error('device lost'));
    await tick();
    assert.equal(pacer.saturated(device, 2), false);
  });

  it('a never-reporting GPU renders about maxInFlight frames per expiry, by design (bounded backlog over frame rate)', () => {
    const pacer = new GpuFramePacer(1);
    const device = deviceWith();
    pacer.noteSubmit(device, 0);
    assert.equal(pacer.saturated(device, GPU_FRAME_STALE_MS), true);
    assert.equal(pacer.saturated(device, GPU_FRAME_STALE_MS + 1), false);
  });

  it('forgets the frames of a lost device once a recovered one is in use', () => {
    const pacer = new GpuFramePacer(1);
    const before = deviceWith();
    pacer.noteSubmit(before, 0);
    assert.equal(pacer.saturated(before, 1), true);
    assert.equal(pacer.saturated(null, 2), false, 'no device (lost): nothing to be behind');
    assert.equal(pacer.saturated(deviceWith(), 3), false, 'the recovered device starts with no backlog');
  });

  it('does not let a throwing onSubmittedWorkDone() escape, and does not count that frame', () => {
    const pacer = new GpuFramePacer(1);
    const realWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const dying: PacedDevice = { queue: { onSubmittedWorkDone: () => { throw new Error('device destroyed'); } } };
      pacer.noteSubmit(dying, 0);
      pacer.noteSubmit(dying, 1);
      assert.equal(pacer.saturated(dying, 2), false);
      assert.equal(warnings.length, 1, 'one warning, not one per frame');
    } finally { console.warn = realWarn; }
  });

  // Expiry cannot tell a dead GPU from a slow one, so a slow-but-completing GPU (a stall longer than
  // the expiry, or software WebGPU at seconds per frame) must keep a BOUNDED queue: a FIFO GPU that
  // owes the page every frame ever submitted, with the loop offering a frame every 16 ms.
  async function maxQueueDepth(serviceMs: (frame: number) => number, runMs: number): Promise<number> {
    const pacer = new GpuFramePacer();
    const owed: Array<{ finishAt: number; settle: () => void }> = [];
    const finishTimes: number[] = []; // every frame the GPU owes, whether or not the pacer asked about it
    let gpuFreeAt = 0;
    let frames = 0;
    let deepest = 0;
    const device: PacedDevice = { queue: { onSubmittedWorkDone: () => new Promise<void>((resolve) => {
      owed.push({ finishAt: gpuFreeAt, settle: resolve });
    }) } };
    for (let now = 0; now <= runMs; now += 16) {
      for (const done of owed.filter((o) => o.finishAt <= now)) { done.settle(); owed.splice(owed.indexOf(done), 1); }
      await tick();
      if (pacer.saturated(device, now)) continue;
      gpuFreeAt = Math.max(gpuFreeAt, now) + serviceMs(frames++);
      finishTimes.push(gpuFreeAt);
      pacer.noteSubmit(device, now);
      deepest = Math.max(deepest, finishTimes.filter((at) => at > now).length);
    }
    return deepest;
  }

  it('keeps the GPU queue bounded through a stall longer than the expiry (slow but completing GPU)', async () => {
    const depth = await maxQueueDepth((frame) => (frame === 0 ? 6000 : 1), 60_000);
    assert.ok(depth <= 2 * GPU_FRAMES_IN_FLIGHT, `queue grew to ${depth} frames`);
  });

  it('keeps the queue at the allowed depth for 10 minutes on a GPU that completes faster than the refill (1.5 s per frame)', async () => {
    const depth = await maxQueueDepth(() => 1500, 600_000);
    assert.equal(depth, GPU_FRAMES_IN_FLIGHT);
  });

  it('bounds the queue over ONE MINUTE at 2 s per frame, but that window hides slow growth: slower than about 1.7 s per frame the refill outruns completions (see the pacer comment)', async () => {
    // Not a steady-state bound. Over ten minutes the same GPU queues about 60 frames and over an hour
    // about 360; this window only shows the first minute (depth 9). The 0.1 frame per second growth is
    // inherent in the per-expiry refill and is recorded as a known limit, not asserted away.
    const depth = await maxQueueDepth(() => 2000, 60_000);
    assert.ok(depth <= 3 * GPU_FRAMES_IN_FLIGHT, `queue grew to ${depth} frames`);
  });
});
