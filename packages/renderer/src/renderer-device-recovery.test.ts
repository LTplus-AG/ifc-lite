/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { Renderer } from './index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getBoundingClientRect: () => ({ width: 64, height: 64 }) } as unknown as HTMLCanvasElement;
}

function lostRenderer() {
  const renderer = new Renderer(canvas());
  renderer['deviceLost'] = true;
  renderer['deviceLostGeneration'] = renderer['initGeneration'];
  renderer['scene']['discardGpuResourcesForRecovery'] = () => {};
  renderer['scene']['restoreGpuResourcesAfterRecovery'] = () => {};
  renderer['refreshPlacementBounds'] = () => {};
  renderer['teardown'] = () => { renderer['ready'] = false; renderer['pipeline'] = null; };
  renderer['initOnce'] = async () => {
    renderer['pipeline'] = {} as never;
    const device = renderer['device'] as unknown as { device: GPUDevice; context: GPUCanvasContext };
    device.device = {} as GPUDevice;
    device.context = {} as GPUCanvasContext;
  };
  return renderer;
}

describe('Renderer.recoverDevice (#4885)', () => {
  it('rejects a healthy renderer without touching its scene', async () => {
    const renderer = new Renderer(canvas());
    const discard = mock.method(renderer['scene'], 'discardGpuResourcesForRecovery');
    assert.deepStrictEqual(await renderer.recoverDevice(), { ok: false, reason: 'not-lost' });
    assert.strictEqual(discard.mock.calls.length, 0);
  });

  it('coalesces callers and publishes readiness only after scene restore', async () => {
    const renderer = lostRenderer(), gate = deferred<void>();
    const camera = renderer.getCamera();
    camera.setPosition(10, 20, 30);
    camera.setProjectionMode('orthographic');
    renderer['_activePickSection'] = { normal: [0, 1, 0], distance: 4, flipped: true };
    let restoreFinished = false;
    renderer['scene']['restoreGpuResourcesAfterRecovery'] = () => { restoreFinished = true; };
    renderer['initOnce'] = async () => {
      const device = renderer['device'] as unknown as { device: GPUDevice; context: GPUCanvasContext };
      device.device = {} as GPUDevice;
      device.context = {} as GPUCanvasContext;
      renderer['pipeline'] = {} as never;
      await gate.promise;
    };

    const first = renderer.recoverDevice(), second = renderer.recoverDevice();
    assert.strictEqual(first, second, 'concurrent recovery calls must share one replacement attempt');
    assert.strictEqual(renderer.isReady(), false);
    gate.resolve();
    const result = await first;

    assert.deepStrictEqual(result, { ok: true, omissions: [] });
    assert.strictEqual(restoreFinished, true);
    assert.strictEqual(renderer.isReady(), true);
    assert.strictEqual(renderer.isDeviceLost(), false);
    assert.strictEqual(renderer.getCamera(), camera, 'recovery must not replace the camera');
    assert.deepStrictEqual(camera.getPosition(), { x: 10, y: 20, z: 30 });
    assert.strictEqual(camera.getProjectionMode(), 'orthographic');
    assert.deepStrictEqual(renderer['_activePickSection'], { normal: [0, 1, 0], distance: 4, flipped: true });
  });

  it('reports transient GPU-only content as explicit omissions', async () => {
    const renderer = lostRenderer();
    renderer['recovery'].lostReferenceImages = true;
    renderer['pointCloudRenderer'] = { hasAssets: () => true } as never;
    renderer['overlays']['recoveryOmissions'] = () => ['line-overlays', 'symbolic-overlays'];
    assert.deepStrictEqual(await renderer.recoverDevice(), {
      ok: true,
      omissions: ['line-overlays', 'symbolic-overlays', 'reference-images', 'point-clouds'],
    });
  });

  it('preserves omissions when a failed replacement is retried (#4885)', async () => {
    const renderer = lostRenderer();
    let assetsPresent = true;
    renderer['pointCloudRenderer'] = { hasAssets: () => assetsPresent } as never;
    renderer['initOnce'] = async () => { assetsPresent = false; throw new Error('first replacement failed'); };
    const error = mock.method(console, 'error', () => undefined);
    try {
      assert.strictEqual((await renderer.recoverDevice()).ok, false);
      renderer['initOnce'] = async () => {
        renderer['pipeline'] = {} as never;
        const device = renderer['device'] as unknown as { device: GPUDevice; context: GPUCanvasContext };
        device.device = {} as GPUDevice; device.context = {} as GPUCanvasContext;
      };
      assert.deepStrictEqual(await renderer.recoverDevice(), { ok: true, omissions: ['point-clouds'] });
    } finally {
      error.mock.restore();
    }
  });

  it('recomputes bounds after omitted GPU-only layers are destroyed and before readiness', async () => {
    const renderer = lostRenderer();
    const order: string[] = [];
    renderer['scene']['restoreGpuResourcesAfterRecovery'] = () => { order.push('restore'); };
    renderer['refreshPlacementBounds'] = () => { order.push('bounds'); };
    renderer['markReady'] = () => { order.push('ready'); renderer['ready'] = true; };

    assert.strictEqual((await renderer.recoverDevice()).ok, true);
    assert.deepStrictEqual(order, ['restore', 'bounds', 'ready']);
  });

  it('re-probes quantized pipelines before rebuilding quantized scene buffers', async () => {
    const renderer = lostRenderer();
    let probes = 0, sceneEnabled: boolean | undefined;
    renderer['recovery'].quantizedBatchesRequested = true;
    renderer['initOnce'] = async () => {
      const device = renderer['device'] as unknown as { device: GPUDevice; context: GPUCanvasContext };
      device.device = {} as GPUDevice;
      device.context = {} as GPUCanvasContext;
      renderer['pipeline'] = { ensureQuantizedPipelines: async () => { probes++; return true; } } as never;
    };
    renderer['scene']['setQuantizedBatches'] = (enabled) => { sceneEnabled = enabled; };
    assert.strictEqual((await renderer.recoverDevice()).ok, true);
    assert.strictEqual(probes, 1);
    assert.strictEqual(sceneEnabled, true);
  });

  it('stays lost after replacement-device failure and can be retried', async () => {
    const renderer = lostRenderer();
    renderer['initOnce'] = async () => { throw new Error('adapter unavailable'); };
    const error = mock.method(console, 'error', () => undefined);
    try {
      const failed = await renderer.recoverDevice();
      assert.strictEqual(failed.ok, false);
      if (!failed.ok) assert.strictEqual(failed.reason, 'device-init-failed');
      assert.strictEqual(renderer.isDeviceLost(), true);
      await assert.rejects(renderer.whenReady(), { name: 'RendererDeviceLostError' });

      renderer['initOnce'] = async () => {
        const device = renderer['device'] as unknown as { device: GPUDevice; context: GPUCanvasContext };
        device.device = {} as GPUDevice;
        device.context = {} as GPUCanvasContext;
        renderer['pipeline'] = {} as never;
      };
      assert.deepStrictEqual(await renderer.recoverDevice(), { ok: true, omissions: [] });
    } finally {
      error.mock.restore();
    }
  });

  it('does not publish success when the replacement device is lost during initialization', async () => {
    const renderer = lostRenderer();
    renderer['initOnce'] = async () => {
      renderer['pipeline'] = {} as never;
      renderer['handleDeviceLost']({ message: 'replacement lost', reason: 'unknown' });
    };
    const error = mock.method(console, 'error', () => undefined);
    try {
      const result = await renderer.recoverDevice();
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.reason, 'device-init-failed');
      assert.strictEqual(renderer.isDeviceLost(), true);
      assert.strictEqual(renderer.isReady(), false);
    } finally {
      error.mock.restore();
    }
  });

  it('revalidates scene blockers after replacement initialization', async () => {
    const renderer = lostRenderer();
    renderer['initOnce'] = async () => {
      const device = renderer['device'] as unknown as { device: GPUDevice; context: GPUCanvasContext };
      device.device = {} as GPUDevice;
      device.context = {} as GPUCanvasContext;
      renderer['pipeline'] = {} as never;
      renderer['scene']['meshes'].push({ hydrated: false } as never);
    };

    assert.deepStrictEqual(await renderer.recoverDevice(), {
      ok: false,
      reason: 'unsupported-authored-meshes',
    });
    assert.strictEqual(renderer.isDeviceLost(), true);
    assert.strictEqual(renderer.isReady(), false);
  });

  it('observes a replacement loss queued during synchronous scene restore', async () => {
    const renderer = lostRenderer();
    renderer['scene']['restoreGpuResourcesAfterRecovery'] = () => {
      queueMicrotask(() => renderer['handleDeviceLost']({
        message: 'replacement lost during restore',
        reason: 'unknown',
      }));
    };
    const error = mock.method(console, 'error', () => undefined);
    const warn = mock.method(console, 'warn', () => undefined);
    try {
      const result = await renderer.recoverDevice();
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.reason, 'scene-restore-failed');
      assert.strictEqual(renderer.isDeviceLost(), true);
      assert.strictEqual(renderer.isReady(), false);
    } finally {
      error.mock.restore();
      warn.mock.restore();
    }
  });

  it('invalidates a recovery completion when destroy wins the race', async () => {
    const renderer = lostRenderer(), gate = deferred<void>();
    renderer['initOnce'] = async () => { await gate.promise; };
    const recovery = renderer.recoverDevice();
    await Promise.resolve();
    renderer.destroy();
    gate.resolve();
    assert.deepStrictEqual(await recovery, { ok: false, reason: 'renderer-destroyed' });
    assert.strictEqual(renderer.isReady(), false);
  });

  it('serializes a newer public init behind recovery so it owns the final GPU stack', async () => {
    const renderer = lostRenderer(), gate = deferred<void>(), started = deferred<void>();
    const replacementPipeline = { owner: 'newer-init' };
    let calls = 0;
    renderer['initOnce'] = async (generation) => {
      calls++;
      if (calls === 1) {
        started.resolve();
        await gate.promise;
        return;
      }
      const device = renderer['device'] as unknown as { device: GPUDevice; context: GPUCanvasContext };
      device.device = {} as GPUDevice;
      device.context = {} as GPUCanvasContext;
      renderer['pipeline'] = replacementPipeline as never;
      renderer['deviceLost'] = false;
      renderer['markReady'](generation);
    };

    const recovery = renderer.recoverDevice();
    await started.promise;
    const initialization = renderer.init();
    await Promise.resolve();
    assert.strictEqual(calls, 1, 'init must wait for recovery to release lifecycle ownership');

    gate.resolve();
    assert.deepStrictEqual(await recovery, { ok: false, reason: 'renderer-destroyed' });
    await initialization;
    assert.strictEqual(renderer['pipeline'], replacementPipeline);
    assert.strictEqual(renderer.isReady(), true);
  });
});
