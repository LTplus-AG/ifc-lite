/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';

/**
 * #6436: `flushPending` drains the upload queue in time slices. While geometry
 * streams the slice stays short, so the main thread keeps serving the worker
 * pump; once nothing competes, a caller may grant a longer slice so the queue
 * left behind a large stream drains in fewer frames.
 */
describe('Scene.flushPending time slice (#6436)', () => {
  afterEach(() => mock.restoreAll());

  function sceneWithQueue(meshCount: number): { scene: Scene; appends: () => number } {
    let clock = 0;
    let appends = 0;
    mock.method(performance, 'now', () => clock);
    const scene = new Scene();
    const meshes = Array.from({ length: meshCount }, (_, i) => ({
      expressId: i + 1,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
    }) as unknown as MeshData);
    scene.queueMeshes(meshes);
    // Each append (one bounded chunk) takes 10 ms of the slice.
    (scene as unknown as { appendToBatches: () => void }).appendToBatches = () => {
      appends++;
      clock += 10;
    };
    return { scene, appends: () => appends };
  }

  const device = {} as GPUDevice;
  const pipeline = {} as RenderPipeline;

  it('keeps the 12 ms streaming slice by default', () => {
    const { scene, appends } = sceneWithQueue(4096);
    scene.flushPending(device, pipeline);
    assert.equal(appends(), 2, 'appends at 0 ms and 10 ms, then the 12 ms slice is spent');
    assert.ok(scene.hasQueuedMeshes());
  });

  it('drains more per call when the caller grants a longer slice', () => {
    const { scene, appends } = sceneWithQueue(4096);
    scene.flushPending(device, pipeline, 32);
    assert.equal(appends(), 4, 'appends at 0, 10, 20 and 30 ms, then the 32 ms slice is spent');
  });
});
