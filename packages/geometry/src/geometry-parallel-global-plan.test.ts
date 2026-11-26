/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `processParallel` decides the global instance plan once per load, before any worker exists, and reports it. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
import { GLOBAL_INSTANCING_MIN_BYTES } from './perf-flags.js';
import type { ProcessParallelOptions } from './geometry-parallel-options.js';

const g = globalThis as Record<string, unknown>;
const originalWorker = g.Worker;
afterEach(() => {
  g.Worker = originalWorker;
  delete g.__IFC_LITE_GLOBAL_INSTANCING;
  vi.restoreAllMocks();
});

/** Run a load up to its first worker (which refuses to start) and return the decisions it reported. */
async function decisions(bytes: number, options: ProcessParallelOptions): Promise<boolean[]> {
  g.Worker = vi.fn().mockImplementation(() => { throw new Error('no workers in this test'); }) as unknown as typeof Worker;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const decided: boolean[] = [];
  const gen = processParallel(new Uint8Array(bytes), new CoordinateHandler(), undefined, undefined, {
    workerCountOverride: 1, ...options, onGlobalInstancingDecision: (applies) => decided.push(applies),
  });
  try {
    for (let i = 0; i < 10; i++) if ((await gen.next()).done) break;
  } catch { /* the refused worker ends the load */ }
  return decided;
}

describe('processParallel global instance plan decision', () => {
  it('reports one decision per load from the host flag, past the small tier only', async () => {
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES, { globalInstancing: true })).toEqual([true]);
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES - 1, { globalInstancing: true })).toEqual([false]);
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES, { globalInstancing: false })).toEqual([false]);
  });

  it('falls back to the explicit flag when the host does not decide', async () => {
    g.__IFC_LITE_GLOBAL_INSTANCING = 1;
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES, {})).toEqual([true]);
  });

  it('never plans or reports an arm for a load with instancing off (a federated add)', async () => {
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES, { globalInstancing: true, enableInstancing: false })).toEqual([]);
  });
});
