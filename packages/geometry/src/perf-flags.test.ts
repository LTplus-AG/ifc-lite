/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { readPerfFlagRaw } from '@ifc-lite/data';
import { GEOMETRY_PERF_FLAG_BINDINGS, readOutOfCoreBudgetBytes, readOutOfCoreFlag } from './perf-flags.js';

const g = globalThis as Record<string, unknown>;

afterEach(() => {
  for (const { global } of Object.values(GEOMETRY_PERF_FLAG_BINDINGS)) delete g[global];
  Reflect.deleteProperty(globalThis, 'location');
});

describe('GEOMETRY_PERF_FLAG_BINDINGS', () => {
  it('keep the legacy global names', () => {
    expect(Object.values(GEOMETRY_PERF_FLAG_BINDINGS).map((b) => b.global).sort()).toEqual([
      '__IFC_LITE_BATCH_SIZING',
      '__IFC_LITE_GLOBAL_INSTANCING',
      '__IFC_LITE_OOC',
      '__IFC_LITE_OOC_BUDGET_MB',
      '__IFC_LITE_SHARD_SCAN',
      '__IFC_LITE_VISIBILITY_FILTER',
    ]);
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

describe('out-of-core flags', () => {
  it('is off unless set to 1 or true', () => {
    expect(readOutOfCoreFlag()).toBe(false);
    for (const [value, on] of [[1, true], ['1', true], [true, true], ['true', true], [0, false], ['0', false], ['file', false], [null, false]] as const) {
      g.__IFC_LITE_OOC = value;
      expect(readOutOfCoreFlag()).toBe(on);
    }
  });

  it('reads the arena budget in MiB, 192 for anything that is not a positive number', () => {
    expect(readOutOfCoreBudgetBytes()).toBe(192 * 1024 * 1024);
    g.__IFC_LITE_OOC_BUDGET_MB = 64;
    expect(readOutOfCoreBudgetBytes()).toBe(64 * 1024 * 1024);
    for (const value of [0, -8, 'x', Number.NaN]) {
      g.__IFC_LITE_OOC_BUDGET_MB = value;
      expect(readOutOfCoreBudgetBytes()).toBe(192 * 1024 * 1024);
    }
  });
});
