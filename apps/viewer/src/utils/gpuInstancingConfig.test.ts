/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { decideGlobalInstancing, globalInstancingApplies, GLOBAL_INSTANCING_MIN_BYTES, setGlobalInstancingRamp } from '@ifc-lite/geometry';
import { activePerfFlags, recordAppliedPerfFlag } from '../lib/perf/flags-applied.js';
import { configureGpuInstancing, configureKeyedInstancing, installGlobalInstancingRamp, isGpuInstancingEnabled } from './gpuInstancingConfig.js';

const g = globalThis as Record<string, unknown>;

function setSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
}

afterEach(() => {
  delete g.__IFC_LITE_GPU_INSTANCING;
  delete g.__IFC_LITE_GLOBAL_INSTANCING;
  setGlobalInstancingRamp(undefined);
  recordAppliedPerfFlag('globalInstancing', undefined);
  Reflect.deleteProperty(globalThis, 'location');
});

describe('GPU-driven instancing config', () => {
  it('is off with no flag set and leaves the renderer untouched', () => {
    assert.equal(isGpuInstancingEnabled(), false);
    const calls: boolean[] = [];
    assert.equal(configureGpuInstancing({ setGpuInstancing: (on) => { calls.push(on); return true; } }), false);
    assert.deepEqual(calls, []);
  });

  it('turns on from the URL param or the global', () => {
    setSearch('?perf.gpuInstancing=1');
    assert.equal(isGpuInstancingEnabled(), true);
    const calls: boolean[] = [];
    assert.equal(configureGpuInstancing({ setGpuInstancing: (on) => { calls.push(on); return true; } }), true);
    assert.deepEqual(calls, [true]);
    Reflect.deleteProperty(globalThis, 'location');
    g.__IFC_LITE_GPU_INSTANCING = true;
    assert.equal(isGpuInstancingEnabled(), true);
  });

  it('reports a refused switch as off', () => {
    setSearch('?perf.gpuInstancing=1');
    assert.equal(configureGpuInstancing({ setGpuInstancing: () => false }), false);
  });

  it('lets an explicit global beat the URL param', () => {
    setSearch('?perf.gpuInstancing=1');
    g.__IFC_LITE_GPU_INSTANCING = 0;
    assert.equal(isGpuInstancingEnabled(), false);
  });
});

describe('keyed instancing config (#11390 follow-up)', () => {
  it('joins keyed records unless the global instance plan is explicitly killed', () => {
    for (const [search, on] of [['', true], ['?perf.globalInstancing=1', true], ['?perf.globalInstancing=0', false]] as const) {
      setSearch(search);
      const scene = { keyedInstancing: { enabled: !on } };
      assert.equal(configureKeyedInstancing(scene), on, search || 'unset');
      assert.equal(scene.keyedInstancing.enabled, on);
    }
  });
});

describe('global instance plan ramp', () => {
  const large = GLOBAL_INSTANCING_MIN_BYTES;
  const posthog = (value: unknown) => (key: string) => (key === 'perf-global-instancing' ? value : undefined);

  it('hands the geometry host the perf-global-instancing ramp', () => {
    installGlobalInstancingRamp(posthog(true));
    assert.equal(globalInstancingApplies(large), true);
    assert.equal(globalInstancingApplies(large - 1), false, 'small files keep the per-batch decision');
    installGlobalInstancingRamp(posthog(false));
    assert.equal(globalInstancingApplies(large), false);
    installGlobalInstancingRamp(posthog(undefined));
    assert.equal(globalInstancingApplies(large), false, 'no PostHog value: off');
  });

  it('lets an explicit param or global beat the ramp', () => {
    installGlobalInstancingRamp(posthog(true));
    setSearch('?perf.globalInstancing=0');
    assert.equal(globalInstancingApplies(large), false);
    Reflect.deleteProperty(globalThis, 'location');
    installGlobalInstancingRamp(posthog(false));
    g.__IFC_LITE_GLOBAL_INSTANCING = 1;
    assert.equal(globalInstancingApplies(large), true);
  });

  it('reports what the pool load decided as the telemetry arm, not the ramp value', () => {
    installGlobalInstancingRamp(posthog(true));
    assert.equal(activePerfFlags().globalInstancing, undefined, 'before a pool decision the load runs the default');
    decideGlobalInstancing(large - 1);
    assert.equal(activePerfFlags().globalInstancing, undefined, 'a small file keeps the per-batch decision');
    decideGlobalInstancing(large);
    assert.equal(activePerfFlags().globalInstancing, 'true');
    installGlobalInstancingRamp(posthog(true));
    assert.equal(activePerfFlags().globalInstancing, undefined, 'each load starts from the default arm');
  });

  it('never kills the keyed join from the ramp: a user outside it still joins cached plan records', () => {
    installGlobalInstancingRamp(posthog(false));
    const scene = { keyedInstancing: { enabled: false } };
    assert.equal(configureKeyedInstancing(scene), true);
  });
});
