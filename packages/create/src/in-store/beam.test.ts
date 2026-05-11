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
import { addBeamToStore } from './beam.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

describe('addBeamToStore', () => {
  it('emits IfcBeam with local Z aligned to the beam axis', () => {
    const store = makeStore(60);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const result = addBeamToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.3, Height: 0.5 },
    );

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
    const beam = byId.get(result.beamId);
    expect(beam?.type).toBe('IfcBeam');
    expect(beam?.attributes[8]).toBe('.BEAM.');

    // The beam's IfcAxis2Placement3D has Axis = beam direction.
    const placement = byId.get(result.placementId);
    const axisRef = placement?.attributes[1] as string;
    const axisPlacement = byId.get(Number(axisRef.replace('#', '')));
    const axisDirRef = axisPlacement?.attributes[1] as string;
    const axisDir = byId.get(Number(axisDirRef.replace('#', '')));
    expect(axisDir?.attributes[0]).toEqual([1, 0, 0]); // direction Start→End

    // Solid extrusion = beam length along local Z.
    const solid = byId.get(result.solidId);
    expect(solid?.attributes[3]).toBe(4);
  });

  it('rejects coincident Start/End and non-positive section', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(10), view);
    expect(() => addBeamToStore(
      editor,
      { ownerHistoryId: 1, bodyContextId: 2, storeyId: 3, storeyPlacementId: 4 },
      { Start: [0, 0, 0], End: [0, 0, 0], Width: 0.3, Height: 0.5 },
    )).toThrow(/distinct/);
    expect(() => addBeamToStore(
      editor,
      { ownerHistoryId: 1, bodyContextId: 2, storeyId: 3, storeyPlacementId: 4 },
      { Start: [0, 0, 0], End: [1, 0, 0], Width: 0, Height: 0.5 },
    )).toThrow(/positive/);
  });
});
