/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GpuFramePacer, GPU_FRAMES_IN_FLIGHT, GPU_FRAME_STALE_MS } from './gpuFramePacer.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('GpuFramePacer (#5865)', () => {
  it('lets the loop render until the allowed depth is outstanding, then holds it back', () => {
    const pacer = new GpuFramePacer();
    for (let i = 0; i < GPU_FRAMES_IN_FLIGHT; i++) {
      assert.equal(pacer.saturated(i), false, `frame ${i + 1} may be submitted`);
      pacer.noteSubmit(deferred().promise, i);
    }
    assert.equal(pacer.saturated(GPU_FRAMES_IN_FLIGHT), true);
  });

  it('frees a slot as soon as the GPU reports a frame finished', async () => {
    const pacer = new GpuFramePacer(2);
    const first = deferred();
    pacer.noteSubmit(first.promise, 0);
    pacer.noteSubmit(deferred().promise, 1);
    assert.equal(pacer.saturated(2), true);
    first.resolve();
    await tick();
    assert.equal(pacer.saturated(3), false);
  });

  it('frees the slot of a frame whose completion rejected (device loss)', async () => {
    const pacer = new GpuFramePacer(1);
    const lost = deferred();
    pacer.noteSubmit(lost.promise, 0);
    assert.equal(pacer.saturated(1), true);
    lost.reject(new Error('device lost'));
    await tick();
    assert.equal(pacer.saturated(2), false);
  });

  it('never stops rendering for good when a completion is never reported', () => {
    const pacer = new GpuFramePacer(1);
    pacer.noteSubmit(new Promise<void>(() => undefined), 0);
    assert.equal(pacer.saturated(GPU_FRAME_STALE_MS), true);
    assert.equal(pacer.saturated(GPU_FRAME_STALE_MS + 1), false);
  });
});
