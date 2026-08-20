/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for the retry-storm defect found in the error-path sweep
 * (see the sibling fix already applied in useGridLines3D.ts / useAlignmentLines3D.ts
 * — "Cache empty on failure so we don't retry a doomed parse every tick").
 *
 * `ensureParseFor` memoizes a successful parse in `PARSE_CACHE` keyed by the
 * source's content hash, and a `PARSE_INFLIGHT` map de-dupes concurrent calls
 * for the same key. But on a genuine parse FAILURE, the original code cleared
 * `PARSE_INFLIGHT` and returned without ever touching `PARSE_CACHE` — so the
 * next `ensureParseFor` call for the same (still-broken) source treats it as
 * never-attempted and reruns the full-source WASM walk from scratch. Every
 * `stores` dependency change (any federated model visibility toggle, any
 * `models`/`ifcDataStore` update) re-triggers the same doomed, expensive parse.
 *
 * Fault: `store.source.toTransferable()` throws — a real, synchronously
 * reachable failure `getWholeSourceForWorker` can hit (e.g. a source whose
 * transferable has already been consumed/detached), not a mocked module.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  ensureParseFor,
  __resetSymbolicAnnotationsCacheForTests,
  __symbolicAnnotationsCacheHasForTests,
} from './useSymbolicAnnotations.js';

function makeFailingStore(callCounter: { count: number }): IfcDataStore {
  return {
    source: {
      contentKey: 'retry-storm-fault-key',
      byteLength: 10,
      toTransferable() {
        callCounter.count += 1;
        throw new Error('injected fault: source already consumed');
      },
    },
    // entityIndex intentionally absent — hasEntityType() treats a
    // missing/empty index as "don't skip", so parseAnnotations reaches
    // getWholeSourceForWorker() and hits the injected fault.
  } as unknown as IfcDataStore;
}

describe('ensureParseFor retry storm on repeated parse failure', () => {
  beforeEach(() => {
    __resetSymbolicAnnotationsCacheForTests();
  });

  it('does not re-run a doomed parse on the second tick for the same source', async () => {
    const callCounter = { count: 0 };
    const store = makeFailingStore(callCounter);

    // First failure: this is the "handles the first failure correctly" leg —
    // the parse runs once, fails, and is reported.
    await Promise.all(ensureParseFor([store]));
    assert.equal(callCounter.count, 1, 'first tick should attempt the parse exactly once');

    // Second tick, same still-broken source (e.g. a re-render triggered by
    // an unrelated `models`/`ifcDataStore` update). A correctly-memoized
    // failure must NOT re-attempt the expensive WASM walk.
    await Promise.all(ensureParseFor([store]));
    assert.equal(
      callCounter.count,
      1,
      'second tick must not re-run the parse for a source that already failed once',
    );

    // The failure must be visible in the cache (as an empty result) so
    // downstream consumers don't stay in an indefinite "loading" limbo.
    assert.equal(
      __symbolicAnnotationsCacheHasForTests('retry-storm-fault-key'),
      true,
      'a failed parse must still populate PARSE_CACHE so retries are skipped',
    );
  });
});
