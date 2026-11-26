/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `processParallel` decides the global instance plan once per load, before any worker exists. An unplanned load
 *  reports `false` at once; a planned one reports only when its prepass columns arm the plan, which these loads,
 *  ended by a worker that refuses to start, never reach. */

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
  it('reports an unplanned load at once, and a planned one not before its columns', async () => {
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES, { globalInstancing: true })).toEqual([]);
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES - 1, { globalInstancing: true }), 'small tier').toEqual([false]);
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES, { globalInstancing: false })).toEqual([false]);
  });

  it('falls back to the explicit flag when the host does not decide', async () => {
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES, {})).toEqual([false]);
    g.__IFC_LITE_GLOBAL_INSTANCING = 1;
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES, {})).toEqual([]);
  });

  it('never plans or reports for a load with instancing off', async () => {
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES - 1, { globalInstancing: true, enableInstancing: false })).toEqual([]);
    expect(await decisions(GLOBAL_INSTANCING_MIN_BYTES, { globalInstancing: true, enableInstancing: false })).toEqual([]);
  });
});
