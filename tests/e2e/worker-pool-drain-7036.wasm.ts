/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compileSharedWasmModule } from '../../packages/geometry/src/wasm-shared-module.js';
import { getWarmGeometryWorkerPool, prewarmGeometryWorkers, releaseWarmGeometryWorkers,
  warmGeometryWorkerPoolStats } from '../../packages/geometry/src/warm-pool.js';
import { scheduleWasmPrewarm } from '../../apps/viewer/src/lib/wasm-prewarm.js';

let pending: Promise<number> | undefined;
let mode: 'direct' | 'boot';
const realmId = crypto.randomUUID();

/** A navigation/HMR replacement cannot qualify a pending warmup from the old realm. */
export function poolWitnessState() {
  return { realmId, timeOrigin: performance.timeOrigin, mode: mode ?? null,
    stats: warmGeometryWorkerPoolStats() };
}

/** No fake Worker or readiness response: the retained HTTP gate delays real engine compilation. */
export function beginWarmup(kind: 'direct' | 'boot', wasmUrl: string): void {
  mode = kind;
  (globalThis as typeof globalThis & { __IFC_LITE_WARM_POOL?: number }).__IFC_LITE_WARM_POOL = 1;
  if (kind === 'direct') pending = prewarmGeometryWorkers({ wasmUrl, workerCountOverride: 1 });
  else scheduleWasmPrewarm();
}

export function drainPendingWarmup(): void { releaseWarmGeometryWorkers('memory-pressure-regression'); }

export async function settledRetiredWarmup(wasmUrl: string) {
  const module = await compileSharedWasmModule(mode === 'direct' ? wasmUrl : undefined);
  if (!module) throw new Error('Actual source-built engine did not compile');
  const started = pending ? await pending : undefined;
  // Boot is fire-and-forget. A task checkpoint after genuine compilation lets
  // its resolved-promise continuations drain; this is not an elapsed readiness
  // estimate. Ready/reset acknowledgements are independently awaited below.
  await new Promise(resolve => setTimeout(resolve, 0));
  return { compiled: module instanceof WebAssembly.Module, started, stats: warmGeometryWorkerPoolStats() };
}

/** Positive control: a NEW request after the pressure epoch can create and reset genuine workers. */
export async function newWarmupAfterDrain(wasmUrl: string) {
  const started = await prewarmGeometryWorkers({ wasmUrl: mode === 'direct' ? wasmUrl : undefined, workerCountOverride: 1 });
  const pool = getWarmGeometryWorkerPool();
  if (!pool) throw new Error('New explicit warmup did not reach the pool');
  const deadline = performance.now() + 20_000;
  while (pool.stats().idle !== 2 && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const ready = pool.stats();
  if (ready.idle !== 2) throw new Error('Actual workers did not acknowledge initialized readiness');
  const heaps = await Promise.all((['geometry', 'prepass'] as const).map(async role => {
    const lease = pool.acquire(role, mode === 'direct' ? wasmUrl : '');
    let measuredHeap: number | undefined;
    const observe = ({ data }: MessageEvent<{ type?: string; wasmHeapBytes?: number }>) => {
      if (data.type === 'pool-reset-done') measuredHeap = data.wasmHeapBytes;
    };
    lease.worker.addEventListener('message', observe);
    try {
      if (!await pool.release(lease.worker)) throw new Error('Actual new worker did not reset successfully');
      return measuredHeap;
    } finally { lease.worker.removeEventListener('message', observe); }
  }));
  return { started, ready, heaps, reset: pool.stats() };
}

export function disposeWarmup(): void { releaseWarmGeometryWorkers('native-drain-witness-end'); }
