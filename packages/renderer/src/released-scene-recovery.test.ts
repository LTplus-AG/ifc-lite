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
  renderer['initOnce'] = async (generation: number) => {
    renderer['recovery'].initStartedGeneration = generation; // as the real initOnce records
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

  it('#10937 an incomplete first attempt, then a complete retry, restores the ORIGINAL pre-loss instanced membership', async () => {
    const { renderer } = lostReleasedRenderer();
    const scene = renderer.getScene() as unknown as { getInstancedModelIndices: () => number[] };
    let templates = [0, 2]; // the scene drew instancing of models 0 and 2 before the loss
    scene.getInstancedModelIndices = () => templates;
    renderer['scene']['resetReleasedForRebuild'] = () => { templates = []; }; // the failed attempt's reset removes them
    const seen: number[][] = [];
    let complete = false;
    renderer.setReleasedSceneRebuild(async (context) => { seen.push([...context.instancedModelIndices].sort()); return complete; });
    assert.equal((await renderer.recoverDevice()).ok, false, 'the backing was incomplete');
    complete = true;
    assert.equal((await renderer.recoverDevice()).ok, true);
    assert.deepStrictEqual(seen, [[0, 2], [0, 2]], 'the retry restages what the scene drew before the loss, never the emptied set');
    templates = [5];
    (renderer.getScene() as unknown as { clear: () => void }).clear(); // a successor scene: new content
    renderer['deviceLost'] = true;
    renderer['deviceLostGeneration'] = renderer['initGeneration'];
    await renderer.recoverDevice();
    assert.deepStrictEqual(seen.at(-1), [5], 'after a successful recovery and a successor, the membership is captured fresh');
  });

  for (const whole of [true, false]) {
    it(`#10937 a stale recovery (rebuild ${whole ? 'whole' : 'incomplete'}) whose newer init already built never tears that init down`, async () => {
      const { renderer } = lostReleasedRenderer();
      let resume!: () => void;
      const gate = new Promise<void>((done) => { resume = done; });
      renderer.setReleasedSceneRebuild(async () => { await gate; return whole; });
      const recovering = renderer.recoverDevice();
      await new Promise((done) => setTimeout(done, 0)); // the rebuild awaits its backing
      // A newer public init starts and completes while the old recovery waits.
      const newer = ++renderer['initGeneration'];
      await renderer['initOnce'](newer);
      const built = { newer: true };
      renderer['pipeline'] = built as never;
      renderer['deviceLost'] = false;
      renderer['ready'] = true;
      let teardowns = 0;
      renderer['teardown'] = () => { teardowns++; renderer['ready'] = false; renderer['pipeline'] = null; };
      resume();
      const result = await recovering;
      assert.equal(result.ok, false, 'the stale recovery is superseded');
      assert.equal(teardowns, 0, "it never tears down the newer init's state");
      assert.equal(renderer['pipeline'], built, "the newer init's pipeline survives");
      assert.equal(renderer.isReady(), true, 'and stays ready');
      assert.equal(renderer.isDeviceLost(), false, 'never latched lost by the stale recovery');
    });
  }

  it('#10937 scene.clear() during the awaited instanced read: no restage, no readiness, and the successor content is never torn down', async () => {
    const { renderer } = lostReleasedRenderer();
    let resume!: () => void;
    const gate = new Promise<void>((done) => { resume = done; });
    let restaged = 0, clearingTeardowns = 0;
    renderer['teardown'] = (clearScene = true) => { if (clearScene) clearingTeardowns++; renderer['ready'] = false; renderer['pipeline'] = null; };
    renderer.setReleasedSceneRebuild(async (context) => {
      await gate; // reading the backing's instanced shards
      if (!context.isCurrent()) return false; // the host stops at the fence
      restaged++;
      return true;
    });
    const recovering = renderer.recoverDevice();
    await new Promise((done) => setTimeout(done, 0));
    renderer.getScene().clear(); // a new load (successor content) clears the same scene object
    resume();
    const result = await recovering;
    assert.equal(result.ok, false, 'the rebuild of the old content is stale');
    assert.equal(restaged, 0, 'the removed model is never restaged');
    assert.equal(renderer.isReady(), false, 'never published ready for the cleared content');
    assert.equal(clearingTeardowns, 0, "the successor's scene content is never torn down");
  });

  it('#10937 an incomplete recovery, then a reshape that drops model B: the retry never resurrects B', async () => {
    const { renderer } = lostReleasedRenderer();
    const scene = renderer.getScene() as unknown as { getInstancedModelIndices: () => number[]; clearFlatGeometryForRebuild(g: unknown[], present: ReadonlySet<number>): void };
    let templates = [0, 2]; // A (0) and B (2) drew instancing before the loss
    scene.getInstancedModelIndices = () => templates;
    renderer['scene']['resetReleasedForRebuild'] = () => { templates = []; }; // the failed attempt's reset
    const seen: number[][] = [];
    let complete = false;
    renderer.setReleasedSceneRebuild(async (context) => { seen.push([...context.instancedModelIndices].sort()); return complete; });
    assert.equal((await renderer.recoverDevice()).ok, false, 'the first attempt is incomplete');
    // A reshape (B hidden, still in the store) keeps only A's templates. B's are already gone, so its
    // removal loop finds nothing to remove: only the reshape's present set says B left.
    scene.clearFlatGeometryForRebuild([], new Set([0]));
    complete = true;
    assert.equal((await renderer.recoverDevice()).ok, true);
    assert.deepStrictEqual(seen, [[0, 2], [0]], 'the retry restages A only; B is not resurrected');
  });

  it('#10937 a direct template removal of model 2 during the awaited shard read: no resurrection, no readiness; the retry restages without it', async () => {
    const { renderer } = lostReleasedRenderer();
    const scene = renderer.getScene() as unknown as { getInstancedModelIndices: () => number[] };
    scene.getInstancedModelIndices = () => [0, 2];
    let resume!: () => void;
    const gate = new Promise<void>((done) => { resume = done; });
    const restaged: number[] = [];
    const seen: number[][] = [];
    let attempt = 0;
    renderer.setReleasedSceneRebuild(async (context) => {
      seen.push([...context.instancedModelIndices].sort());
      if (++attempt === 1) await gate; // storing / reading the backed shards
      for (const index of context.instancedModelIndices) { if (!context.isCurrent()) return false; restaged.push(index); }
      return true;
    });
    const recovering = renderer.recoverDevice();
    await new Promise((done) => setTimeout(done, 0));
    renderer.getScene().removeInstancedTemplatesForModel(2); // model 2 removed while the rebuild awaits
    resume();
    const result = await recovering;
    assert.equal(result.ok, false, 'the rebuild over the stale membership is not whole');
    assert.equal(renderer.isReady(), false, 'never published ready');
    assert.deepEqual(restaged, [], 'nothing restaged over the stale membership, model 2 least of all');
    assert.equal((await renderer.recoverDevice()).ok, true, 'a retry over the current membership succeeds');
    assert.deepEqual(seen.at(-1), [0], 'and never resurrects model 2');
    assert.deepEqual(restaged, [0]);
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

  for (const by of ['init', 'destroy'] as const) {
    it(`a rebuild that REJECTS after a newer ${by} is superseded, not a failure of the newer lifecycle`, async () => {
      const { renderer } = lostReleasedRenderer();
      let teardownsAfterSupersede = 0;
      renderer.setReleasedSceneRebuild(async () => {
        await Promise.resolve();
        if (by === 'init') renderer['initGeneration']++; else renderer['destroyed'] = true;
        const teardown = renderer['teardown'];
        renderer['teardown'] = (clear?: boolean) => { if (!clear) teardownsAfterSupersede++; teardown(clear); };
        throw new Error('backing read failed after the recovery was superseded');
      });
      const result = await renderer.recoverDevice();
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, 'renderer-destroyed', 'superseded, never scene-restore-failed');
      if (by === 'init') assert.equal(!result.ok && result.superseded, true);
      assert.equal(teardownsAfterSupersede, 0, 'no failure teardown of the newer lifecycle');
    });
  }

  it('#10937 hands the rebuild exactly the instanced model indices the scene held before the loss', async () => {
    const { renderer } = lostReleasedRenderer();
    let held = [2, 5];
    renderer['scene']['getInstancedModelIndices'] = () => held;
    renderer['scene']['discardGpuResourcesForRecovery'] = () => { held = []; }; // the discard empties the template list
    let seen: ReadonlySet<number> | undefined;
    renderer.setReleasedSceneRebuild(async (context) => { seen = context.instancedModelIndices; return true; });
    assert.equal((await renderer.recoverDevice()).ok, true);
    assert.deepStrictEqual([...(seen ?? [])].sort(), [2, 5], 'captured before the discard, so a hidden model stays out');
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
