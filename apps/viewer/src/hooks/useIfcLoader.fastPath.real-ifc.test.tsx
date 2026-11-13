/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The small-file fast path through the actual loader, with the real WASM engine.
 * Only the Worker boundary is replaced: an in-process worker runs the same
 * `fastRunEvents` the spare worker runs (workers/fast-geometry-run.ts) and
 * answers with the worker protocol. The runtime, its pick starter and claimer
 * are the production ones.
 *
 * - A claimed run yields the same meshes and data store as the normal pipeline.
 * - A run that fails before its first event falls back, and the load completes
 *   with the same scene.
 * - Cancel during a claimed run cancels the run and ends the load.
 * - A newer pick while a run is pending cancels the older run; the newer load
 *   completes normally.
 *
 * The worker pool (2 MiB and up) needs real workers, so the instanced case is
 * covered by tests/e2e/small-file-fast-path.e2e.spec.ts.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { act } from 'react';
import { DEFAULT_GEOM_HASH_TOLERANCE, type GeometryMeshingSettings } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { resolveLoadTessellationTier } from '@/store/constants';
import { registerPickStarter } from './ingest/pickStart.js';
import { setFastGeometryClaimer } from './ingest/fastPath.js';
import * as harness from '@/test/blank-ifc-loader-harness.js';

// Loaded at runtime: the changed-test oracle removes new production files, and
// a missing module must fail an assertion rather than the whole file's import.
const runtimePath = '../lib/fast-path/fastPathRuntime.js';
const runPath = '../workers/fast-geometry-run.js';
const runtimeMod: typeof import('../lib/fast-path/fastPathRuntime') | null = await import(runtimePath).catch(() => null);
const runMod: typeof import('../workers/fast-geometry-run') | null = await import(runPath).catch(() => null);

const fixture = new URL('../../public/samples/building-architecture.ifc', import.meta.url);
const skip = !existsSync(fixture) ? 'building-architecture.ifc sample missing' : harness.skip;

type Mode = 'run' | 'fail' | 'hang';

/** The worker protocol over the shared run code, in-process. Never answers after terminate(). */
class InProcessFastWorker {
  static mode: Mode = 'run';
  static all: InProcessFastWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  received: string[] = [];
  private controller = new AbortController();
  constructor() { InProcessFastWorker.all.push(this); }
  postMessage(message: { type: string; file?: Blob; settings?: GeometryMeshingSettings; workerCountOverride?: number }): void {
    this.received.push(message.type);
    if (message.type === 'prewarm') queueMicrotask(() => this.deliver({ type: 'ready', warmMs: 0, wasmMemoryBytes: 0 }));
    else if (message.type === 'cancel') this.controller.abort();
    else if (message.type === 'run') void this.run(message.file!, message.settings!, message.workerCountOverride);
  }
  terminate(): void { this.terminated = true; this.controller.abort(); }
  private deliver(data: unknown): void { if (!this.terminated) this.onmessage?.({ data } as MessageEvent); }
  private async run(file: Blob, settings: GeometryMeshingSettings, workerCountOverride?: number): Promise<void> {
    const mode = InProcessFastWorker.mode;
    if (mode === 'hang') return;
    if (mode === 'fail') { this.deliver({ type: 'error', message: 'worker trapped' }); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      for await (const event of runMod!.fastRunEvents(bytes, settings, workerCountOverride, this.controller.signal)) this.deliver({ type: 'event', event });
      this.deliver({ type: 'end' });
    } catch (err) {
      this.deliver({ type: 'error', message: String(err) });
    }
  }
}

let runtime: ReturnType<NonNullable<typeof runtimeMod>['createFastPathRuntime']> = null;
let claims = 0;

function startRuntime(): void {
  assert.ok(runtimeMod && runMod, 'the fast-path runtime and run exist (lib/fast-path, workers/fast-geometry-run.ts)');
  runtime = runtimeMod.createFastPathRuntime({
    allowed: () => true,
    whenIdle: (run) => { let live = true; queueMicrotask(() => { if (live) run(); }); return () => { live = false; }; },
    isLoading: () => useViewerStore.getState().loading,
    subscribeLoading: (listener) => {
      let previous = useViewerStore.getState().loading;
      return useViewerStore.subscribe((s) => { if (s.loading !== previous) { previous = s.loading; listener(s.loading); } });
    },
    isHidden: () => false,
    onVisibilityChange: () => () => {},
    onInput: () => () => {},
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    compileModule: async () => ({}) as WebAssembly.Module,
    warmSamples: async () => [],
    spawnGeometryWorker: () => new InProcessFastWorker() as unknown as Worker,
    parser: { prepare: async () => false, has: () => false, warming: () => false, release: () => {} },
    settingsAtPick: (file) => {
      const { mergeLayers, geometryMode } = useViewerStore.getState();
      return { mergeLayers, enableInstancing: true, tessellationQuality: resolveLoadTessellationTier(file.size / (1024 * 1024), geometryMode) ?? null,
        skipSmallCuts: geometryMode === 'fast', skipVoids: false, geometryHashTolerance: DEFAULT_GEOM_HASH_TOLERANCE };
    },
    workerCountOverride: () => undefined,
    registerPickStarter,
    setClaimer: (claimer) => setFastGeometryClaimer((...args) => { const run = claimer(...args); if (run) claims++; return run; }),
  });
  assert.ok(runtime);
}

async function spareReady(): Promise<void> {
  for (let i = 0; i < 50 && runtime?.state().geometrySpare !== 'ready'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runtime?.state().geometrySpare, 'ready', 'the spare is ready before the pick');
}

const file = () => new File([readFileSync(fixture)], 'building-architecture.ifc');

/** Meshes per element (byte digest) and the data store's entity count. */
function scene(): { meshes: number; digest: string; entities: number | null } {
  const state = useViewerStore.getState();
  const model = state.models.get(state.activeModelId ?? '');
  const meshes = model?.geometryResult?.meshes ?? [];
  let h = 0x811c9dc5;
  const mix = (a: ArrayBufferView) => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } };
  for (const m of [...meshes].sort((a, b) => a.expressId - b.expressId)) { mix(new Uint32Array([m.expressId])); mix(m.positions); mix(m.indices); }
  return { meshes: meshes.length, digest: (h >>> 0).toString(16), entities: model?.ifcDataStore?.entityCount ?? null };
}

beforeEach(() => { InProcessFastWorker.mode = 'run'; InProcessFastWorker.all = []; claims = 0; });
afterEach(() => { runtime?.stop(); runtime = null; });

describe('small-file fast path through the loader', { skip }, () => {
  it('a claimed run yields the same meshes and data store as the normal pipeline', async () => {
    await harness.load(file());
    const normal = scene();
    assert.ok(normal.meshes > 0);
    startRuntime();
    await spareReady();
    await harness.load(file());
    assert.equal(claims, 1, 'the load used the run');
    assert.deepEqual(scene(), normal);
  });

  it('a run that fails before its first event falls back, and the load completes with the same scene', async () => {
    await harness.load(file());
    const normal = scene();
    startRuntime();
    await spareReady();
    InProcessFastWorker.mode = 'fail';
    await harness.load(file());
    assert.equal(claims, 1);
    assert.deepEqual(scene(), normal);
  });

  it('Cancel during a claimed run cancels the run and ends the load', async () => {
    startRuntime();
    await spareReady();
    InProcessFastWorker.mode = 'hang';
    let pending!: Promise<void>;
    await act(async () => { pending = harness.hook!.loadFile(file()); });
    for (let i = 0; i < 200 && claims === 0; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    assert.equal(claims, 1, 'the load claimed the run');
    const worker = InProcessFastWorker.all[0];
    await act(async () => { useViewerStore.getState().activeLoadCanceller?.(); await pending; });
    assert.equal(worker.terminated, true, 'the run is stopped');
    assert.equal(useViewerStore.getState().loading, false);
  });

  it('a newer pick while a run is pending cancels the older run; the newer load completes', async () => {
    await harness.load(file());
    const normal = scene();
    startRuntime();
    await spareReady();
    InProcessFastWorker.mode = 'hang';
    let older!: Promise<void>;
    await act(async () => { older = harness.hook!.loadFile(file()); });
    const first = InProcessFastWorker.all[0];
    InProcessFastWorker.mode = 'run';
    await harness.load(file());
    await act(async () => { await older; });
    assert.equal(first.terminated, true, 'the older run is cancelled');
    assert.deepEqual(scene(), normal);
  });
});
