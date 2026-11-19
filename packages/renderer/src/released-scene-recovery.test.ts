/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Renderer } from './index.js';
import type { ReleasedSceneRebuildContext } from './released-scene-recovery.js';

(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getBoundingClientRect: () => ({ width: 64, height: 64 }) } as unknown as HTMLCanvasElement;
}

/** A lost renderer whose scene released its CPU geometry. */
function lostReleasedRenderer() {
  const renderer = new Renderer(canvas());
  const calls: string[] = [];
  renderer['deviceLost'] = true;
  renderer['deviceLostGeneration'] = renderer['initGeneration'];
  renderer['scene']['prepareDeviceRecovery'] = () => ({ ok: false, reason: 'cpu-geometry-released' }) as never;
  renderer['scene']['discardGpuResourcesForRecovery'] = () => { calls.push('discard'); };
  renderer['scene']['resetReleasedForRebuild'] = () => { calls.push('reset'); };
  renderer['scene']['restoreGpuResourcesAfterRecovery'] = () => { throw new Error('a released scene has no CPU pieces to restore'); };
  renderer['refreshPlacementBounds'] = () => { calls.push('bounds'); };
  renderer['teardown'] = () => { renderer['ready'] = false; renderer['pipeline'] = null; };
  renderer['initOnce'] = async () => {
    calls.push('init');
    renderer['pipeline'] = { replacement: true } as never;
    const device = renderer['device'] as unknown as { device: GPUDevice; context: GPUCanvasContext };
    device.device = { replacement: true } as unknown as GPUDevice;
    device.context = {} as GPUCanvasContext;
  };
  return { renderer, calls };
}

describe('released scene device recovery (#10264)', () => {
  it('is refused without a registered rebuild, as before', async () => {
    const { renderer } = lostReleasedRenderer();
    assert.deepStrictEqual(await renderer.recoverDevice(), { ok: false, reason: 'cpu-geometry-released' });
  });

  it('rebuilds through the replacement device before readiness, keeping placements', async () => {
    const { renderer, calls } = lostReleasedRenderer();
    let seen: ReleasedSceneRebuildContext | undefined;
    let readyDuringRebuild: boolean | undefined;
    renderer.setReleasedSceneRebuild(async (context) => {
      seen = context;
      readyDuringRebuild = renderer.isReady();
      calls.push('rebuild');
      return context.isCurrent();
    });
    const result = await renderer.recoverDevice();
    assert.deepStrictEqual(result, { ok: true, omissions: [] });
    assert.deepStrictEqual(calls, ['discard', 'init', 'reset', 'rebuild', 'bounds'], 'reset (not clear) runs after the new device, before the rebuild');
    assert.equal(readyDuringRebuild, false, 'nothing may draw or pick a half-rebuilt scene');
    assert.deepStrictEqual(seen?.device, { replacement: true }, 'the rebuild uploads through the replacement device');
    assert.deepStrictEqual(seen?.pipeline, { replacement: true });
    assert.equal(seen?.scene, renderer.getScene());
    assert.equal(renderer.isDeviceLost(), false);
    assert.equal(renderer.isReady(), true);
  });

  it('keeps no restaged instance template vertices on the CPU', async () => {
    const { renderer } = lostReleasedRenderer();
    const template = { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array(3) };
    renderer.setReleasedSceneRebuild(async () => {
      (renderer.getScene() as unknown as { instancedTemplateCpu: unknown[] }).instancedTemplateCpu = [template];
      return true;
    });
    assert.equal((await renderer.recoverDevice()).ok, true);
    assert.equal(template.positions.length + template.normals.length + template.indices.length, 0, 'released like the original release did');
  });

  it('an incomplete rebuild leaves the renderer lost and reports a retryable failure', async () => {
    const { renderer } = lostReleasedRenderer();
    renderer.setReleasedSceneRebuild(async () => false);
    const result = await renderer.recoverDevice();
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'scene-restore-failed');
    assert.equal(renderer.isDeviceLost(), true);
    assert.equal(renderer.isReady(), false);
  });

  it('a loss of the replacement device during the rebuild fences it and fails', async () => {
    const { renderer } = lostReleasedRenderer();
    let currentAfterLoss: boolean | undefined;
    renderer.setReleasedSceneRebuild(async (context) => {
      renderer['deviceLossSequence']++; // the replacement's own device.lost settled
      currentAfterLoss = context.isCurrent();
      return true;
    });
    const result = await renderer.recoverDevice();
    assert.equal(currentAfterLoss, false, 'every later batch sees the fence');
    assert.equal(result.ok, false);
    assert.equal(renderer.isReady(), false);
  });

  it('a destroy during the rebuild supersedes it without publishing readiness', async () => {
    const { renderer } = lostReleasedRenderer();
    renderer.setReleasedSceneRebuild(async () => { renderer['destroyed'] = true; return true; });
    const result = await renderer.recoverDevice();
    assert.deepStrictEqual(result, { ok: false, reason: 'renderer-destroyed' });
    assert.equal(renderer.isReady(), false);
  });

  it('clearing the rebuild refuses again', async () => {
    const { renderer } = lostReleasedRenderer();
    renderer.setReleasedSceneRebuild(async () => true);
    renderer.setReleasedSceneRebuild(null);
    assert.deepStrictEqual(await renderer.recoverDevice(), { ok: false, reason: 'cpu-geometry-released' });
  });
});

describe('Scene.resetReleasedForRebuild (#10264)', () => {
  it('drops flat and instanced state but keeps per-model placements', async () => {
    const { Scene } = await import('./scene.js');
    const scene = new Scene();
    assert.equal(scene.setModelTranslation(2, [5, 0, -3]), true);
    const before = JSON.stringify(scene.getModelTranslation(2));
    scene.setEphemeralStreamingMode(true);
    scene.resetReleasedForRebuild();
    assert.equal(JSON.stringify(scene.getModelTranslation(2)), before, 'placements survive: the rebuild re-places by model index');
    assert.equal(scene.isEphemeralStreaming(), false, 'the rebuild starts its own streaming pass');
    assert.deepStrictEqual(scene.getInstancedModelIndices(), []);
    scene.clear();
    assert.notEqual(JSON.stringify(scene.getModelTranslation(2)), before, 'whereas a full clear forgets them');
  });
});
