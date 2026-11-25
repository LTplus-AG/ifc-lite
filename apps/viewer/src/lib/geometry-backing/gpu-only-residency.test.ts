/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createStore } from 'zustand/vanilla';
import type { Renderer } from '@ifc-lite/renderer';
import { existsSync } from 'node:fs';
import type { GpuOnlyDeps, GpuOnlyState } from './gpu-only-residency';
import type { StoreGeometryBackingTap } from './store-backing-tap';

// Loaded after asserting the modules exist, so a reverted change fails on an assertion rather than as
// a file that cannot load.
async function load() {
  for (const file of ['gpu-only-mode.ts', 'gpu-only-residency.ts', 'active-backing.ts']) {
    assert.ok(existsSync(new URL(`./${file}`, import.meta.url)), `lib/geometry-backing/${file} must exist`);
  }
  return { ...await import('./gpu-only-mode'), ...await import('./gpu-only-residency'), ...await import('./active-backing') };
}

type Model = GpuOnlyState['models'] extends ReadonlyMap<string, infer M> ? M : never;
/** The store fields the controller touches, plus the mode it sets. */
type TestState = GpuOnlyState & { boundedGeometryMode: boolean };
const flagHost = globalThis as { __IFC_LITE_GPU_ONLY?: unknown; __ifc_lite_gpu_only_status__?: unknown };
afterEach(() => { delete flagHost.__IFC_LITE_GPU_ONLY; });

/** Let the controller's promise chains run. */
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function harness(options: { requested?: boolean; runningTap?: boolean; startFails?: boolean; releaseFails?: boolean; renderer?: boolean; releaseGate?: Promise<void> } = {}) {
  const log: string[] = [];
  const store = createStore<TestState>((set) => ({
    models: new Map<string, Model>(),
    geometryContentVersion: 0,
    boundedGeometryMode: false,
    setBoundedGeometryMode: (bounded: boolean) => { log.push(`bounded ${bounded}`); set({ boundedGeometryMode: bounded }); },
  }));
  const tap = { name: 'tap' } as unknown as StoreGeometryBackingTap;
  const waiting: Array<{ done: (settled: boolean) => void; isCurrent: () => boolean; cancelled: boolean }> = [];
  let clock = 0;
  const deps: GpuOnlyDeps = {
    requested: () => options.requested ?? true,
    tapInUse: () => options.runningTap ?? false,
    startTap: async () => { log.push('start tap'); if (options.startFails) throw new Error('IndexedDB unavailable'); return tap; },
    stopTap: async () => { log.push('stop tap'); },
    release: async () => { log.push('release'); await options.releaseGate; if (options.releaseFails) throw new Error('no verified complete backing'); },
    renderer: () => (options.renderer === false ? null : ({} as Renderer)),
    whenSettled: (done, isCurrent) => {
      const entry = { done, isCurrent, cancelled: false };
      waiting.push(entry);
      return () => { entry.cancelled = true; };
    },
    now: () => (clock += 100),
  };
  const { GpuOnlyResidency } = await load();
  const controller = new GpuOnlyResidency(store, deps);
  const uninstall = controller.install();
  const setModel = (id: string, model: Model | null): void => {
    const models = new Map(store.getState().models);
    if (model) models.set(id, model); else models.delete(id);
    store.setState({ models });
  };
  const pending = (fileSize = 100): Model => ({ geometryResult: null, fileSize, loadState: 'pending' });
  const loaded = (loadState = 'complete'): Model => ({ geometryResult: { meshes: [] }, fileSize: 100, loadState });
  return { controller, store, log, waiting, setModel, pending, loaded, uninstall };
}

describe('perf.gpuOnly switch', () => {
  it('is off unless set, and auto arms only sources of 64 MiB or more', async () => {
    const { GPU_ONLY_AUTO_BYTES, gpuOnlyMode, gpuOnlyRequested } = await load();
    assert.equal(gpuOnlyMode(), 'off');
    assert.equal(gpuOnlyRequested(10 * GPU_ONLY_AUTO_BYTES), false);
    for (const [value, mode] of [['on', 'on'], [1, 'on'], ['true', 'on'], ['auto', 'auto'], ['AUTO', 'auto'], ['off', 'off'], [0, 'off'], ['yes', 'off']] as const) {
      flagHost.__IFC_LITE_GPU_ONLY = value;
      assert.equal(gpuOnlyMode(), mode, String(value));
    }
    flagHost.__IFC_LITE_GPU_ONLY = 'on';
    assert.equal(gpuOnlyRequested(1), true);
    flagHost.__IFC_LITE_GPU_ONLY = 'auto';
    assert.equal(gpuOnlyRequested(GPU_ONLY_AUTO_BYTES - 1), false);
    assert.equal(gpuOnlyRequested(GPU_ONLY_AUTO_BYTES), true);
  });

  it('installs nothing while off: no controller is fetched and no status hook appears', async () => {
    (await load()).installGpuOnlyResidency();
    await settle();
    assert.equal(flagHost.__ifc_lite_gpu_only_status__, undefined);
  });
});

describe('GpuOnlyResidency', () => {
  it('backs an armed primary load from its placeholder and releases once it completed and the scene settled', async () => {
    const h = await harness();
    h.setModel('a', h.pending());
    await settle();
    assert.deepEqual(h.log, ['start tap', 'bounded true']);
    assert.deepEqual(h.controller.status(), { modelId: 'a', phase: 'streaming' });

    h.setModel('a', h.loaded('streaming-geometry'));
    h.setModel('a', h.loaded('hydrating-metadata'));
    assert.equal(h.waiting.length, 0, 'nothing waits for the scene before the load completed');
    h.setModel('a', h.loaded());
    h.setModel('a', h.loaded()); // a later store change does not start a second wait
    assert.equal(h.waiting.length, 1);
    assert.equal(h.log.includes('release'), false);

    h.waiting[0].done(true);
    await settle();
    assert.deepEqual(h.log, ['start tap', 'bounded true', 'release', 'bounded false']);
    assert.equal(h.controller.status().phase, 'released');
    // The tap is the only copy of the geometry now: nothing later may stop it.
    h.setModel('b', h.pending());
    h.setModel('a', null);
    await settle();
    assert.equal(h.log.includes('stop tap'), false);
  });

  it('does not arm a load the switch does not ask for, a federated addition, or a model that already has geometry', async () => {
    const off = await harness({ requested: false });
    off.setModel('a', off.pending());
    const second = await harness();
    second.setModel('a', second.loaded());
    second.setModel('b', second.pending());
    const late = await harness();
    late.setModel('a', { ...late.pending(), geometryResult: { meshes: [] } });
    await settle();
    for (const h of [off, second, late]) {
      assert.deepEqual(h.log, []);
      assert.equal(h.controller.status().phase, 'idle');
    }
  });

  it('joins a tap that is already running and leaves it running when the load is cancelled', async () => {
    const h = await harness({ runningTap: true });
    h.setModel('a', h.pending());
    await settle();
    h.setModel('a', null);
    await settle();
    assert.deepEqual(h.log, ['start tap', 'bounded true', 'bounded false'], 'joined, and never stopped: it is not this controller\'s');
    assert.deepEqual(h.controller.status(), { modelId: 'a', phase: 'cancelled', error: 'superseded' });
  });

  it('keeps the CPU geometry and stops its tap when the release does not verify', async () => {
    const h = await harness({ releaseFails: true });
    h.setModel('a', h.pending());
    await settle();
    h.setModel('a', h.loaded());
    h.waiting[0].done(true);
    await settle();
    assert.deepEqual(h.log, ['start tap', 'bounded true', 'release', 'bounded false', 'stop tap']);
    assert.deepEqual(h.controller.status(), { modelId: 'a', phase: 'failed', error: 'no verified complete backing' });
  });

  it('keeps the CPU geometry when the backing cannot start, the scene never settles, or there is no renderer', async () => {
    const noBacking = await harness({ startFails: true });
    noBacking.setModel('a', noBacking.pending());
    await settle();
    assert.deepEqual(noBacking.log, ['start tap', 'bounded true', 'bounded false']);
    assert.equal(noBacking.controller.status().error, 'IndexedDB unavailable');

    const unsettled = await harness();
    unsettled.setModel('a', unsettled.pending());
    await settle();
    unsettled.setModel('a', unsettled.loaded());
    unsettled.waiting[0].done(false);
    await settle();
    assert.deepEqual(unsettled.log, ['start tap', 'bounded true', 'bounded false', 'stop tap']);

    const headless = await harness({ renderer: false });
    headless.setModel('a', headless.pending());
    await settle();
    headless.setModel('a', headless.loaded());
    headless.waiting[0].done(true);
    await settle();
    assert.equal(headless.log.includes('release'), false);
    assert.equal(headless.controller.status().error, 'no viewport renderer');
  });

  it('cancels when a second model joins before the release, or the load fails', async () => {
    const joined = await harness();
    joined.setModel('a', joined.pending());
    await settle();
    joined.setModel('a', joined.loaded());
    joined.setModel('b', joined.pending());
    await settle();
    assert.equal(joined.waiting[0].cancelled, true);
    assert.deepEqual(joined.log, ['start tap', 'bounded true', 'bounded false', 'stop tap']);
    assert.equal(joined.controller.status().phase, 'cancelled');

    const failed = await harness();
    failed.setModel('a', failed.pending());
    await settle();
    failed.setModel('a', failed.loaded('error'));
    await settle();
    assert.deepEqual(failed.controller.status(), { modelId: 'a', phase: 'cancelled', error: 'the load failed' });
  });

  it('leaves the mode of a superseding load alone, and arms that load in turn', async () => {
    const h = await harness();
    h.setModel('a', h.pending());
    await settle();
    // The loader resets the mode, then replaces the model with the next placeholder.
    h.store.getState().setBoundedGeometryMode(false);
    h.store.setState({ models: new Map([['b', h.pending()]]) });
    await settle();
    // One tap for both: the second load takes over the start the first one made, and nothing stops it.
    assert.deepEqual(h.log, ['start tap', 'bounded true', 'bounded false', 'bounded false', 'bounded true']);
    assert.deepEqual(h.controller.status(), { modelId: 'b', phase: 'streaming' });
  });

  it('is not cancelled once the release has begun: a model joining then does not stop the tap under it', async () => {
    let open: () => void = () => {};
    const h = await harness({ releaseGate: new Promise<void>((resolve) => { open = resolve; }) });
    h.setModel('a', h.pending());
    await settle();
    h.setModel('a', h.loaded());
    h.waiting[0].done(true);
    await settle();
    assert.equal(h.controller.status().phase, 'releasing');
    h.setModel('b', h.pending());
    await settle();
    assert.equal(h.controller.status().phase, 'releasing');
    open();
    await settle();
    assert.equal(h.controller.status().phase, 'released');
    assert.equal(h.log.includes('stop tap'), false);
  });

  it('gives a load one attempt, and a reload under the same id a new one', async () => {
    const h = await harness({ startFails: true });
    h.setModel('a', h.pending());
    await settle();
    h.setModel('a', h.pending(200)); // the same load's placeholder changes: no second attempt
    await settle();
    assert.equal(h.log.filter((entry) => entry === 'start tap').length, 1);
    h.setModel('a', null);
    h.setModel('a', h.pending());
    await settle();
    assert.equal(h.log.filter((entry) => entry === 'start tap').length, 2);
  });

  it('stops following the store once uninstalled', async () => {
    const h = await harness();
    h.uninstall();
    h.setModel('a', h.pending());
    await settle();
    assert.deepEqual(h.log, []);
  });
});
