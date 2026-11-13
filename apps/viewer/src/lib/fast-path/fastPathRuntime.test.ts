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
import type { FastClaim, FastGeometryRun } from '@/hooks/ingest/fastPath';
import type { FastPathDeps } from './fastPathRuntime';

// Loaded at runtime: the changed-test oracle removes new production files, and
// a missing module must fail an assertion rather than the whole file's import.
const runtimePath = './fastPathRuntime.js';
const loaderPath = '../../hooks/ingest/fastPath.js';
const runtimeMod: typeof import('./fastPathRuntime') | null = await import(runtimePath).catch(() => null);
const loaderMod: typeof import('@/hooks/ingest/fastPath') | null = await import(loaderPath).catch(() => null);
function rt() { assert.ok(runtimeMod, 'the fast-path runtime exists (lib/fast-path/fastPathRuntime.ts)'); return runtimeMod; }
function ld() { assert.ok(loaderMod, 'the loader fast-path seam exists (hooks/ingest/fastPath.ts)'); return loaderMod; }
const FAST_PATH_MAX_BYTES = 10 * 1024 * 1024; // = CACHE_SIZE_THRESHOLD: smaller files are never cached
const FAST_RUN_FIRST_EVENT_MS = 5_000;
const HIDDEN_RELEASE_MS = 5 * 60_000;
const INACTIVE_RELEASE_MS = 20 * 60_000;
const createFastPathRuntime = (deps: FastPathDeps) => rt().createFastPathRuntime(deps);
const fastPathEligible = (ctx: PickStartContext) => rt().fastPathEligible(ctx);
const fastGeometryEvents: typeof import('@/hooks/ingest/fastPath')['fastGeometryEvents'] = (...a) => ld().fastGeometryEvents(...a);

const SETTINGS: GeometryMeshingSettings = {
  mergeLayers: false, enableInstancing: true, tessellationQuality: null, skipSmallCuts: true, skipVoids: false, geometryHashTolerance: 1e-3,
};
const PRIMARY: FastClaim = { target: 'primary', sourceIsFile: true };

/** A worker stand-in. Like a real one, it never delivers anything after terminate(). */
class FakeWorker {
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(message: Record<string, unknown>): void { this.posted.push(message); }
  terminate(): void { this.terminated = true; }
  reply(data: unknown): void { if (!this.terminated) this.onmessage?.({ data } as MessageEvent); }
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
  let claimer: ((file: File, s: GeometryMeshingSettings, c: FastClaim) => FastGeometryRun | null) | null = null;
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
    workerCountOverride: () => 3,
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
    claim: (file: File, s: GeometryMeshingSettings = SETTINGS, c: FastClaim = PRIMARY) => claimer?.(file, s, c) ?? null,
  };
}

const ifc = (name = 'a.ifc', bytes = 100) => new File([new Uint8Array(bytes)], name);
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra }) as unknown as StreamingGeometryEvent;
const collect = async (it: AsyncIterable<StreamingGeometryEvent>) => { const out: StreamingGeometryEvent[] = []; for await (const e of it) out.push(e); return out; };

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
    assert.equal(rt().FAST_RUN_FIRST_EVENT_MS, FAST_RUN_FIRST_EVENT_MS);
    assert.equal(rt().HIDDEN_RELEASE_MS, HIDDEN_RELEASE_MS);
    assert.equal(rt().INACTIVE_RELEASE_MS, INACTIVE_RELEASE_MS);
  });

  it('takes primary, exact-kernel, first-attempt .ifc files below the cached tier only', () => {
    assert.equal(fastPathEligible({ ...base, file: ifc('A.IFC') }), true);
    assert.equal(fastPathEligible({ ...base, file: ifc('a.ifczip') }), false);
    assert.equal(fastPathEligible({ ...base, file: ifc('a.ifcx') }), false);
    assert.equal(fastPathEligible({ ...base, file: ifc('a.ifc', 0) }), false);
    assert.equal(fastPathEligible({ ...base, file: { name: 'a.ifc', size: FAST_PATH_MAX_BYTES - 1 } as File }), true);
    assert.equal(fastPathEligible({ ...base, file: { name: 'a.ifc', size: FAST_PATH_MAX_BYTES } as File }), false, 'a cacheable size is excluded');
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

  it('measurement modes prepare one spare alone (?perf.fastPath=parser | geometry)', async () => {
    const parserOnly = host({ parts: { parser: true, geometry: false } });
    const a = createFastPathRuntime(parserOnly.deps)!;
    await parserOnly.runIdle();
    assert.equal(parserOnly.workers.length, 0, 'no geometry spare');
    assert.equal(parserOnly.parserPrepares, 1);
    a.stop();
    const geometryOnly = host({ parts: { parser: false, geometry: true } });
    const b = createFastPathRuntime(geometryOnly.deps)!;
    await ready(geometryOnly);
    assert.equal(geometryOnly.parserPrepares, 0, 'no parser spare');
    assert.equal(b.state().geometrySpare, 'ready');
    b.stop();
  });

  it('an idle callback that fires during a load does no work at all (no compile, no fetch)', async () => {
    let compiles = 0;
    let fire: (() => void) | null = null;
    // A host whose idle callback cannot be cancelled (e.g. it was already queued when the load began).
    const h = host({ whenIdle: (run) => { fire = run; return () => {}; }, compileModule: async () => { compiles++; return {} as WebAssembly.Module; } });
    const rt = createFastPathRuntime(h.deps)!;
    h.setLoading(true);
    fire!();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(compiles, 0);
    assert.equal(h.workers.length, 0);
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

  it('a tab hidden while it waits for the engine prepares nothing, and re-arms when visible again', async () => {
    let finishCompile!: (m: WebAssembly.Module) => void;
    let compiles = 0;
    const h = host({ compileModule: () => { compiles++; return compiles === 1 ? new Promise((r) => { finishCompile = r; }) : Promise.resolve({} as WebAssembly.Module); } });
    const rt = createFastPathRuntime(h.deps)!;
    const idle = h.runIdle();
    h.setHidden(true);
    finishCompile({} as WebAssembly.Module);
    await idle;
    assert.equal(h.workers.length, 0, 'no geometry spare in the hidden tab');
    assert.equal(h.parserPrepares, 0, 'no parser spare in the hidden tab');
    h.setHidden(false);
    await ready(h);
    assert.equal(rt.state().geometrySpare, 'ready');
    assert.equal(h.parserSpare, true);
    rt.stop();
  });

  it('a release between the pick and the claim cancels the pending run', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const file = ifc();
    h.pick({ file });
    const worker = h.workers[0];
    assert.equal(rt.state().pendingRun, true);
    h.setHidden(true);
    h.advance(HIDDEN_RELEASE_MS);
    assert.equal(worker.terminated, true, 'the run\'s worker is stopped by the release');
    assert.equal(rt.state().pendingRun, false);
    assert.equal(h.claim(file), null, 'the load meshes through the normal pipeline');
    rt.stop();
  });

  it('a load that starts while the geometry spare still warms up terminates it (no warm-up meshing during the load)', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await h.runIdle();
    assert.equal(rt.state().geometrySpare, 'warming');
    h.setLoading(true);
    assert.equal(h.workers[0].terminated, true);
    assert.equal(rt.state().geometrySpare, 'none');
    rt.stop();
  });

  it('streams the run: the pick hands the File to the ready spare, the load claims it and reads its events in order', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const file = ifc();
    h.pick({ file });
    const w = h.workers[0];
    assert.deepEqual(w.posted[1], { type: 'run', file, settings: SETTINGS, workerCountOverride: 3 });
    assert.equal(rt.state().geometrySpare, 'none', 'the spare is consumed by the pick');
    const run = h.claim(file)!;
    assert.ok(run);
    const out = collect(run.events);
    w.reply({ type: 'event', event: ev('start') });
    w.reply({ type: 'event', event: ev('batch', { instancedShards: [new ArrayBuffer(4)] }) });
    w.reply({ type: 'event', event: ev('unitRefused') });
    w.reply({ type: 'event', event: ev('complete') });
    w.reply({ type: 'end' });
    assert.deepEqual((await out).map((e) => e.type), ['start', 'batch', 'unitRefused', 'complete']);
    assert.equal(w.terminated, true, 'one run per worker');
    rt.stop();
  });

  it('a run with no first event within the deadline fails (the worker died); once events flow there is no deadline', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const a = ifc();
    h.pick({ file: a });
    const runA = h.claim(a)!;
    const outA = collect(runA.events);
    h.advance(FAST_RUN_FIRST_EVENT_MS);
    await assert.rejects(outA, /no first event/);
    assert.equal(h.workers[0].terminated, true);
    h.setLoading(true); h.setLoading(false);
    await ready(h);
    const b = ifc();
    h.pick({ file: b });
    const runB = h.claim(b)!;
    const w = h.workers[1];
    w.reply({ type: 'event', event: ev('start') });
    h.advance(FAST_RUN_FIRST_EVENT_MS * 10);
    w.reply({ type: 'event', event: ev('complete') });
    w.reply({ type: 'end' });
    assert.deepEqual((await collect(runB.events)).map((e) => e.type), ['start', 'complete']);
    rt.stop();
  });

  it('a worker error ends the run with that error', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const a = ifc();
    h.pick({ file: a });
    const run = h.claim(a)!;
    h.workers[0].reply({ type: 'error', message: 'not an IFC STEP source' });
    await assert.rejects(collect(run.events), /not an IFC STEP source/);
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
    assert.equal(h.workers[0].posted.at(-1)?.type, 'cancel');
    rt.stop();
  });

  it('refuses the claim when the load parses other bytes than the picked file (an unwrapped archive named .ifc)', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const file = ifc();
    h.pick({ file });
    assert.equal(h.claim(file, SETTINGS, { target: 'primary', sourceIsFile: false }), null);
    assert.equal(h.workers[0].terminated, true);
    rt.stop();
  });

  it('a federated add neither cancels nor claims the primary run', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const primary = ifc();
    h.pick({ file: primary });
    h.pick({ file: ifc('other.ifc'), target: { kind: 'federated', modelId: 'm2' } });
    assert.equal(rt.state().pendingRun, true, 'a federated pick leaves the primary run alone');
    assert.equal(h.claim(primary, SETTINGS, { target: 'federated', sourceIsFile: true }), null);
    assert.equal(h.workers[0].terminated, false, 'a federated claim leaves the primary run alone');
    assert.ok(h.claim(primary), 'the primary still claims its run');
    rt.stop();
  });

  it('a superseded load reaching its geometry stage does not take or cancel the newer pick\'s run', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    const older = ifc('older.ifc');
    const newer = ifc('newer.ifc');
    h.pick({ file: newer });
    assert.equal(h.claim(older), null);
    assert.equal(h.workers[0].terminated, false);
    assert.ok(h.claim(newer));
    rt.stop();
  });

  it('a new primary pick cancels the previous pick\'s pending run', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await ready(h);
    h.pick({ file: ifc('first.ifc') });
    const first = h.workers[0];
    h.pick({ file: ifc('second.ifc') });
    assert.equal(first.terminated, true);
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

  it('a release during the geometry warm-up settles it, so later preparations still run (a terminated worker never answers)', async () => {
    const h = host();
    const rt = createFastPathRuntime(h.deps)!;
    await h.runIdle();
    assert.equal(rt.state().geometrySpare, 'warming');
    h.setHidden(true);
    h.advance(HIDDEN_RELEASE_MS);
    assert.equal(h.workers[0].terminated, true);
    await new Promise((r) => setTimeout(r, 0));
    h.setHidden(false);
    await ready(h);
    assert.equal(rt.state().geometrySpare, 'ready', 'the released warm-up did not leave preparation stuck');
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
  const run = (events: AsyncIterable<StreamingGeometryEvent>) => {
    let cancelled = 0;
    return { r: { file: ifc(), settings: SETTINGS, events, cancel: () => { cancelled++; } } as FastGeometryRun, cancelled: () => cancelled };
  };
  async function* of(...list: Array<StreamingGeometryEvent | Error>) { for (const e of list) { if (e instanceof Error) throw e; yield e; } }
  async function* normal() { yield ev('start', { totalEstimate: 9 }); yield ev('complete'); }

  it('yields the run\'s events in order', async () => {
    assert.deepEqual((await collect(fastGeometryEvents(run(of(ev('start'), ev('batch'), ev('complete'))).r, normal))).map((e) => e.type), ['start', 'batch', 'complete']);
  });

  it('falls back to the normal pipeline when the run fails before its first event; the fallback starts with its own first event', async () => {
    const x = run(of(new Error('worker died')));
    const out = await collect(fastGeometryEvents(x.r, normal));
    assert.deepEqual(out.map((e) => e.type), ['start', 'complete']);
    assert.equal((out[0] as { totalEstimate?: number }).totalEstimate, 9, 'the fallback\'s events, not the run\'s');
    assert.ok(x.cancelled() >= 1);
  });

  it('falls back when the run ends without any event', async () => {
    assert.deepEqual((await collect(fastGeometryEvents(run(of()).r, normal))).map((e) => e.type), ['start', 'complete']);
  });

  it('a failure after the first event ends the stream with that failure, like the worker pool (no mixed output)', async () => {
    await assert.rejects(collect(fastGeometryEvents(run(of(ev('start'), ev('batch'), new Error('worker died'))).r, normal)), /worker died/);
  });

  it('ends with the abort, without falling back, when the load is cancelled', async () => {
    const ac = new AbortController();
    const x = run({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamingGeometryEvent>>(() => {}) }) });
    const out = collect(fastGeometryEvents(x.r, normal, ac.signal));
    ac.abort(new Error('cancelled by user'));
    await assert.rejects(out, /cancelled by user/);
    assert.equal(x.cancelled(), 1);
  });

  it('a load already cancelled leaves no unhandled rejection from the abandoned read', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const ac = new AbortController();
      ac.abort(new Error('cancelled by user'));
      let rejectRead!: (err: Error) => void;
      const x = run({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamingGeometryEvent>>((_, reject) => { rejectRead = reject; }) }) });
      await assert.rejects(collect(fastGeometryEvents(x.r, normal, ac.signal)), /cancelled by user/);
      rejectRead(new Error('fast-path run cancelled')); // what run.cancel() does to the pending read
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(unhandled.length, 0, 'the abandoned read has a handler');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
