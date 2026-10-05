/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6962: the render-side perf config modules read their `__IFC_LITE_*`
 * globals through the central perf-flag registry. Pinned through the config
 * modules themselves (not the registry), so the assertions describe what the
 * renderer actually receives:
 *   - the legacy global names keep working exactly (aliases);
 *   - each flag's registry URL param applies when the global is unset;
 *   - an explicitly set global still beats the URL param.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getLodScreenPx } from './lodConfig.js';
import { getGpuResidencyBudgetBytes, getHostResidencyBudgetBytes } from './gpuBudgetConfig.js';
import { isQuantizedEnabled } from './quantizedConfig.js';
import { getSpatialChunkingConfig } from './spatialChunkConfig.js';
import { getContributionCullConfig, DEFAULT_CONTRIBUTION_CULL } from './renderCullConfig.js';

const GLOBALS = [
  '__IFC_LITE_LOD_PX',
  '__IFC_LITE_GPU_BUDGET_MB',
  '__IFC_LITE_HOST_BUDGET_MB',
  '__IFC_LITE_QUANTIZED',
  '__IFC_LITE_CHUNKS',
  '__IFC_LITE_CONTRIB_CULL',
] as const;

const g = globalThis as Record<string, unknown>;
const MB = 1024 * 1024;

function setSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
}

afterEach(() => {
  for (const name of GLOBALS) delete g[name];
  Reflect.deleteProperty(globalThis, 'location');
});

describe('perf config defaults (nothing set)', () => {
  it('resolves every shipped default', () => {
    assert.equal(getLodScreenPx(), 48);
    assert.equal(getGpuResidencyBudgetBytes(), 2048 * MB);
    assert.equal(getHostResidencyBudgetBytes(), 3072 * MB);
    assert.equal(isQuantizedEnabled(), true);
    assert.deepEqual(getSpatialChunkingConfig(), { cellSize: 32 });
    assert.deepEqual(getContributionCullConfig(), DEFAULT_CONTRIBUTION_CULL);
  });
});

describe('legacy __IFC_LITE_* globals keep working', () => {
  it('honours each kill switch', () => {
    g.__IFC_LITE_LOD_PX = 0;
    g.__IFC_LITE_GPU_BUDGET_MB = 0;
    g.__IFC_LITE_HOST_BUDGET_MB = 0;
    g.__IFC_LITE_QUANTIZED = 0;
    g.__IFC_LITE_CHUNKS = 0;
    g.__IFC_LITE_CONTRIB_CULL = 0;
    assert.equal(getLodScreenPx(), null);
    assert.equal(getGpuResidencyBudgetBytes(), null);
    assert.equal(getHostResidencyBudgetBytes(), null);
    assert.equal(isQuantizedEnabled(), false);
    assert.equal(getSpatialChunkingConfig(), null);
    assert.equal(getContributionCullConfig(), undefined);
  });

  it('honours custom values', () => {
    g.__IFC_LITE_LOD_PX = 80;
    g.__IFC_LITE_GPU_BUDGET_MB = 512;
    g.__IFC_LITE_CHUNKS = { cellSize: 16 };
    g.__IFC_LITE_CONTRIB_CULL = 1.5;
    assert.equal(getLodScreenPx(), 80);
    assert.equal(getGpuResidencyBudgetBytes(), 512 * MB);
    assert.deepEqual(getSpatialChunkingConfig(), { cellSize: 16 });
    assert.deepEqual(getContributionCullConfig(), { pixelRadius: 1.5, interactingPixelRadius: 6 });
  });
});

describe('registry URL params (?perf.<id>=...)', () => {
  it('apply kill switches when no global is set', () => {
    setSearch('?perf.lodPx=0&perf.gpuBudgetMb=0&perf.hostBudgetMb=0&perf.quantized=0&perf.chunks=0&perf.contribCull=0');
    assert.equal(getLodScreenPx(), null);
    assert.equal(getGpuResidencyBudgetBytes(), null);
    assert.equal(getHostResidencyBudgetBytes(), null);
    assert.equal(isQuantizedEnabled(), false);
    assert.equal(getSpatialChunkingConfig(), null);
    assert.equal(getContributionCullConfig(), undefined);
  });

  it('parse numbers and JSON objects the same way a global takes them', () => {
    setSearch(`?perf.lodPx=96&perf.chunks=${encodeURIComponent('{"cellSize":8}')}&perf.contribCull=2`);
    assert.equal(getLodScreenPx(), 96);
    assert.deepEqual(getSpatialChunkingConfig(), { cellSize: 8 });
    assert.deepEqual(getContributionCullConfig(), { pixelRadius: 2, interactingPixelRadius: 8 });
  });

  it('lose to an explicitly set global', () => {
    setSearch('?perf.lodPx=0&perf.chunks=0');
    g.__IFC_LITE_LOD_PX = 64;
    g.__IFC_LITE_CHUNKS = 16;
    assert.equal(getLodScreenPx(), 64);
    assert.deepEqual(getSpatialChunkingConfig(), { cellSize: 16 });
  });
});
