/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PresenceBroadcaster`'s selection effect used to call
 * `pathForEntity(ifcDataStore, id)` directly, where `id` came straight off
 * `selectedEntityIds` and `ifcDataStore` was the store's ACTIVE-model field.
 *
 * `selectedEntityIds` holds federation GLOBAL ids (offset per model —
 * `useModelSelection.ts`'s own doc: "selectedEntityId is a globalId ... The
 * EntityRef.expressId is the ORIGINAL expressId"). `pathForEntity` expects the
 * per-model LOCAL expressId. Skipping `resolveEntityRef` (the module's own
 * doc: "every code path that needs an EntityRef from a globalId MUST use this
 * function") meant a global id belonging to a SECOND federated model got
 * looked up, unmodified, against the FIRST model's entity table — the two
 * numbers only coincide when idOffset is 0, which is why a single-model room
 * never showed the bug.
 *
 * This test seeds two federated models with distinct `idOffset`s (matching
 * what `useIfcLoader` leaves after a real federated load) and drives the
 * fixed `pathsForSelection` directly.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { pathsForSelection } from './PresenceBroadcaster.js';

/** A minimal fake store: enough for `pathForEntity`'s cache-miss fallback
 *  (`entityIndex.byId.entries()` for the primary pass, `entities.getGlobalId`
 *  for the guid lookup) without a real parse. */
function fakeStore(localIdToGuid: Record<number, string>): IfcDataStore {
  return {
    entityIndex: { byId: new Map() },
    entities: { getGlobalId: (id: number) => localIdToGuid[id] ?? null },
  } as unknown as IfcDataStore;
}

function fakeModel(id: string, idOffset: number, maxExpressId: number, store: IfcDataStore): FederatedModel {
  return {
    id,
    name: id,
    ifcDataStore: store,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: Date.now(),
    fileSize: 1024,
    idOffset,
    maxExpressId,
  };
}

describe('PresenceBroadcaster selection — federated global ids (#3457-style)', () => {
  beforeEach(() => {
    useViewerStore.getState().resetViewerState();
    useViewerStore.getState().clearAllModels();
  });

  afterEach(() => {
    useViewerStore.getState().resetViewerState();
    useViewerStore.getState().clearAllModels();
  });

  it('resolves a selected entity on the SECOND federated model to ITS guid, not a lookup on the first model', () => {
    const storeA = fakeStore({ 5: 'GUID-A-5' });
    const storeB = fakeStore({ 5: 'GUID-B-5' }); // same LOCAL id, different model — the trap
    useViewerStore.getState().addModel(fakeModel('model-a', 0, 100, storeA));
    useViewerStore.getState().addModel(fakeModel('model-b', 1000, 100, storeB));

    // globalId 1005 = model-b's local expressId 5 (offset 1000).
    const paths = pathsForSelection(useViewerStore.getState(), [1005]);

    assert.deepStrictEqual(
      paths,
      ['/GUID-B-5'],
      'must resolve through the model B holds this id, not model A (whose local id 5 lands on the SAME raw number)',
    );
  });

  it('resolves multiple selections across models to their OWN guids', () => {
    const storeA = fakeStore({ 3: 'GUID-A-3' });
    const storeB = fakeStore({ 3: 'GUID-B-3' });
    useViewerStore.getState().addModel(fakeModel('model-a', 0, 100, storeA));
    useViewerStore.getState().addModel(fakeModel('model-b', 1000, 100, storeB));

    const paths = pathsForSelection(useViewerStore.getState(), [3, 1003]);

    assert.deepStrictEqual(paths.sort(), ['/GUID-A-3', '/GUID-B-3'].sort());
  });

  it('still resolves in single-model (legacy, no federation map) mode', () => {
    const store = fakeStore({ 7: 'GUID-LEGACY-7' });
    useViewerStore.setState({ ifcDataStore: store });

    const paths = pathsForSelection(useViewerStore.getState(), [7]);

    assert.deepStrictEqual(paths, ['/GUID-LEGACY-7']);
  });
});
