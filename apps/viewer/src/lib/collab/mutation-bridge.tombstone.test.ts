/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { applyRemoteAttribute } from './mutation-bridge.js';

/**
 * Isolated from `mutation-bridge.test.ts`: that file also imports
 * `@ifc-lite/export`'s `StepExporter` (to assert on exported STEP text),
 * which transitively pulls in `@ifc-lite/geometry`'s wasm bridge. This file
 * only needs `applyRemoteAttribute` and a bare `MutablePropertyView`, so it
 * stays free of that dependency and can run wherever the wasm build is
 * unavailable.
 */

/** A minimal fake IfcDataStore with one entity, enough for attribute-name resolution. */
function buildDataStore(id: number, type: string): IfcDataStore {
  return {
    schemaVersion: 'IFC4',
    entities: { getTypeName: (checkId: number) => (checkId === id ? type : 'Unknown') },
  } as unknown as IfcDataStore;
}

describe('applyRemoteAttribute refuses a write to a locally tombstoned entity', () => {
  it('rejects instead of recording the write when the entity is locally deleted', () => {
    const dataStore = buildDataStore(1, 'IfcWall');
    const view = new MutablePropertyView(null, 'room-model');
    view.deleteEntity(1);

    const reason = applyRemoteAttribute(view, dataStore, 1, 'Description', 'peer value');

    assert.strictEqual(reason, 'entity 1 is locally deleted');
    // No positional override was recorded, so a later undo of the delete
    // (`restoreFromTombstone`) cannot resurrect this value.
    assert.strictEqual(view.getPositionalMutationsForEntity(1), null);
  });

  it('a write to the same tombstoned entity is still refused after restoreFromTombstone runs on a DIFFERENT id (guards only this id)', () => {
    const dataStore = buildDataStore(1, 'IfcWall');
    const view = new MutablePropertyView(null, 'room-model');
    view.deleteEntity(1);
    view.deleteEntity(2);
    view.restoreFromTombstone(2);

    const reason = applyRemoteAttribute(view, dataStore, 1, 'Description', 'peer value');

    assert.strictEqual(reason, 'entity 1 is locally deleted');
  });

  it('still applies a remote attribute write to a live (non-tombstoned) entity', () => {
    const dataStore = buildDataStore(1, 'IfcWall');
    const view = new MutablePropertyView(null, 'room-model');

    const reason = applyRemoteAttribute(view, dataStore, 1, 'Description', 'peer value');

    assert.strictEqual(reason, null);
    assert.strictEqual(view.getPositionalMutationsForEntity(1)?.get(3), 'peer value');
  });

  it('a tombstone→restore cycle no longer resurrects a peer write made while deleted', () => {
    const dataStore = buildDataStore(1, 'IfcWall');
    const view = new MutablePropertyView(null, 'room-model');
    view.deleteEntity(1);

    applyRemoteAttribute(view, dataStore, 1, 'Description', 'peer value');
    view.restoreFromTombstone(1);

    assert.strictEqual(view.isDeleted(1), false);
    assert.strictEqual(view.getPositionalMutationsForEntity(1), null);
  });
});
