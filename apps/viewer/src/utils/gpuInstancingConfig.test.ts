/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureGpuInstancing, isGpuInstancingEnabled } from './gpuInstancingConfig.js';

const g = globalThis as Record<string, unknown>;

function setSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
}

afterEach(() => {
  delete g.__IFC_LITE_GPU_INSTANCING;
  Reflect.deleteProperty(globalThis, 'location');
});

describe('GPU-driven instancing config', () => {
  it('is off with no flag set and leaves the renderer untouched', () => {
    assert.equal(isGpuInstancingEnabled(), false);
    const calls: boolean[] = [];
    assert.equal(configureGpuInstancing({ setGpuInstancing: (on) => calls.push(on) }), false);
    assert.deepEqual(calls, []);
  });

  it('turns on from the URL param or the global', () => {
    setSearch('?perf.gpuInstancing=1');
    assert.equal(isGpuInstancingEnabled(), true);
    const calls: boolean[] = [];
    assert.equal(configureGpuInstancing({ setGpuInstancing: (on) => calls.push(on) }), true);
    assert.deepEqual(calls, [true]);
    Reflect.deleteProperty(globalThis, 'location');
    g.__IFC_LITE_GPU_INSTANCING = true;
    assert.equal(isGpuInstancingEnabled(), true);
  });

  it('lets an explicit global beat the URL param', () => {
    setSearch('?perf.gpuInstancing=1');
    g.__IFC_LITE_GPU_INSTANCING = 0;
    assert.equal(isGpuInstancingEnabled(), false);
  });
});
