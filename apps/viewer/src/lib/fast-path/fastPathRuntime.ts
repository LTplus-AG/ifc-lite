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
import { sameMeshingSettings, type FastGeometryRun } from '@/hooks/ingest/fastPath';

/** Largest file the fast path takes: the uncached tier, where one engine session is fast. */
export const FAST_PATH_MAX_BYTES = 10 * 1024 * 1024;
export const HIDDEN_RELEASE_MS = 5 * 60_000;
export const INACTIVE_RELEASE_MS = 20 * 60_000;
/** A run that has not answered by then is abandoned; the load falls back to the normal pipeline. */
export const FAST_RUN_TIMEOUT_MS = 15_000;

/** Settings the warm-up meshes with (any; it only compiles the engine's hot paths). */
const WARM_SETTINGS: GeometryMeshingSettings = {
  mergeLayers: false, enableInstancing: true, tessellationQuality: null,
  skipSmallCuts: false, skipVoids: false, geometryHashTolerance: 1e-3,
};

/** Whether a pick may take the fast path. */
export function fastPathEligible(ctx: PickStartContext): boolean {
  return ctx.target.kind === 'primary' && ctx.kernel.kind === 'exact' && !ctx.retry
    && /\.ifc$/i.test(ctx.file.name) && ctx.file.size > 0 && ctx.file.size <= FAST_PATH_MAX_BYTES;
}

export interface FastPathDeps {
  /** Off switch and device gates (warm-runtime-gate `mayWarmUp`). */
  allowed(): boolean;
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
  registerPickStarter(starter: PickStarter): () => void;
  setClaimer(claimer: (file: File, settings: GeometryMeshingSettings) => FastGeometryRun | null): () => void;
  log?(message: string): void;
}

interface GeometrySpare { worker: Worker; ready: boolean }

export interface FastPathRuntime {
  stop(): void;
  /** For tests and diagnostics. */
  state(): { geometrySpare: 'none' | 'warming' | 'ready'; parserSpare: boolean; pendingRun: boolean; released: boolean };
}

export function createFastPathRuntime(deps: FastPathDeps): FastPathRuntime | null {
  if (!deps.allowed()) return null;

  let geometry: GeometrySpare | null = null;
  let pending: FastGeometryRun | null = null;
  let cancelIdle: (() => void) | null = null;
  let preparing = false;
  let released = false;
  let hiddenTimer: unknown = null;
  let inactiveTimer: unknown = null;
  let stopped = false;

  const releaseGeometry = () => {
    const spare = geometry;
    geometry = null;
    spare?.worker.terminate();
  };

  const releaseAll = (why: string) => {
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
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data as { type?: string } | null;
        worker.onmessage = null;
        if (msg?.type === 'ready' && geometry === spare) spare.ready = true;
        else if (geometry === spare) releaseGeometry();
        resolve();
      };
      worker.onerror = () => { if (geometry === spare) releaseGeometry(); resolve(); };
      worker.postMessage({ type: 'prewarm', wasmModule: module, warmBytes: samples, settings: WARM_SETTINGS });
    });
  };

  const prepare = async () => {
    cancelIdle = null;
    if (stopped || preparing || deps.isLoading() || deps.isHidden()) return;
    if (geometry && deps.parser.has()) return;
    preparing = true;
    try {
      const module = await deps.compileModule();
      if (!module || stopped) return;
      const samples = await deps.warmSamples();
      // Checked again after every await: never start a spare while a load runs.
      if (stopped || deps.isLoading()) return;
      if (!deps.parser.has()) {
        let warmSource: SharedArrayBuffer | null = null;
        if (samples[0] && typeof SharedArrayBuffer !== 'undefined') {
          warmSource = new SharedArrayBuffer(samples[0].byteLength);
          new Uint8Array(warmSource).set(samples[0]);
        }
        await deps.parser.prepare({ warmSource });
      }
      if (stopped || deps.isLoading()) return;
      if (!geometry) await prepareGeometry(module, samples);
      released = false;
      resetInactivity();
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
    let settled = false;
    let timer: unknown = null;
    let rejectRun: (reason: unknown) => void = () => {};
    const finish = () => {
      settled = true;
      if (timer !== null) deps.clearTimer(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const events = new Promise<StreamingGeometryEvent[]>((resolve, reject) => {
      rejectRun = reject;
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data as { type?: string; events?: StreamingGeometryEvent[]; message?: string } | null;
        if (msg?.type === 'result' && msg.events) { finish(); resolve(msg.events); }
        else if (msg?.type === 'error') { finish(); reject(new Error(msg.message ?? 'fast-path worker error')); }
      };
      worker.onerror = (e) => { finish(); reject(new Error(e.message || 'fast-path worker failed')); };
      timer = deps.setTimer(() => { timer = null; if (!settled) { finish(); reject(new Error('fast-path worker timed out')); } }, FAST_RUN_TIMEOUT_MS);
      worker.postMessage({ type: 'run', file, settings });
    });
    events.catch(() => {}); // an unclaimed run's failure is nobody's error
    return {
      file, settings, events,
      cancel: () => { if (!settled) { finish(); rejectRun(new Error('fast-path run cancelled')); } },
    };
  };

  const starter: PickStarter = (ctx) => {
    pending?.cancel();
    pending = null;
    if (!fastPathEligible(ctx) || !geometry?.ready) return;
    const spare = geometry;
    geometry = null; // consumed: the refill waits for this load to end
    pending = startRun(spare, ctx.file, deps.settingsAtPick(ctx.file));
  };

  const claimer = (file: File, settings: GeometryMeshingSettings): FastGeometryRun | null => {
    const run = pending;
    pending = null;
    if (!run) return null;
    if (run.file !== file || !sameMeshingSettings(run.settings, settings)) {
      run.cancel();
      deps.log?.('[fast-path] the load meshes with other settings than the pick; normal pipeline');
      return null;
    }
    return run;
  };

  const unsubscribers = [
    deps.registerPickStarter(starter),
    deps.setClaimer(claimer),
    deps.subscribeLoading((loading) => {
      if (loading) { cancelIdle?.(); cancelIdle = null; return; }
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
