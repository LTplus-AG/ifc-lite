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
import { addWallToStore } from './wall.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

describe('addWallToStore', () => {
  it('emits the IfcWall sub-graph with a length-aware profile and Start placement', () => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const result = addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3, Name: 'North Wall' },
    );

    expect(result.wallId).toBeGreaterThan(50);

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));

    const wall = byId.get(result.wallId);
    expect(wall?.type).toBe('IfcWall');
    expect(wall?.attributes[2]).toBe('North Wall');
    expect(wall?.attributes[5]).toBe(`#${result.placementId}`);
    expect(wall?.attributes[8]).toBe('.STANDARD.');

    const profile = byId.get(result.profileId);
    expect(profile?.type).toBe('IfcRectangleProfileDef');
    // Profile centred at (length/2, 0) so the wall spans 0..length on local X.
    const profilePosId = profile?.attributes[2];
    expect(typeof profilePosId).toBe('string');
    const profilePos = byId.get(Number((profilePosId as string).replace('#', '')));
    expect(profilePos?.type).toBe('IfcAxis2Placement2D');
    const profileOriginRef = profilePos?.attributes[0];
    const profileOriginPt = byId.get(Number((profileOriginRef as string).replace('#', '')));
    expect(profileOriginPt?.attributes[0]).toEqual([2.5, 0]);
    expect(profile?.attributes[3]).toBe(5);   // XDim = wall length
    expect(profile?.attributes[4]).toBe(0.2); // YDim = thickness

    const solid = byId.get(result.solidId);
    expect(solid?.attributes[3]).toBe(3); // extrusion height

    const rel = byId.get(result.relContainedId);
    expect(rel?.type).toBe('IfcRelContainedInSpatialStructure');
    expect(rel?.attributes[5]).toBe('#43');
  });

  it('rejects coincident Start and End', () => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);
    expect(() => addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Start: [1, 1, 0], End: [1, 1, 0], Thickness: 0.2, Height: 3 },
    )).toThrow(/distinct/);
  });

  it('drops PredefinedType for IFC2X3', () => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const result = addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54, schema: 'IFC2X3' },
      { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 },
    );

    const wall = view.getNewEntities().find((e) => e.expressId === result.wallId);
    // 8 attrs: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag
    expect(wall?.attributes).toHaveLength(8);
  });
});
