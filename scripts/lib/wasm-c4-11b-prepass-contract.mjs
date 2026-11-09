/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { makeAffinityChunkFixture } from './wasm-affinity-chunk-contract.mjs';

/** #7782: check serial and prebuilt post-scan order and index completeness on
 * the actual API. More than 50 jobs exercises the mid-scan metadata lease. */
export function checkC4PrepassContract(IfcAPI) {
  const { bytes, expected } = makeAffinityChunkFixture();
  for (const sharded of [false, true]) {
    const api = new IfcAPI();
    try {
      const index = api.scanEntityIndexShard(bytes, 0, bytes.length);
      const events = [];
      const args = [bytes, e => events.push(e), 1024, undefined, true];
      if (sharded) args.push(index.ids, index.starts, index.lengths, index.classes);
      api[sharded ? 'buildPrePassStreamingSharded' : 'buildPrePassStreaming'](...args);
      const kinds = events.map(e => e.type);
      assert.deepEqual(kinds, [ 'meta', ...sharded ? [] : ['entity-index', 'styles'],
        'prepass-columns', 'jobs', 'jobs', 'jobs', 'jobs', 'jobs', 'complete' ]);
      assert.equal(events.at(-1).totalJobs, expected.length);
      if (!sharded) {
        const emitted = events[1];
        const rows = Array.from(index.ids, (id, i) => [id, index.starts[i], index.lengths[i]])
          .sort((a, b) => a[0] - b[0]);
        assert.deepEqual(Array.from(emitted.ids), rows.map(r => r[0]));
        assert.deepEqual(Array.from(emitted.starts), rows.map(r => r[1]));
        assert.deepEqual(Array.from(emitted.lengths), rows.map(r => r[2]));
      }
      assert.deepEqual(events.filter(e => e.type === 'jobs').flatMap(e => Array.from(e.jobs)), expected.flat());
    } finally { api.clearPrePassCache(); api.free(); }
  }
}
