/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `EntityNode.type` when the product table has no row for the entity.
 *
 * `store.entities` indexes products. An IfcPropertySet, IfcElementQuantity,
 * IfcRelDefinesByProperties or IfcRelAssociatesMaterial is not in it, so
 * `getTypeName` answers 'Unknown' for all four — while `entityIndex.byId`
 * knows the class perfectly well, as the raw UPPERCASE STEP token.
 *
 * That mattered because `type` is what callers key passes on: iterating a
 * model's classes by it skipped 8,928 entities on a 176k-entity file, with
 * nothing to distinguish "not present" from "present but unnamed".
 */

import { describe, expect, it } from 'vitest';
import type { IfcStoreBase } from '@ifc-lite/data';
import { EntityNode } from '../src/entity-node.js';
import { QueryResultEntity } from '../src/query-result-entity.js';
import { createMockStore } from './mock-store.js';

const PSET_ID = 4201;
const WALL_ID = 101;

/**
 * A store that answers 'Unknown' from the product table for `PSET_ID` while
 * still carrying it in `entityIndex.byId` — the shape the columnar parser
 * really produces for a property set.
 */
function storeWithoutProductRow(): IfcStoreBase {
  const store = createMockStore({
    entities: [
      { expressId: WALL_ID, type: 'IfcWall', globalId: 'WALL00000000000000000X', name: 'Wall' },
      { expressId: PSET_ID, type: 'IfcPropertySet', globalId: 'PSET00000000000000000X', name: 'Pset_WallCommon' },
    ],
  });
  return {
    ...store,
    entities: {
      ...store.entities,
      getTypeName: (id: number) => (id === PSET_ID ? 'Unknown' : store.entities.getTypeName(id)),
    },
  } as IfcStoreBase;
}

describe('EntityNode.type', () => {
  it('recovers the class from the entity index when the product table has no row', () => {
    const store = storeWithoutProductRow();
    expect(new EntityNode(store, PSET_ID).type).toBe('IfcPropertySet');
  });

  it('returns the PascalCase name, not the raw uppercase STEP token', () => {
    // The index stores 'IFCPROPERTYSET'. Handing that back would be a second
    // wrong answer: every consumer matches PascalCase.
    const store = storeWithoutProductRow();
    expect(new EntityNode(store, PSET_ID).type).not.toBe('IFCPROPERTYSET');
  });

  it('still prefers the product table when it has an answer', () => {
    const store = storeWithoutProductRow();
    expect(new EntityNode(store, WALL_ID).type).toBe('IfcWall');
  });

  it('stays Unknown for an id the index does not carry either', () => {
    const store = storeWithoutProductRow();
    expect(new EntityNode(store, 999999).type).toBe('Unknown');
  });

  it('canonicalises a class the hand-maintained name map does not carry', () => {
    // IFC_ENTITY_NAMES is ~880 entries kept by hand, and its generator script
    // is gone (see its own header). Resolving through it would hand back the
    // raw uppercase token for anything it omits — a second wrong answer, and
    // the same curated-subset trap that isProductType was moved off.
    const store = createMockStore({
      entities: [{ expressId: 7, type: 'IfcMove', globalId: 'MOVE00000000000000000X', name: 'M' }],
    });
    const patched = {
      ...store,
      entities: { ...store.entities, getTypeName: () => 'Unknown' },
    } as IfcStoreBase;
    expect(new EntityNode(patched, 7).type).toBe('IfcMove');
  });

  it('answers the same through QueryResultEntity, which EntityQuery returns', () => {
    // The two getters were identical, so fixing only one left
    // bim.query().execute() disagreeing with graph traversal on the same id.
    const store = storeWithoutProductRow();
    expect(new QueryResultEntity(store, PSET_ID).type)
      .toBe(new EntityNode(store, PSET_ID).type);
  });
});
