/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spot-checks for the Roof / Plate / Member builders. Their geometry
 * is identical to existing types (slab for roof+plate, beam for
 * member) — these tests verify the IFC type + PredefinedType paths
 * + IFC2X3 fallback, not the sub-graph shape (covered upstream).
 */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { addRoofToStore } from './roof.js';
import { addPlateToStore } from './plate.js';
import { addMemberToStore } from './member.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

const ANCHOR = { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 };

describe('addRoofToStore', () => {
  it('emits IfcRoof with .FLAT_ROOF. PredefinedType for IFC4', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(50), view);
    const result = addRoofToStore(editor, ANCHOR, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.3 });
    const roof = view.getNewEntities().find((e) => e.expressId === result.roofId);
    expect(roof?.type).toBe('IfcRoof');
    expect(roof?.attributes[8]).toBe('.FLAT_ROOF.');
  });

  it('drops PredefinedType for IFC2X3', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(50), view);
    const result = addRoofToStore(
      editor,
      { ...ANCHOR, schema: 'IFC2X3' },
      { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.3 },
    );
    const roof = view.getNewEntities().find((e) => e.expressId === result.roofId);
    expect(roof?.attributes).toHaveLength(8);
  });

  it('supports polygon profile', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(50), view);
    const result = addRoofToStore(editor, ANCHOR, {
      Profile: 'polygon',
      OuterCurve: [[0, 0], [6, 0], [3, 4]],
      Thickness: 0.3,
    });
    const profile = view.getNewEntities().find((e) => e.expressId === result.profileId);
    expect(profile?.type).toBe('IfcArbitraryClosedProfileDef');
  });
});

describe('addPlateToStore', () => {
  it('defaults PredefinedType to .NOTDEFINED.', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(50), view);
    const result = addPlateToStore(editor, ANCHOR, { Position: [0, 0, 0], Width: 1, Depth: 1, Thickness: 0.02 });
    const plate = view.getNewEntities().find((e) => e.expressId === result.plateId);
    expect(plate?.type).toBe('IfcPlate');
    expect(plate?.attributes[8]).toBe('.NOTDEFINED.');
  });

  it('honours an overridden PredefinedType', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(50), view);
    const result = addPlateToStore(editor, ANCHOR, {
      Position: [0, 0, 0], Width: 1, Depth: 1, Thickness: 0.02, PredefinedType: 'CURTAIN_PANEL',
    });
    const plate = view.getNewEntities().find((e) => e.expressId === result.plateId);
    expect(plate?.attributes[8]).toBe('.CURTAIN_PANEL.');
  });
});

describe('addMemberToStore', () => {
  it('emits IfcMember with .NOTDEFINED. by default and a placement aligned to the axis', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(50), view);
    const result = addMemberToStore(editor, ANCHOR, {
      Start: [0, 0, 3], End: [4, 0, 3], Width: 0.1, Height: 0.1,
    });
    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
    const member = byId.get(result.memberId);
    expect(member?.type).toBe('IfcMember');
    expect(member?.attributes[8]).toBe('.NOTDEFINED.');

    // Placement axis ref is the beam direction (1,0,0).
    const placement = byId.get(result.placementId);
    const axisRef = placement?.attributes[1] as string;
    const axis = byId.get(Number(axisRef.replace('#', '')));
    const axisDirRef = axis?.attributes[1] as string;
    const dir = byId.get(Number(axisDirRef.replace('#', '')));
    expect(dir?.attributes[0]).toEqual([1, 0, 0]);
  });

  it('rejects coincident Start/End', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(50), view);
    expect(() => addMemberToStore(editor, ANCHOR, {
      Start: [0, 0, 0], End: [0, 0, 0], Width: 0.1, Height: 0.1,
    })).toThrow(/distinct/);
  });
});
