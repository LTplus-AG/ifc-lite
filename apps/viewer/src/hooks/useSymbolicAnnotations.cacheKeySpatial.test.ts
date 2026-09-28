/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '../store/index.js';
import { __setOverlayWorkerFactoryForTest } from '../lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic } from '../lib/overlay-parse/symbolic-flat.js';
import {
  __resetSymbolicAnnotationsCacheForTests,
  ensureParseFor,
  getParseFor,
} from './symbolic-parse-cache.js';

function oneAnnotation() {
  const flat = createEmptyFlatSymbolic();
  flat.typeNames = ['IfcAnnotation'];
  flat.polyPoints = Float32Array.from([0, 0, 1, 0]);
  flat.polyStart = Uint32Array.from([0, 2]);
  flat.polyOwner = Uint32Array.from([2]);
  flat.polyWorldY = Float32Array.from([NaN]);
  flat.polyFlags = Uint8Array.from([0]);
  flat.polyType = Uint16Array.from([0]);
  return flat;
}

function store(storeyId: number, elevation: number): IfcDataStore {
  return {
    source: { contentKey: 'same-source-bytes', byteLength: 10, toTransferable: () => ({}) },
    spatialHierarchy: {
      elementToStorey: new Map([[2, storeyId]]),
      storeyElevations: new Map([[storeyId, elevation]]),
    },
  } as unknown as IfcDataStore;
}

describe('symbolic cache follows live spatial bucket mappings (#5236/#5249)', () => {
  beforeEach(() => {
    __resetSymbolicAnnotationsCacheForTests();
    useViewerStore.setState({ models: new Map(), geometryResult: null } as never);
  });

  it('reuses source bytes but rebuilds the result when the storey mapping changes', async () => {
    let workerParses = 0;
    const previous = __setOverlayWorkerFactoryForTest(() => {
      const worker = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(request: { id: number }) {
          workerParses++;
          queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, ok: true, flat: oneAnnotation() } }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    try {
      const first = store(90, 10);
      const refreshed = store(91, 30);

      await Promise.all(ensureParseFor([first]));
      const firstResult = getParseFor(first);
      assert.equal([...firstResult!.byStorey.values()][0].storeyElevation, 10);

      await Promise.all(ensureParseFor([refreshed]));
      const refreshedResult = getParseFor(refreshed);
      assert.equal([...refreshedResult!.byStorey.values()][0].storeyElevation, 30,
        'same bytes with a refreshed hierarchy must not return stale spatial buckets');
      assert.equal(workerParses, 1, 'identical source bytes reuse the worker output');
      assert.equal([...getParseFor(first)!.byStorey.values()][0].storeyElevation, 10,
        'the earlier store keeps its own spatial result');

      first.spatialHierarchy!.storeyElevations.set(90, 25);
      await Promise.all(ensureParseFor([first]));
      assert.equal([...getParseFor(first)!.byStorey.values()][0].storeyElevation, 25,
        'mutating the live hierarchy must invalidate its bucketed result');
      assert.equal(workerParses, 1, 'rebucketing after a hierarchy edit reuses worker output');
    } finally {
      __setOverlayWorkerFactoryForTest(previous);
    }
  });
});
