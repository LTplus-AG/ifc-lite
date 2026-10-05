/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GEOMETRY_PERF_FLAG_BINDINGS } from '@ifc-lite/geometry';
import {
  PERF_FLAGS,
  activePerfFlags,
  readPerfFlag,
  resolvePerfFlag,
  type PerfFlagDefinition,
} from './flags.js';
import { STICKY_OVERRIDES } from '../../components/viewer/settings/sticky-overrides.js';
import { GEOM_WORKERS_STORAGE_KEY } from '../../store/geomWorkerOverride.js';
import { GEOM_TIER_STORAGE_KEY } from '../../store/geometryFidelity.js';
import { MESH_ONLY_CACHE_STORAGE_KEY } from '../../store/constants.js';

const g = globalThis as Record<string, unknown>;

function setSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
}

afterEach(() => {
  for (const flag of PERF_FLAGS) {
    const global = (flag.bindings as { global?: string }).global;
    if (global) delete g[global];
  }
  Reflect.deleteProperty(globalThis, 'location');
  localStorage.clear();
});

describe('PERF_FLAGS registry', () => {
  it('has unique ids, globals and URL params', () => {
    const ids = PERF_FLAGS.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length);
    const globals = PERF_FLAGS.flatMap((f) => ((f.bindings as { global?: string }).global ?? []));
    assert.equal(new Set(globals).size, globals.length);
    const params = PERF_FLAGS.flatMap((f) => (f.bindings.urlParam ?? []));
    assert.equal(new Set(params).size, params.length);
  });

  it('declares every legacy perf global as an alias', () => {
    const globals = new Set(PERF_FLAGS.flatMap((f) => ((f.bindings as { global?: string }).global ?? [])));
    for (const name of [
      '__IFC_LITE_BATCH_SIZING', '__IFC_LITE_VISIBILITY_FILTER', '__IFC_LITE_SHARD_SCAN',
      '__IFC_LITE_CONTRIB_CULL', '__IFC_LITE_CHUNKS', '__IFC_LITE_GPU_BUDGET_MB',
      '__IFC_LITE_HOST_BUDGET_MB', '__IFC_LITE_LOD_PX', '__IFC_LITE_QUANTIZED',
    ]) {
      assert.ok(globals.has(name), `${name} missing from the registry`);
    }
  });

  it('uses the geometry package bindings verbatim', () => {
    for (const binding of Object.values(GEOMETRY_PERF_FLAG_BINDINGS)) {
      const flag = PERF_FLAGS.find((f) => (f.bindings as { global?: string }).global === binding.global);
      assert.ok(flag, binding.global);
      assert.equal(flag.bindings.urlParam, binding.urlParam);
    }
  });

  it('matches the URL params and sticky keys the override modules actually read', () => {
    const byId = new Map<string, { urlParam?: string; stickyKey?: string }>(PERF_FLAGS.map((f) => [f.id, f.bindings]));
    assert.equal(byId.get('geomWorkers')?.stickyKey, GEOM_WORKERS_STORAGE_KEY);
    assert.equal(byId.get('geomTier')?.stickyKey, GEOM_TIER_STORAGE_KEY);
    assert.equal(byId.get('meshCache')?.stickyKey, MESH_ONLY_CACHE_STORAGE_KEY);
    for (const sticky of STICKY_OVERRIDES) {
      assert.equal(byId.get(sticky.id)?.urlParam, sticky.queryParam, sticky.id);
    }
  });
});

describe('readPerfFlag', () => {
  it('is undefined when nothing is set', () => {
    for (const flag of PERF_FLAGS) assert.equal(readPerfFlag(flag.id), undefined, flag.id);
  });

  it('reads the global, then the URL param, then the sticky key', () => {
    setSearch('?perf.lodPx=0&geomWorkers=4');
    assert.equal(readPerfFlag('lodPx'), 0);
    g.__IFC_LITE_LOD_PX = 80;
    assert.equal(readPerfFlag('lodPx'), 80);
    assert.equal(readPerfFlag('geomWorkers'), '4');
    setSearch('');
    localStorage.setItem(GEOM_WORKERS_STORAGE_KEY, '6');
    assert.equal(readPerfFlag('geomWorkers'), '6');
  });
});

describe('ramps', () => {
  const ramp: PerfFlagDefinition = {
    id: 'exampleRamp',
    kind: 'ramp',
    owner: '@louistrue',
    removalCondition: 'test fixture',
    introducedAt: '2026-10-05',
    default: false,
    bindings: { global: '__IFC_LITE_EXAMPLE_RAMP', posthogKey: 'perf-example-ramp' },
  };

  it('fall back to the default (undefined) when PostHog has no value', () => {
    assert.equal(resolvePerfFlag(ramp, () => undefined), undefined);
    // The real analytics client is not initialised under Node.
    assert.equal(resolvePerfFlag(ramp), undefined);
  });

  it('read the PostHog flag, but an explicit global wins', () => {
    const asked: string[] = [];
    const posthog = (key: string) => { asked.push(key); return true; };
    assert.equal(resolvePerfFlag(ramp, posthog), true);
    assert.deepEqual(asked, ['perf-example-ramp']);
    g.__IFC_LITE_EXAMPLE_RAMP = 0;
    try {
      assert.equal(resolvePerfFlag(ramp, posthog), 0);
    } finally {
      delete g.__IFC_LITE_EXAMPLE_RAMP;
    }
  });

  it('never consults PostHog for a kill switch', () => {
    const killSwitch: PerfFlagDefinition = { ...ramp, kind: 'kill-switch' };
    assert.equal(resolvePerfFlag(killSwitch, () => { throw new Error('consulted'); }), undefined);
  });
});

describe('activePerfFlags', () => {
  it('is empty when every flag runs its default', () => {
    assert.deepEqual(activePerfFlags(), {});
  });

  it('reports only non-default states, compactly', () => {
    g.__IFC_LITE_CHUNKS = 0;
    g.__IFC_LITE_LOD_PX = 48; // explicitly the default: not an arm
    g.__IFC_LITE_VISIBILITY_FILTER = { disabledTypes: ['IFCSPACE'], skipTypeGeometry: true };
    g.__IFC_LITE_BATCH_SIZING = { targetMs: 8000, minJobs: 64, maxJobs: 512, extra: 'x'.repeat(80) };
    setSearch('?perf.quantized=0&meshCache=1');
    const active = activePerfFlags();
    assert.equal(active.chunks, '0');
    assert.equal(active.quantized, '0');
    assert.equal(active.visibilityFilter, '{"disabledTypes":["IFCSPACE"],"skipTypeGeometry":true}');
    assert.equal(active.batchSizing.length, 64);
    assert.ok(!('lodPx' in active));
    assert.ok(!('meshCache' in active), 'meshCache=1 is the default');
    assert.deepEqual(Object.keys(active).sort(), ['batchSizing', 'chunks', 'quantized', 'visibilityFilter']);
  });
});
