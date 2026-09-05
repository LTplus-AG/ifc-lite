/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

import { createDataAccessor } from './idsDataAccessor.js';

/** A wall (#1) with Pset_WallCommon.FireRating = "NONE". */
function makeStore(): IfcDataStore {
  const props = [
    {
      name: 'Pset_WallCommon',
      properties: [{ name: 'FireRating', value: 'NONE', type: 0, dataType: 'IFCLABEL' }],
    },
  ];

  return {
    schemaVersion: 'IFC4',
    source: new Uint8Array(),
    entities: {
      getTypeName: () => 'IfcWall',
      getObjectType: () => undefined,
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
    },
    entityIndex: { byId: new Map(), byType: new Map() },
    properties: { getForEntity: () => props },
    quantities: { getForEntity: () => [] },
  } as unknown as IfcDataStore;
}

describe('viewer createDataAccessor + MutablePropertyView overlay (#3929 re-validation)', () => {
  it('without a mutation view, reads the store value unchanged', () => {
    const accessor = createDataAccessor(makeStore(), 'model-1');
    assert.strictEqual(
      accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value,
      'NONE',
    );
  });

  it('a correction applied through MutablePropertyView.setProperty is visible on re-validation', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);

    const accessor = createDataAccessor(makeStore(), 'model-1', view);
    assert.strictEqual(
      accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value,
      'F90',
    );
  });

  it('a mutation on one entity does not leak into another entity\'s reads', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);

    const accessor = createDataAccessor(makeStore(), 'model-1', view);
    // Entity #2 has no override registered and no base data (getForEntity
    // returns the same fixture for any id here) — the overlay resolver
    // must not apply entity #1's mutation to it.
    const mutations = view.getMutationsForEntity(2);
    assert.strictEqual(mutations.length, 0);
  });

  it('an unrelated attribute/quantity mutation on the same entity does not affect a property read', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttribute(1, 'Name', 'Renamed Wall');

    const accessor = createDataAccessor(makeStore(), 'model-1', view);
    assert.strictEqual(
      accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value,
      'NONE',
    );
  });
});
