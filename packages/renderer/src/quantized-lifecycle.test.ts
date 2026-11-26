/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { RendererRecoveryHost } from './device-recovery.js';
import { enableRendererQuantizedBatches } from './quantized-lifecycle.js';
import { Scene } from './scene.js';

/** A renderer host whose quantized pipeline probe settles when the test says so. */
function host() {
  const scene = new Scene();
  let settleProbe!: (ok: boolean) => void;
  const pipeline = { ensureQuantizedPipelines: () => new Promise<boolean>((resolve) => { settleProbe = resolve; }) };
  const renderer = { recovery: { quantizedBatchesRequested: false }, pipeline, scene, initGeneration: 1, deviceLossSequence: 0, destroyed: false, deviceLost: false };
  // The pending flag as `setQuantizedBatches` sees it: compact meshes must not decode in between.
  const seen: boolean[] = [];
  const set = scene.setQuantizedBatches.bind(scene);
  scene.setQuantizedBatches = (enabled: boolean) => { seen.push(scene.quantizedBatchesPending); set(enabled); };
  return { scene, renderer, seen, settle: (ok: boolean) => settleProbe(ok), asHost: renderer as unknown as RendererRecoveryHost };
}

it('holds compact meshes queued through the probe until its outcome is applied (lane L9)', async () => {
  const h = host();
  const enabling = enableRendererQuantizedBatches(h.asHost);
  assert.equal(h.scene.quantizedBatchesPending, true, 'waiting from the moment the probe starts');
  h.settle(true);
  assert.equal(await enabling, true);
  assert.deepEqual(h.seen, [true], 'still held when the pipelines are switched on');
  assert.equal(h.scene.quantizedBatchesPending, false);
});

it('releases the hold when the probe fails or its renderer moved on', async () => {
  const failed = host();
  const enabling = enableRendererQuantizedBatches(failed.asHost);
  failed.settle(false);
  assert.equal(await enabling, false);
  assert.equal(failed.scene.quantizedBatchesPending, false, 'the queue decodes to buckets at its next drain');

  const stale = host();
  const superseded = enableRendererQuantizedBatches(stale.asHost);
  stale.renderer.initGeneration++; // a new init owns the next probe
  stale.settle(true);
  assert.equal(await superseded, false);
  assert.deepEqual(stale.seen, [], 'an abandoned probe switches nothing on');
  assert.equal(stale.scene.quantizedBatchesPending, false);
});
