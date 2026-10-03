// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOpeningCounters, observeBatches } from './opening-work-diagnostic.mjs';

test('#6537 aggregates job probe-distance maxima separately from additive work', () => {
  const totals = {};
  const jobs = [
    { ringSimplifierMaxPrevProbeDistance: 4, ringSimplifierMaxNextProbeDistance: 9,
      ringSimplifierPrevProbes: 12, ringSimplifierNextProbes: 18, csgOperations: [2, 1, 0, 0] },
    { ringSimplifierMaxPrevProbeDistance: 7, ringSimplifierMaxNextProbeDistance: 3,
      ringSimplifierPrevProbes: 21, ringSimplifierNextProbes: 6, csgOperations: [1, 4, 0, 0] },
    { ringSimplifierMaxPrevProbeDistance: 2, ringSimplifierMaxNextProbeDistance: 12,
      ringSimplifierPrevProbes: 8, ringSimplifierNextProbes: 30, csgOperations: [3, 0, 0, 0] },
  ];
  for (const job of jobs) assert.equal(aggregateOpeningCounters(totals, job), false);
  assert.deepEqual(totals, {
    ringSimplifierMaxPrevProbeDistance: 7, ringSimplifierMaxNextProbeDistance: 12,
    ringSimplifierPrevProbes: 41, ringSimplifierNextProbes: 54, csgOperations: [6, 5, 0, 0],
  });
  aggregateOpeningCounters(totals, jobs[1]);
  assert.equal(totals.ringSimplifierMaxPrevProbeDistance, 7);
  assert.equal(totals.ringSimplifierMaxNextProbeDistance, 12);
  assert.equal(totals.ringSimplifierPrevProbes, 62);
});

test('#6537 preserves exact safe boundaries and saturates additive scalar/array overflow', () => {
  const limit = Number.MAX_SAFE_INTEGER;
  const totals = {};
  assert.equal(aggregateOpeningCounters(totals, {
    ringSimplifierMaxPrevProbeDistance: limit, ringSimplifierMaxNextProbeDistance: 5,
    ringSimplifierPrevProbes: limit - 2, csgOperations: [limit - 3, 1, 0, 0],
  }), false);
  assert.equal(aggregateOpeningCounters(totals, {
    ringSimplifierMaxPrevProbeDistance: limit, ringSimplifierMaxNextProbeDistance: 2,
    ringSimplifierPrevProbes: 2, csgOperations: [3, 2, 0, 0],
  }), false, 'repeated safe maxima do not create additive overflow');
  assert.equal(totals.ringSimplifierPrevProbes, limit);
  assert.deepEqual(totals.csgOperations, [limit, 3, 0, 0]);
  assert.equal(aggregateOpeningCounters(totals, {
    ringSimplifierPrevProbes: 1, csgOperations: [1, 4, 0, 0],
  }), true);
  assert.equal(totals.ringSimplifierPrevProbes, limit);
  assert.deepEqual(totals.csgOperations, [limit, 7, 0, 0]);
});

test('#6537 flags and limits unsafe incoming maxima and additive counts', () => {
  const limit = Number.MAX_SAFE_INTEGER;
  const totals = {};
  assert.equal(aggregateOpeningCounters(totals, {
    ringSimplifierMaxPrevProbeDistance: limit + 1,
    ringSimplifierMaxNextProbeDistance: limit + 1,
    ringSimplifierPrevProbes: limit + 1, csgOperations: [limit + 1, 3, 0, 0],
  }), true);
  assert.deepEqual(totals, {
    ringSimplifierMaxPrevProbeDistance: limit, ringSimplifierMaxNextProbeDistance: limit,
    ringSimplifierPrevProbes: limit, csgOperations: [limit, 3, 0, 0],
  });
  assert.equal(aggregateOpeningCounters(totals, {
    ringSimplifierMaxPrevProbeDistance: 1, ringSimplifierMaxNextProbeDistance: 2,
    ringSimplifierPrevProbes: 1, csgOperations: [1, 2, 0, 0],
  }), true);
  assert.equal(totals.ringSimplifierMaxPrevProbeDistance, limit);
  assert.equal(totals.ringSimplifierMaxNextProbeDistance, limit);
  assert.deepEqual(totals.csgOperations, [limit, 5, 0, 0]);
});

function fixture({ mutateIndividual = false, throwIndividual = false } = {}) {
  const live = new Set();
  const calls = [];
  const api = {
    processGeometryBatch(...args) {
      calls.push(args);
      const ids = Array.from(args[1]).filter((_, i) => i % 3 === 0);
      if (throwIndividual && ids.length === 1) throw new Error('private model data');
      const collection = {
        length: ids.length,
        get(index) {
          const mesh = {
            expressId: ids[index],
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            indices: new Uint32Array([0, 1, 2]),
            localToWorld: new Float64Array([mutateIndividual && ids.length === 1 ? 2 : 1]),
            free() { assert.ok(live.delete(mesh)); },
          };
          live.add(mesh);
          return mesh;
        },
        free() { assert.ok(live.delete(collection)); },
      };
      live.add(collection);
      return collection;
    },
  };
  return { api, live, calls };
}

test('#6516 preserves canonical batch ownership and identical full-context job arguments', () => {
  const { api, live, calls } = fixture();
  const original = api.processGeometryBatch;
  const rows = [];
  const batches = [];
  const restore = observeBatches(api, () => ({ unionRetries: 0 }), row => rows.push(row), batch => batches.push(batch));
  const bytes = new Uint8Array([1, 2]);
  const jobs = new Uint32Array([11, 2, 3, 21, 5, 6]);
  const voids = new Uint32Array([98]);
  const result = api.processGeometryBatch(bytes, jobs, 0.001, voids);
  assert.equal(result.length, 2);
  assert.equal(live.size, 1, 'only original collection remains owned by normal stream');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(1).map(args => Array.from(args[1])), [[11, 2, 3], [21, 5, 6]]);
  for (const args of calls) { assert.equal(args[0], bytes); assert.equal(args[2], 0.001); assert.equal(args[3], voids); }
  assert.deepEqual(rows.map(row => row.ordinal), [0, 1]);
  assert.ok(rows.every(row => !('expressId' in row)));
  assert.equal(batches[0].triangles, 2);
  result.free();
  restore();
  assert.equal(api.processGeometryBatch, original);
  assert.equal(live.size, 0);
});

test('#6516 rejects a placement-only difference and releases both collections', () => {
  const { api, live } = fixture({ mutateIndividual: true });
  const restore = observeBatches(api, () => ({}), () => {}, () => {});
  assert.throws(() => api.processGeometryBatch(new Uint8Array(), new Uint32Array([11, 2, 3, 21, 5, 6])), /differ/);
  assert.equal(live.size, 0);
  restore();
});

test('#6516 releases canonical collection when a diagnostic job throws', () => {
  const { api, live } = fixture({ throwIndividual: true });
  const restore = observeBatches(api, () => ({}), () => {}, () => {});
  assert.throws(() => api.processGeometryBatch(new Uint8Array(), new Uint32Array([11, 2, 3, 21, 5, 6])), /private model data/);
  assert.equal(live.size, 0);
  restore();
});
