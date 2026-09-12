/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore, IfcSourceBytes } from '@ifc-lite/parser';
import { useViewerStore } from '../store/index.js';
import { __setOverlayWorkerFactoryForTest } from '../lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic } from '../lib/overlay-parse/symbolic-flat.js';
import { registerRoomSymbolicSource } from '../lib/collab/room-symbolic-source.js';
import {
  __resetSymbolicAnnotationsCacheForTests,
  __symbolicAnnotationsRoomFlatCacheHasForTests,
  ensureParseFor,
  getParseFor,
} from './symbolic-parse-cache.js';

const SOURCE_OWNER = 79;

function source(): IfcSourceBytes {
  return {
    contentKey: 'same-portable-step',
    byteLength: 8,
    toTransferable: () => ({ bytes: new Uint8Array(8), transfer: [] }),
  } as unknown as IfcSourceBytes;
}

function store(sharedSource: IfcSourceBytes, portableStore: IfcDataStore, roomOwner: number): IfcDataStore {
  const result = {
    source: { contentKey: `ifcx-${roomOwner}`, byteLength: 1 },
    entityIndex: { byType: new Map(), byId: new Map() },
  } as unknown as IfcDataStore;
  registerRoomSymbolicSource(result, {
    dataStore: portableStore,
    source: sharedSource,
    seededIds: new Set([SOURCE_OWNER]),
    ownerIds: new Map([[SOURCE_OWNER, roomOwner]]),
    placements: new Map(),
    baselines: new Map(),
    structuredPsets: new Map(),
    structuredQuantities: new Map(),
    structuredAttributes: new Map(),
  });
  return result;
}

function oneFill() {
  const flat = createEmptyFlatSymbolic();
  flat.typeNames = ['IfcAnnotation'];
  flat.fillPoints = Float32Array.from([0, 0, 1, 0, 0, 1]);
  flat.fillPointStart = Uint32Array.from([0, 6]);
  flat.fillHoles = new Uint32Array(0);
  flat.fillHoleStart = Uint32Array.from([0, 0]);
  flat.fillOwner = Uint32Array.from([SOURCE_OWNER]);
  flat.fillGeometryItem = Uint32Array.from([0]);
  flat.fillWorldY = Float32Array.from([Number.NaN]);
  flat.fillColor = Float32Array.from([1, 0, 0, 1]);
  flat.fillHatch = Float32Array.from([0, 0, Number.NaN, 0]);
  flat.fillFlags = Uint8Array.from([0]);
  flat.fillType = Uint16Array.from([0]);
  return flat;
}

describe('room symbolic cache owner identity (#4608)', () => {
  beforeEach(() => {
    __resetSymbolicAnnotationsCacheForTests();
    useViewerStore.setState({ models: new Map(), geometryResult: null } as never);
  });

  it('does not reuse remapped owners across reconstructions of identical STEP bytes', async () => {
    let workerParses = 0;
    const previous = __setOverlayWorkerFactoryForTest(() => {
      const worker = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(request: { id: number }) {
          workerParses++;
          queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, ok: true, flat: oneFill() } }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    try {
      const sharedSource = source();
      const portableStore = {
        source: sharedSource,
        entityIndex: { byType: new Map(), byId: new Map() },
      } as unknown as IfcDataStore;
      const first = store(sharedSource, portableStore, 17);
      const sameMapping = store(sharedSource, portableStore, 17);
      const rebound = store(sharedSource, portableStore, 29);

      await Promise.all(ensureParseFor([first]));
      assert.equal(getParseFor(first)?.looseFills[0]?.ownerId, 17);

      await Promise.all(ensureParseFor([sameMapping]));
      assert.equal(getParseFor(sameMapping)?.looseFills[0]?.ownerId, 17);

      await Promise.all(ensureParseFor([rebound]));
      assert.equal(getParseFor(rebound)?.looseFills[0]?.ownerId, 29);
      assert.equal(getParseFor(first)?.looseFills[0]?.ownerId, 17,
        'the first reconstruction keeps its own cached room id');

      registerRoomSymbolicSource(first, {
        dataStore: portableStore,
        source: sharedSource,
        seededIds: new Set([SOURCE_OWNER]),
        ownerIds: new Map([[SOURCE_OWNER, 41]]),
        placements: new Map([[SOURCE_OWNER, { location: [1, -2, 3] }]]),
        baselines: new Map([[SOURCE_OWNER, { location: [0, 0, 0] }]]),
        structuredPsets: new Map(),
        structuredQuantities: new Map(),
        structuredAttributes: new Map(),
      });
      await Promise.all(ensureParseFor([first]));
      assert.equal(getParseFor(first)?.looseFills[0]?.ownerId, 41,
        'rebinding one store invalidates its owner-remapped parse');
      assert.deepEqual([...getParseFor(first)!.looseFills[0].points], [1, 2, 2, 2, 1, 3],
        'the rebound parse includes the current room placement');
      assert.equal(workerParses, 1, 'one portable STEP source is parsed once across reconstructions');
      assert.equal(__symbolicAnnotationsRoomFlatCacheHasForTests(portableStore), true);
    } finally {
      __setOverlayWorkerFactoryForTest(previous);
    }
  });
});
