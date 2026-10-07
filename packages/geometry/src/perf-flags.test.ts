/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { readPerfFlagRaw } from '@ifc-lite/data';
import { GEOMETRY_PERF_FLAG_BINDINGS } from './perf-flags.js';

const g = globalThis as Record<string, unknown>;

afterEach(() => {
  for (const { global } of Object.values(GEOMETRY_PERF_FLAG_BINDINGS)) delete g[global];
  Reflect.deleteProperty(globalThis, 'location');
});

describe('GEOMETRY_PERF_FLAG_BINDINGS', () => {
  it('keep the legacy global names', () => {
    expect(Object.values(GEOMETRY_PERF_FLAG_BINDINGS).map((b) => b.global).sort()).toEqual([
      '__IFC_LITE_BATCH_SIZING',
      '__IFC_LITE_SHARD_SCAN',
      '__IFC_LITE_VISIBILITY_FILTER',
      '__IFC_LITE_WARM_POOL',
    ]);
  });

  it('keep unaccepted warm-up opt-in (#7036)', async () => {
    const { readWarmPoolFlag } = await import('./perf-flags.js') as { readWarmPoolFlag?: () => boolean };
    expect(typeof readWarmPoolFlag).toBe('function');
    expect(readWarmPoolFlag!()).toBe(false);
    for (const off of [0, '0', false]) {
      g.__IFC_LITE_WARM_POOL = off;
      expect(readWarmPoolFlag!()).toBe(false);
    }
    for (const on of [1, '1', true]) {
      g.__IFC_LITE_WARM_POOL = on;
      expect(readWarmPoolFlag!()).toBe(true);
    }
    delete g.__IFC_LITE_WARM_POOL;
    Object.defineProperty(globalThis, 'location', { value: { search: '?perf.warmPool=0' }, configurable: true });
    expect(readWarmPoolFlag!()).toBe(false);
    Object.defineProperty(globalThis, 'location', { value: { search: '?perf.warmPool=1' }, configurable: true });
    expect(readWarmPoolFlag!()).toBe(true);
  });

  it('resolve the legacy global first, then the URL param', () => {
    const { shardScan, batchSizing } = GEOMETRY_PERF_FLAG_BINDINGS;
    Object.defineProperty(globalThis, 'location', {
      value: { search: `?perf.shardScan=0&perf.batchSizing=${encodeURIComponent('{"targetMs":8000}')}` },
      configurable: true,
    });
    expect(readPerfFlagRaw(shardScan)).toBe(0);
    expect(readPerfFlagRaw(batchSizing)).toEqual({ targetMs: 8000 });
    g.__IFC_LITE_SHARD_SCAN = 1;
    expect(readPerfFlagRaw(shardScan)).toBe(1);
  });
});
