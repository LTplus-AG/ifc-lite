/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The small-file fast path's host policy. What every visitor pays for it must
 * stay bounded: spares are prepared only at idle with no load running, one of
 * each kind at most, refilled only after a load ends, and released when the
 * tab is hidden or unused for long. A pick hands the File to a ready spare;
 * the load uses that run only when it meshes with the same settings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryMeshingSettings, StreamingGeometryEvent } from '@ifc-lite/geometry';
import type { PickStartContext, PickStarter } from '@/hooks/ingest/pickStart';
import type { FastGeometryRun } from '@/hooks/ingest/fastPath';
import type { FastPathDeps } from './fastPathRuntime';

// Loaded at runtime: the changed-test oracle removes new production files, and
// a missing module must fail an assertion rather than the whole file's import.
const runtimePath = './fastPathRuntime.js';
const loaderPath = '../../hooks/ingest/fastPath.js';
const runtimeMod: typeof import('./fastPathRuntime') | null = await import(runtimePath).catch(() => null);
const loaderMod: typeof import('@/hooks/ingest/fastPath') | null = await import(loaderPath).catch(() => null);
function rt() { assert.ok(runtimeMod, 'the fast-path runtime exists (lib/fast-path/fastPathRuntime.ts)'); return runtimeMod; }
function ld() { assert.ok(loaderMod, 'the loader fast-path seam exists (hooks/ingest/fastPath.ts)'); return loaderMod; }
const FAST_PATH_MAX_BYTES = 10 * 1024 * 1024;
const FAST_RUN_TIMEOUT_MS = 15_000;
const HIDDEN_RELEASE_MS = 5 * 60_000;
const INACTIVE_RELEASE_MS = 20 * 60_000;
const createFastPathRuntime = (deps: FastPathDeps) => rt().createFastPathRuntime(deps);
const fastPathEligible = (ctx: PickStartContext) => rt().fastPathEligible(ctx);
const fastGeometryEvents: typeof import('@/hooks/ingest/fastPath')['fastGeometryEvents'] = (...a) => ld().fastGeometryEvents(...a);

const SETTINGS: GeometryMeshingSettings = {
  mergeLayers: false, enableInstancing: true, tessellationQuality: null, skipSmallCuts: true, skipVoids: false, geometryHashTolerance: 1e-3,
};

class FakeWorker {
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(message: Record<string, unknown>): void { this.posted.push(message); }
  terminate(): void { this.terminated = true; }
  reply(data: unknown): void { this.onmessage?.({ data } as MessageEvent); }
}

/** A controllable host: idle callbacks, timers, visibility, input and loading are all driven by the test. */
function host(overrides: Partial<FastPathDeps> = {}) {
  const idle: Array<() => void> = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let clock = 0;
  let nextTimer = 1;
  let loading = false;
  let hidden = false;
  const loadingListeners = new Set<(l: boolean) => void>();
  const visibilityListeners = new Set<() => void>();
  const inputListeners = new Set<() => void>();
  const workers: FakeWorker[] = [];
  let parserSpare = false;
  let parserPrepares = 0;
  let starter: PickStarter | null = null;
  let claimer: ((file: File, s: GeometryMeshingSettings) => FastGeometryRun | null) | null = null;
  const deps: FastPathDeps = {
    allowed: () => true,
    whenIdle: (run) => { idle.push(run); return () => { const i = idle.indexOf(run); if (i >= 0) idle.splice(i, 1); }; },
    isLoading: () => loading,
    subscribeLoading: (l) => { loadingListeners.add(l); return () => loadingListeners.delete(l); },
    isHidden: () => hidden,
    onVisibilityChange: (l) => { visibilityListeners.add(l); return () => visibilityListeners.delete(l); },
    onInput: (l) => { inputListeners.add(l); return () => inputListeners.delete(l); },
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
    compileModule: async () => ({}) as WebAssembly.Module,
    warmSamples: async () => [new Uint8Array([1, 2, 3])],
    spawnGeometryWorker: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; },
    parser: {
      prepare: async () => { parserPrepares++; parserSpare = true; return true; },
      has: () => parserSpare,
      release: () => { parserSpare = false; },
    },
    settingsAtPick: () => SETTINGS,
    registerPickStarter: (s) => { starter = s; return () => { starter = null; }; },
    setClaimer: (c) => { claimer = c; return () => { claimer = null; }; },
    ...overrides,
  };
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    deps, workers,
    get parserSpare() { return parserSpare; },
    set parserSpare(v: boolean) { parserSpare = v; },
    get parserPrepares() { return parserPrepares; },
    idleCount: () => idle.length,
    /** Run pending idle callbacks and let the preparation's awaits settle. */
    async runIdle() { for (const run of idle.splice(0)) run(); for (let i = 0; i < 5; i++) await flush(); },
    advance(ms: number) {
      clock += ms;
      for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); }
    },
    setLoading(v: boolean) { loading = v; for (const l of loadingListeners) l(v); },
    setHidden(v: boolean) { hidden = v; for (const l of visibilityListeners) l(); },
    input() { for (const l of inputListeners) l(); },
    pick(ctx: Partial<PickStartContext> & { file: File }) {
      starter?.({ target: { kind: 'primary' }, kernel: { kind: 'exact' } as PickStartContext['kernel'], retry: false, isCurrent: () => true, ...ctx });
    },
    claim: (file: File, s: GeometryMeshingSettings = SETTINGS) => claimer?.(file, s) ?? null,
  };
}

const ifc = (name = 'a.ifc', bytes = 100) => new File([new Uint8Array(bytes)], name);

/** Prepare both spares and answer the geometry warm-up. */
async function ready(h: ReturnType<typeof host>) {
  await h.runIdle();
  h.workers.at(-1)!.reply({ type: 'ready', warmMs: 1, wasmMemoryBytes: 1 });
  await new Promise((r) => setTimeout(r, 0));
}

describe('fast path eligibility', () => {
  const base = { target: { kind: 'primary' }, kernel: { kind: 'exact' }, retry: false, isCurrent: () => true } as unknown as PickStartContext;
  it('uses the documented bounds', () => {
    assert.equal(rt().FAST_PATH_MAX_BYTES, FAST_PATH_MAX_BYTES);
    assert.equal(rt().FAST_RUN_TIMEOUT_MS, FAST_RUN_TIMEOUT_MS);
    assert.equal(rt().HIDDEN_RELEASE_MS, HIDDEN_RELEASE_MS);
    assert.equal(rt().INACTIVE_RELEASE_MS, INACTIVE_RELEASE_MS);
  });

  it('takes primary, exact-kernel, first-attempt .ifc files up to the uncached tier only', () => {
    assert.equal(fastPathEligible({ ...base, file: ifc('A.IFC') }), true);
    assert.equal(fastPathEligible({ ...base, file: ifc('a.ifczip') }), false);
    assert.equal(fastPathEligible({ ...base, file: ifc('a.ifcx') }), false);
    assert.equal(fastPathEligible({ ...base, file: ifc('a.ifc', 0) }), false);
    assert.equal(fastPathEligible({ ...base, file: { name: 'a.ifc', size: FAST_PATH_MAX_BYTES + 1 } as File }), false);
    assert.equal(fastPathEligible({ ...base, file: ifc(), target: { kind: 'federated', modelId: 'm' } }), false);
    assert.equal(fastPathEligible({ ...base, file: ifc(), retry: true }), false);
    assert.equal(fastPathEligible({ ...base, file: ifc(), kernel: { kind: 'retained' } as PickStartContext['kernel'] }), false);
  });
});

describe('fast path runtime', () => {
  it('does nothing at all when the browser may not warm up', () => {
    const h = host({ allowed: () => false });
    assert.equal(createFastPathRuntime(h.deps), null);
    assert.equal(h.idleCount(), 0);
  });

  it('prepares one spare of each kind at idle, never while a load runs', async () => {
    const h = host();
    h.setLoading(true);
    const rt = createFastPathRuntime(h.deps)!;
    assert.equal(h.idleCount(), 0, 'nothing is scheduled while a load runs');
    h.setLoading(false);
    assert.equal(h.idleCount(), 1);
    h.setLoading(true);
    assert.equal(h.idleCount(), 0, 'a load that starts cancels the pending preparation');
    h.setLoading(false);
    await ready(h);
    assert.deepEqual(rt.state(), { geometrySpare: 'ready', parserSpare: true, pendingRun: false, released: false });
    assert.equal(h.workers.length, 1);
    assert.equal(h.workers[0].posted[0].type, 'prewarm');
    rt.stop();
  });

  it('stops preparing when a load starts while it waits for the engine', async () => {
    let finishCompile!: (m: WebAssembly.Module) => void;
    const h = host({ compileModule: () => new Promise((r) => { finishCompile = r; }) });
    const rt = createFastPathRuntime(h.deps)!;
    const idle = h.runIdle();
    h.setLoading(true);
    finishCompile({} as WebAssembly.Module);
    await idle;
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.workers.length, 0);
    assert.equal(h.parserPrepares, 0);
    rt.stop();
  });

  it('hands an eligible pick to the ready spare and the load claims it with the same settings', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const file = ifc();
    h.pick({ file });
    const w = h.workers[0];
    assert.deepEqual(w.posted[1], { type: 'run', file, settings: SETTINGS });
    assert.equal(rt.state().geometrySpare, 'none', 'the spare is consumed by the pick');
    const run = h.claim(file)!;
    assert.ok(run);
    const events = [{ type: 'complete', totalMeshes: 0 }] as unknown as StreamingGeometryEvent[];
    w.reply({ type: 'result', events });
    assert.deepEqual(await run.events, events);
    assert.equal(w.terminated, true, 'one run per worker');
    rt.stop();
  });

  it('cancels the run when the load meshes with other settings, so the normal pipeline runs', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const file = ifc();
    h.pick({ file });
    assert.equal(h.claim(file, { ...SETTINGS, skipSmallCuts: false }), null);
    assert.equal(h.workers[0].terminated, true);
    rt.stop();
  });

  it('ignores ineligible picks and keeps the spare for the next one', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    h.pick({ file: ifc('a.ifcx') });
    assert.equal(rt.state().geometrySpare, 'ready');
    assert.equal(h.claim(ifc('a.ifcx')), null);
    rt.stop();
  });

  it('drops a run the load never claimed when the load ends, then refills at idle', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    h.pick({ file: ifc() });
    h.setLoading(true);
    h.parserSpare = false; // the load's parse took the parser spare
    h.setLoading(false);
    assert.equal(h.workers[0].terminated, true, 'unclaimed run cancelled');
    assert.equal(rt.state().pendingRun, false);
    await ready(h);
    assert.equal(h.workers.length, 2, 'exactly one new geometry spare');
    assert.equal(h.parserPrepares, 2, 'exactly one new parser spare');
    assert.equal(rt.state().geometrySpare, 'ready');
    rt.stop();
  });

  it('reports a worker error or a timeout as a failed run (the loader then falls back)', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const a = ifc();
    h.pick({ file: a });
    const runA = h.claim(a)!;
    h.workers[0].reply({ type: 'error', message: 'trap' });
    await assert.rejects(runA.events, /trap/);
    h.setLoading(true); h.setLoading(false);
    await ready(h);
    const b = ifc();
    h.pick({ file: b });
    const runB = h.claim(b)!;
    h.advance(FAST_RUN_TIMEOUT_MS);
    await assert.rejects(runB.events, /timed out/);
    assert.equal(h.workers[1].terminated, true);
    rt.stop();
  });

  it('releases both spares after the tab stays hidden, and re-arms when it is visible again', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    h.setHidden(true);
    h.advance(HIDDEN_RELEASE_MS - 1);
    assert.equal(rt.state().geometrySpare, 'ready');
    h.advance(1);
    assert.deepEqual(rt.state(), { geometrySpare: 'none', parserSpare: false, pendingRun: false, released: true });
    assert.equal(h.workers[0].terminated, true);
    h.setHidden(false);
    assert.equal(h.idleCount(), 1);
    await ready(h);
    assert.equal(rt.state().geometrySpare, 'ready');
    rt.stop();
  });

  it('a short hide releases nothing', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    h.setHidden(true);
    h.advance(HIDDEN_RELEASE_MS / 2);
    h.setHidden(false);
    h.advance(HIDDEN_RELEASE_MS);
    assert.equal(rt.state().geometrySpare, 'ready');
    rt.stop();
  });

  it('releases both spares after long inactivity; input pushes it back, and re-arms after a release', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    h.advance(INACTIVE_RELEASE_MS - 10);
    h.input();
    h.advance(INACTIVE_RELEASE_MS - 10);
    assert.equal(rt.state().geometrySpare, 'ready', 'input reset the timer');
    h.advance(10);
    assert.equal(rt.state().released, true);
    h.input();
    await ready(h);
    assert.equal(rt.state().geometrySpare, 'ready');
    rt.stop();
  });
});

describe('fastGeometryEvents (loader side)', () => {
  const events = [{ type: 'complete', totalMeshes: 1 }] as unknown as StreamingGeometryEvent[];
  const run = (p: Promise<StreamingGeometryEvent[]>) => {
    let cancelled = 0;
    return { r: { file: ifc(), settings: SETTINGS, events: p, cancel: () => { cancelled++; } } as FastGeometryRun, cancelled: () => cancelled };
  };
  const collect = async (it: AsyncIterable<StreamingGeometryEvent>) => { const out = []; for await (const e of it) out.push(e); return out; };
  async function* normal() { yield { type: 'start', totalEstimate: 9 } as StreamingGeometryEvent; }

  it('yields the run\'s events', async () => {
    assert.deepEqual(await collect(fastGeometryEvents(run(Promise.resolve(events)).r, normal)), events);
  });

  it('falls back to the normal pipeline when the run fails', async () => {
    const x = run(Promise.reject(new Error('worker died')));
    assert.deepEqual(await collect(fastGeometryEvents(x.r, normal)), [{ type: 'start', totalEstimate: 9 }]);
    assert.equal(x.cancelled(), 1);
  });

  it('ends with the abort, without falling back, when the load is cancelled', async () => {
    const ac = new AbortController();
    const x = run(new Promise(() => {}));
    const out = collect(fastGeometryEvents(x.r, normal, ac.signal));
    ac.abort(new Error('cancelled by user'));
    await assert.rejects(out, /cancelled by user/);
    assert.equal(x.cancelled(), 1);
  });
});
