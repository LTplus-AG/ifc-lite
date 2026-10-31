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

  it('never stops rendering for good when a completion is never reported', () => {
    const pacer = new GpuFramePacer(1);
    const device = deviceWith();
    pacer.noteSubmit(device, 0);
    assert.equal(pacer.saturated(device, GPU_FRAME_STALE_MS), true);
    assert.equal(pacer.saturated(device, GPU_FRAME_STALE_MS + 1), false);
  });

  it('releases a never-settling backlog entirely: no refilled window, one probe at a time, pacing back once one settles', async () => {
    let asked = 0;
    const probes: Array<() => void> = [];
    const device: PacedDevice = { queue: { onSubmittedWorkDone: () => { asked++; return new Promise<void>((resolve) => probes.push(resolve)); } } };
    const pacer = new GpuFramePacer(2);
    pacer.noteSubmit(device, 0);
    pacer.noteSubmit(device, 1);
    assert.equal(pacer.saturated(device, 2), true);
    // Expired: released, and it STAYS released however many frames follow (not maxInFlight per expiry).
    let t = GPU_FRAME_STALE_MS + 2;
    for (let i = 0; i < 50; i++, t += 16) {
      assert.equal(pacer.saturated(device, t), false, `frame ${i} is not held back`);
      pacer.noteSubmit(device, t);
    }
    assert.equal(asked, 3, 'two original frames plus a single probe, not a completion request per frame');
    // The probe itself expiring is replaced by a fresh one, so a recovered GPU is still noticed.
    t += GPU_FRAME_STALE_MS + 1;
    assert.equal(pacer.saturated(device, t), false);
    pacer.noteSubmit(device, t);
    assert.equal(asked, 4);
    // A completion arriving proves the GPU reports again: pacing re-engages.
    probes[probes.length - 1]();
    await tick();
    pacer.noteSubmit(device, t + 1);
    pacer.noteSubmit(device, t + 2);
    assert.equal(pacer.saturated(device, t + 3), true);
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
});
