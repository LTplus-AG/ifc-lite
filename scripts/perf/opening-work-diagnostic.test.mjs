// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeBatches } from './opening-work-diagnostic.mjs';

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
