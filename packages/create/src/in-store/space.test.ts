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
import { addSpaceToStore } from './space.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

describe('addSpaceToStore', () => {
  it('emits IfcSpace + IfcRelAggregates (not ContainedInSpatialStructure)', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addSpaceToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Position: [0, 0, 0], Width: 4, Depth: 3, Height: 3, LongName: 'Living Room' },
    );

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
    const space = byId.get(result.spaceId);
    expect(space?.type).toBe('IfcSpace');
    expect(space?.attributes[7]).toBe('Living Room');  // LongName
    expect(space?.attributes[8]).toBe('.ELEMENT.');     // CompositionType
    expect(space?.attributes[9]).toBe('.INTERNAL.');    // InteriorOrExteriorSpace

    const rel = byId.get(result.relAggregatesId);
    expect(rel?.type).toBe('IfcRelAggregates');
    expect(rel?.attributes[4]).toBe('#43');             // RelatingObject = storey
    expect(rel?.attributes[5]).toEqual([`#${result.spaceId}`]);
  });

  it('emits a polygon profile when Profile = "polygon"', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addSpaceToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      {
        Profile: 'polygon',
        OuterCurve: [[0, 0], [4, 0], [4, 3], [0, 3]],
        Height: 3,
      },
    );
    const profile = view.getNewEntities().find((e) => e.expressId === result.profileId);
    expect(profile?.type).toBe('IfcArbitraryClosedProfileDef');
  });

  // Read the Qto_SpaceBaseQuantities the bake attaches via the property view —
  // the same source the properties panel + exporter read.
  const namedQ = (view: MutablePropertyView, id: number): Record<string, number> => {
    const qto = view.getQuantitiesForEntity(id).find((s) => s.name === 'Qto_SpaceBaseQuantities');
    return Object.fromEntries((qto?.quantities ?? []).map((q) => [q.name, q.value]));
  };

  it('attaches Qto_SpaceBaseQuantities (area / perimeter / height / volume) to the view', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addSpaceToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Position: [0, 0, 0], Width: 4, Depth: 3, Height: 3 },
    );
    const named = namedQ(view, result.spaceId);
    expect(named['GrossFloorArea']).toBeCloseTo(12, 6); // 4×3
    expect(named['NetFloorArea']).toBeCloseTo(12, 6);
    expect(named['GrossPerimeter']).toBeCloseTo(14, 6); // 2(4+3)
    expect(named['Height']).toBeCloseTo(3, 6);
    expect(named['GrossVolume']).toBeCloseTo(36, 6); // 12×3
  });

  it('uses the netFloorArea override for NetFloorArea (gross unchanged)', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addSpaceToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Position: [0, 0, 0], Width: 4, Depth: 3, Height: 3, netFloorArea: 10 },
    );
    const named = namedQ(view, result.spaceId);
    expect(named['GrossFloorArea']).toBeCloseTo(12, 6);
    expect(named['NetFloorArea']).toBeCloseTo(10, 6);
  });

  it('emits one classified IfcRelSpaceBoundary per bounding element', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addSpaceToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      {
        Profile: 'polygon',
        OuterCurve: [[0, 0], [4, 0], [4, 3], [0, 3]],
        Height: 3,
        boundaries: [
          { elementId: 30, internalOrExternal: 'EXTERNAL' },
          { elementId: 31, internalOrExternal: 'INTERNAL' },
        ],
      },
    );
    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
    expect(result.spaceBoundaryIds).toHaveLength(2);
    const b0 = byId.get(result.spaceBoundaryIds[0]);
    expect(b0?.type).toBe('IfcRelSpaceBoundary');
    expect(b0?.attributes[4]).toBe(`#${result.spaceId}`); // RelatingSpace
    expect(b0?.attributes[5]).toBe('#30');                // RelatedBuildingElement
    expect(b0?.attributes[7]).toBe('.PHYSICAL.');
    expect(b0?.attributes[8]).toBe('.EXTERNAL.');
    expect(byId.get(result.spaceBoundaryIds[1])?.attributes[8]).toBe('.INTERNAL.');
  });

  it('rejects non-positive Height', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(10), view);
    expect(() => addSpaceToStore(
      editor,
      { ownerHistoryId: 1, bodyContextId: 2, storeyId: 3, storeyPlacementId: 4 },
      { Position: [0, 0, 0], Width: 4, Depth: 4, Height: 0 },
    )).toThrow(/positive/);
  });
});
