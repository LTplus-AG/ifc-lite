/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The realm's one pool of prewarmed geometry workers (#7036) and the calls a
 * host uses to fill and empty it. Behind the `warmPool` perf flag: with the
 * experiment disabled, `getWarmGeometryWorkerPool()` is null, nothing is prewarmed
 * and every load spawns its own workers exactly as before.
 */

import { GeometryWorkerPool, type GeometryWorkerPoolStats } from './geometry-worker-pool.js';
import { postGeometryWorkerInit } from './geometry-worker-init.js';
import { readWarmPoolFlag } from './perf-flags.js';
import { compileSharedWasmModule } from './wasm-shared-module.js';
import { planLoadWorkerCount } from './worker-count.js';

let shared: GeometryWorkerPool | null = null;

/** The shared pool, or null when the flag is off or the realm has no workers. */
export function getWarmGeometryWorkerPool(): GeometryWorkerPool | null {
  if (typeof Worker === 'undefined' || !readWarmPoolFlag()) return null;
  return (shared ??= new GeometryWorkerPool());
}

/**
 * Fill the pool with the workers a parallel load of `fileSizeMB` will use (its
 * geometry workers plus the pre-pass worker), each with the engine
 * instantiated from the shared compiled module. Call it as soon as a load is
 * requested, so the spawn overlaps the file read. Resolves to the number of
 * workers started (0 when the pool is off, already holds them, or the module
 * could not be compiled: the load then spawns as before).
 */
export async function prewarmGeometryWorkers(
  options: { fileSizeMB?: number; workerCountOverride?: number; wasmUrl?: string } = {},
): Promise<number> {
  const pool = getWarmGeometryWorkerPool();
  if (!pool) return 0;
  const module = await compileSharedWasmModule(options.wasmUrl);
  if (!module) return 0;
  const { count } = planLoadWorkerCount(options.fileSizeMB ?? 8, options.workerCountOverride);
  return pool.prewarm(count + 1, options.wasmUrl ?? '', (worker) => postGeometryWorkerInit(worker, undefined, module));
}

/** Terminate every idle prewarmed worker (memory pressure, a hidden tab, a resource-limit retry). */
export function releaseWarmGeometryWorkers(reason = 'release'): number {
  return shared?.drain(reason) ?? 0;
}

/** Idle-pool counters for `?perfMem=1` and the benchmark guards; null before the pool exists. */
export function warmGeometryWorkerPoolStats(): GeometryWorkerPoolStats | null {
  return shared?.stats() ?? null;
}
