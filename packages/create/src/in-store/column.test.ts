/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { addColumnToStore } from './column.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

describe('addColumnToStore', () => {
  it('emits the IfcColumn sub-graph with all required references', () => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const result = addColumnToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Position: [1, 1, 0], Width: 0.3, Depth: 0.4, Height: 3, Name: 'Column 1' },
    );

    expect(result.columnId).toBeGreaterThan(50);
    expect(result.relContainedId).toBeGreaterThan(result.columnId);

    const newEntities = view.getNewEntities();
    const byId = new Map(newEntities.map((e) => [e.expressId, e]));

    const column = byId.get(result.columnId);
    expect(column?.type).toBe('IFCCOLUMN');
    expect(column?.attributes[1]).toBe('#5');               // OwnerHistory
    expect(column?.attributes[2]).toBe('Column 1');          // Name
    expect(column?.attributes[5]).toBe(`#${result.placementId}`);
    expect(column?.attributes[6]).toBe(`#${result.productShapeId}`);
    expect(column?.attributes[8]).toBe('.COLUMN.');

    const placement = byId.get(result.placementId);
    expect(placement?.type).toBe('IFCLOCALPLACEMENT');
    expect(placement?.attributes[0]).toBe('#54');            // chained from storey placement

    const profile = byId.get(result.profileId);
    expect(profile?.type).toBe('IFCRECTANGLEPROFILEDEF');
    expect(profile?.attributes[3]).toBe(0.3);
    expect(profile?.attributes[4]).toBe(0.4);

    const solid = byId.get(result.solidId);
    expect(solid?.type).toBe('IFCEXTRUDEDAREASOLID');
    expect(solid?.attributes[3]).toBe(3);

    const shapeRep = byId.get(result.shapeRepId);
    expect(shapeRep?.type).toBe('IFCSHAPEREPRESENTATION');
    expect(shapeRep?.attributes[0]).toBe('#14');             // Body context
    expect(shapeRep?.attributes[2]).toBe('SweptSolid');

    const rel = byId.get(result.relContainedId);
    expect(rel?.type).toBe('IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(rel?.attributes[5]).toBe('#43');                  // RelatingStructure (storey)
    expect(rel?.attributes[4]).toEqual([`#${result.columnId}`]); // RelatedElements
  });

  it('allocates ids strictly above the existing store watermark', () => {
    const store = makeStore(100);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const result = addColumnToStore(
      editor,
      { ownerHistoryId: 1, bodyContextId: 2, storeyId: 3, storeyPlacementId: 4 },
      { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 },
    );

    for (const id of [
      result.columnId,
      result.placementId,
      result.profileId,
      result.solidId,
      result.shapeRepId,
      result.productShapeId,
      result.relContainedId,
    ]) {
      expect(id).toBeGreaterThan(100);
    }
  });
});
