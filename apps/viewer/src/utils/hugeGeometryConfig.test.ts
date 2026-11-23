/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDrawStreamConfig, HUGE_GEOMETRY_DRAW_STREAM } from './drawStreamConfig.js';
import { isGpuInstancingEnabled } from './gpuInstancingConfig.js';
import { isHugeGeometryEnabled } from './hugeGeometryConfig.js';

const g = globalThis as Record<string, unknown>;

function setSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
}

afterEach(() => {
  for (const name of ['__IFC_LITE_HUGE', '__IFC_LITE_M6__', '__IFC_LITE_GPU_INSTANCING']) delete g[name];
  Reflect.deleteProperty(globalThis, 'location');
});

describe('huge-geometry umbrella', () => {
  it('is off with no flag set and leaves both paths off', () => {
    assert.equal(isHugeGeometryEnabled(), false);
    assert.equal(getDrawStreamConfig().stream, false);
    assert.equal(isGpuInstancingEnabled(), false);
  });

  it('turns on the stream, arenas, HLOD, highlight index and GPU instancing, not the frame budget', () => {
    setSearch('?perf.huge=1');
    const config = getDrawStreamConfig();
    assert.deepEqual(config, { ...HUGE_GEOMETRY_DRAW_STREAM });
    assert.deepEqual([config.stream, config.arena, config.hlod, config.hlIndex, config.bundles, config.budgetMs], [true, true, true, true, true, 0]);
    assert.equal(isGpuInstancingEnabled(), true);
  });

  it('lets each path flag turn one part off under the umbrella', () => {
    g.__IFC_LITE_HUGE = 1;
    setSearch('?m6.hlod=0&perf.gpuInstancing=0');
    const config = getDrawStreamConfig();
    assert.deepEqual([config.stream, config.arena, config.hlod], [true, true, false]);
    assert.equal(isGpuInstancingEnabled(), false);
  });
});

describe('PostHog ramps for the huge-geometry paths', () => {
  const posthog = (values: Record<string, unknown>) => (key: string) => values[key];

  it('turns each path on from its ramp when nothing else is set', () => {
    assert.equal(getDrawStreamConfig(posthog({ 'perf-draw-stream': true })).stream, true);
    assert.equal(isGpuInstancingEnabled(posthog({ 'perf-gpu-instancing': true })), true);
  });

  it('keeps each path off when its ramp says false or has no value', () => {
    assert.equal(getDrawStreamConfig(posthog({ 'perf-draw-stream': false })).stream, false);
    assert.equal(isGpuInstancingEnabled(posthog({ 'perf-gpu-instancing': false })), false);
    assert.equal(getDrawStreamConfig(posthog({})).stream, false);
    assert.equal(isGpuInstancingEnabled(posthog({})), false);
  });

  it('lets the umbrella beat a ramp that is off for this user', () => {
    setSearch('?perf.huge=1');
    assert.equal(getDrawStreamConfig(posthog({ 'perf-draw-stream': false })).stream, true);
    assert.equal(isGpuInstancingEnabled(posthog({ 'perf-gpu-instancing': false })), true);
  });

  it('lets an explicit flag beat the ramp', () => {
    setSearch('?m6.stream=0&perf.gpuInstancing=0');
    assert.equal(getDrawStreamConfig(posthog({ 'perf-draw-stream': true })).stream, false);
    assert.equal(isGpuInstancingEnabled(posthog({ 'perf-gpu-instancing': true })), false);
  });
});
