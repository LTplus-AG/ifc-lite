/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Small-file fast path, host side (loaded lazily at idle; nothing here is in the
 * entry chunk).
 *
 * While the page is idle and no load is running it prepares two spares:
 * - a parser worker with its bundle loaded and one warm parse of a shipped
 *   sample done (which instantiates its engine), which the next parse of ANY size takes
 *   (`WorkerParser` picks it up), and
 * - a fast-path geometry worker (workers/fast-geometry.worker.ts), engine
 *   instantiated and warmed on shipped samples, which an eligible pick hands
 *   the File to before the interface reset.
 *
 * Bounds on what a visitor pays for it:
 * - at most one spare of each kind; a load consumes them and they are refilled
 *   only after the load has ended, so repeated loads keep the same idle cost;
 * - nothing is prepared while a load runs, while the tab is hidden, on a
 *   browser that reports under 4 GB of memory or asks to save data, or with
 *   `?perf.fastPath=0`;
 * - both spares are released after the tab has been hidden for
 *   {@link HIDDEN_RELEASE_MS} or has seen no input for {@link INACTIVE_RELEASE_MS};
 *   the next visible input re-arms them at idle. (No browser exposes a memory
 *   pressure signal to pages, so there is nothing else to listen to.)
 */

import type { GeometryMeshingSettings, StreamingGeometryEvent } from '@ifc-lite/geometry';
import type { PickStartContext, PickStarter } from '@/hooks/ingest/pickStart';
import { sameMeshingSettings, type FastClaim, type FastGeometryRun } from '@/hooks/ingest/fastPath';
import { CACHE_SIZE_THRESHOLD } from '@/utils/ifcConfig';

/**
 * Files the fast path takes are smaller than this: the uncached tier, so a
 * small file can never be a cache hit that would leave a run unused.
 */
export const FAST_PATH_MAX_BYTES = CACHE_SIZE_THRESHOLD;
export const HIDDEN_RELEASE_MS = 5 * 60_000;
export const INACTIVE_RELEASE_MS = 20 * 60_000;
/**
 * A run whose FIRST event has not arrived by then is abandoned and the load
 * meshes with the normal pipeline. The first event follows the file read and
 * the engine init, before any meshing, so this only catches a dead worker;
 * once events flow, the loader's own stall watchdog applies as for the pool.
 */
export const FAST_RUN_FIRST_EVENT_MS = 5_000;

/** Settings the warm-up meshes with (any; it only compiles the engine's hot paths). */
const WARM_SETTINGS: GeometryMeshingSettings = {
  mergeLayers: false, enableInstancing: true, tessellationQuality: null,
  skipSmallCuts: false, skipVoids: false, geometryHashTolerance: 1e-3,
};

/** Whether a pick may take the fast path. */
export function fastPathEligible(ctx: PickStartContext): boolean {
  return ctx.target.kind === 'primary' && ctx.kernel.kind === 'exact' && !ctx.retry
    && /\.ifc$/i.test(ctx.file.name) && ctx.file.size > 0 && ctx.file.size < FAST_PATH_MAX_BYTES;
}

export interface FastPathDeps {
  /** Off switch and device gates (warm-runtime-gate `mayWarmUp`). */
  allowed(): boolean;
  /** Which spares to prepare (default both); `?perf.fastPath=parser|geometry` measures one alone. */
  parts?: { parser: boolean; geometry: boolean };
  /** `scheduleWhenIdle`: visible tab + idle main thread; returns cancel. */
  whenIdle(run: () => void): () => void;
  isLoading(): boolean;
  subscribeLoading(listener: (loading: boolean) => void): () => void;
  /** Visibility and input, for the release timers. */
  isHidden(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  onInput(listener: () => void): () => void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The engine module, compiled once for the page. */
  compileModule(): Promise<WebAssembly.Module | null>;
  /** Shipped samples for the warm-ups. */
  warmSamples(): Promise<Uint8Array[]>;
  spawnGeometryWorker(): Worker;
  parser: {
    prepare(options: { warmSource: SharedArrayBuffer | null }): Promise<boolean>;
    has(): boolean;
    release(): void;
  };
  /** The meshing settings a load of this file would use, read at the pick. */
  settingsAtPick(file: File): GeometryMeshingSettings;
  /** The `?geomWorkers=N` override the load would pass (worker storage is not readable in the worker). */
  workerCountOverride(): number | undefined;
  registerPickStarter(starter: PickStarter): () => void;
  setClaimer(claimer: (file: File, settings: GeometryMeshingSettings, claim: FastClaim) => FastGeometryRun | null): () => void;
  log?(message: string): void;
}

interface GeometrySpare { worker: Worker; ready: boolean; settle?: () => void }

export interface FastPathRuntime {
  stop(): void;
  /** For tests and diagnostics. */
  state(): { geometrySpare: 'none' | 'warming' | 'ready'; parserSpare: boolean; pendingRun: boolean; released: boolean };
}

export function createFastPathRuntime(deps: FastPathDeps): FastPathRuntime | null {
  if (!deps.allowed()) return null;
  const parts = deps.parts ?? { parser: true, geometry: true };

  let geometry: GeometrySpare | null = null;
  let pending: FastGeometryRun | null = null;
  let cancelIdle: (() => void) | null = null;
  let preparing = false;
  let released = false;
  /** Bumped by every release: a preparation that a release interrupted must not mark the spares as prepared. */
  let releases = 0;
  let hiddenTimer: unknown = null;
  let inactiveTimer: unknown = null;
  let stopped = false;

  const releaseGeometry = () => {
    const spare = geometry;
    geometry = null;
    spare?.worker.terminate();
    spare?.settle?.(); // a terminated worker never answers: settle a pending warm-up here
  };

  const releaseAll = (why: string) => {
    releases++;
    cancelIdle?.(); cancelIdle = null;
    releaseGeometry();
    deps.parser.release();
    released = true;
    deps.log?.(`[fast-path] spares released (${why})`);
  };

  const resetInactivity = () => {
    if (inactiveTimer !== null) deps.clearTimer(inactiveTimer);
    inactiveTimer = deps.setTimer(() => { inactiveTimer = null; releaseAll('inactive'); }, INACTIVE_RELEASE_MS);
  };

  const prepareGeometry = (module: WebAssembly.Module, samples: Uint8Array[]): Promise<void> => {
    let worker: Worker;
    try { worker = deps.spawnGeometryWorker(); } catch { return Promise.resolve(); }
    const spare: GeometrySpare = { worker, ready: false };
    geometry = spare;
    return new Promise<void>((resolve) => {
      spare.settle = () => { spare.settle = undefined; worker.onmessage = null; worker.onerror = null; resolve(); };
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data as { type?: string } | null;
        if (msg?.type === 'ready' && geometry === spare) spare.ready = true;
        else if (geometry === spare) releaseGeometry();
        spare.settle?.();
      };
      worker.onerror = () => { if (geometry === spare) releaseGeometry(); spare.settle?.(); };
      worker.postMessage({ type: 'prewarm', wasmModule: module, warmBytes: samples, settings: WARM_SETTINGS });
    });
  };

  const prepare = async () => {
    cancelIdle = null;
    if (stopped || preparing || deps.isLoading() || deps.isHidden()) return;
    if ((!parts.geometry || geometry) && (!parts.parser || deps.parser.has())) return;
    preparing = true;
    const generation = releases;
    try {
      const module = await deps.compileModule();
      if (!module || stopped) return;
      const samples = await deps.warmSamples();
      // Checked again after every await: never start a spare while a load runs.
      if (stopped || deps.isLoading()) return;
      if (parts.parser && !deps.parser.has()) {
        let warmSource: SharedArrayBuffer | null = null;
        if (samples[0] && typeof SharedArrayBuffer !== 'undefined') {
          warmSource = new SharedArrayBuffer(samples[0].byteLength);
          new Uint8Array(warmSource).set(samples[0]);
        }
        await deps.parser.prepare({ warmSource });
      }
      if (stopped || deps.isLoading()) return;
      if (parts.geometry && !geometry) await prepareGeometry(module, samples);
      if (generation !== releases) return; // released meanwhile: stay released, so the next visible input re-arms
      released = false;
      resetInactivity();
      if (!parts.geometry || geometry?.ready) deps.log?.('[fast-path] spares ready');
    } catch (err) {
      deps.log?.(`[fast-path] preparation skipped: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      preparing = false;
    }
  };

  const arm = () => {
    if (stopped || cancelIdle || deps.isLoading()) return;
    cancelIdle = deps.whenIdle(() => { void prepare(); });
  };

  const startRun = (spare: GeometrySpare, file: File, settings: GeometryMeshingSettings): FastGeometryRun => {
    const { worker } = spare;
    const queue: StreamingGeometryEvent[] = [];
    let waiter: { resolve: () => void } | null = null;
    let ended = false;
    let failure: Error | null = null;
    let sawEvent = false;
    let timer: unknown = null;
    const wake = () => { const w = waiter; waiter = null; w?.resolve(); };
    const finish = (err: Error | null) => {
      if (ended) return;
      ended = true;
      failure = err;
      if (timer !== null) { deps.clearTimer(timer); timer = null; }
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      wake();
    };
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; event?: StreamingGeometryEvent; message?: string } | null;
      if (msg?.type === 'event' && msg.event) {
        if (!sawEvent) { sawEvent = true; if (timer !== null) { deps.clearTimer(timer); timer = null; } }
        queue.push(msg.event);
        wake();
      } else if (msg?.type === 'end') finish(null);
      else if (msg?.type === 'error') finish(new Error(msg.message ?? 'fast-path worker error'));
    };
    worker.onerror = (e) => finish(new Error(e.message || 'fast-path worker failed'));
    timer = deps.setTimer(() => { timer = null; if (!sawEvent) finish(new Error('fast-path worker sent no first event')); }, FAST_RUN_FIRST_EVENT_MS);
    worker.postMessage({ type: 'run', file, settings, workerCountOverride: deps.workerCountOverride() });
    const events: AsyncIterable<StreamingGeometryEvent> = {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<StreamingGeometryEvent>> {
          for (;;) {
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            if (ended) {
              if (failure) throw failure;
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => { waiter = { resolve }; });
          }
        },
      }),
    };
    return {
      file, settings, events,
      cancel: () => {
        if (ended) return;
        try { worker.postMessage({ type: 'cancel' }); } catch { /* terminated below anyway */ }
        finish(new Error('fast-path run cancelled'));
      },
    };
  };

  const starter: PickStarter = (ctx) => {
    // Only a new primary load supersedes a pending run; a federated add never touches it.
    if (ctx.target.kind !== 'primary') return;
    pending?.cancel();
    pending = null;
    if (!fastPathEligible(ctx) || !geometry?.ready) return;
    const spare = geometry;
    geometry = null; // consumed: the refill waits for this load to end
    pending = startRun(spare, ctx.file, deps.settingsAtPick(ctx.file));
  };

  const claimer = (file: File, settings: GeometryMeshingSettings, claim: FastClaim): FastGeometryRun | null => {
    const run = pending;
    // Another load's run (a federated add, or a load the pick superseded) is left alone.
    if (!run || run.file !== file || claim.target !== 'primary') return null;
    pending = null;
    if (!claim.sourceIsFile || !sameMeshingSettings(run.settings, settings)) {
      run.cancel();
      deps.log?.(`[fast-path] ${claim.sourceIsFile ? 'the load meshes with other settings than the pick' : 'the load parses other bytes than the picked file (archive)'}; normal pipeline`);
      return null;
    }
    deps.log?.('[fast-path] run claimed');
    return run;
  };

  const unsubscribers = [
    deps.registerPickStarter(starter),
    deps.setClaimer(claimer),
    deps.subscribeLoading((loading) => {
      if (loading) {
        cancelIdle?.(); cancelIdle = null;
        // A geometry spare still warming up would mesh warm samples during the load: drop it.
        if (geometry && !geometry.ready) releaseGeometry();
        return;
      }
      // The load ended: a run it never claimed (cache hit, other format, error) is dropped; refill.
      pending?.cancel();
      pending = null;
      arm();
    }),
    deps.onVisibilityChange(() => {
      if (deps.isHidden()) {
        if (hiddenTimer === null) hiddenTimer = deps.setTimer(() => { hiddenTimer = null; releaseAll('hidden'); }, HIDDEN_RELEASE_MS);
        return;
      }
      if (hiddenTimer !== null) { deps.clearTimer(hiddenTimer); hiddenTimer = null; }
      if (released) arm();
    }),
    deps.onInput(() => {
      if (released) { arm(); return; }
      if (inactiveTimer !== null) resetInactivity();
    }),
  ];

  arm();

  return {
    stop() {
      stopped = true;
      for (const off of unsubscribers) off();
      if (hiddenTimer !== null) deps.clearTimer(hiddenTimer);
      if (inactiveTimer !== null) deps.clearTimer(inactiveTimer);
      pending?.cancel();
      pending = null;
      releaseAll('stopped');
    },
    state: () => ({
      geometrySpare: geometry ? (geometry.ready ? 'ready' : 'warming') : 'none',
      parserSpare: deps.parser.has(),
      pendingRun: pending !== null,
      released,
    }),
  };
}
