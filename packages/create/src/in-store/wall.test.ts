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
import { addWallToStore, type WallInStoreParams } from './wall.js';

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
      { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 },
      { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3, Name: 'North Wall' },
    );

    expect(result.wallId).toBeGreaterThan(50);

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));

    const wall = byId.get(result.wallId);
    expect(wall?.type).toBe('IfcWall');
    expect(wall?.attributes[2]).toBe('North Wall');
    expect(wall?.attributes[5]).toBe(`#${result.placementId}`);
    expect(wall?.attributes[8]).toBe('.NOTDEFINED.');

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
      { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 },
      { Start: [1, 1, 0], End: [1, 1, 0], Thickness: 0.2, Height: 3 },
    )).toThrow(/distinct/);
  });

  it('rejects zero Thickness', () => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);
    expect(() => addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 },
      { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0, Height: 3 },
    )).toThrow(/positive/);
  });

  it('rejects zero Height', () => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);
    expect(() => addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 },
      { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 0 },
    )).toThrow(/positive/);
  });

  it.each([
    ['NaN Start[0]', [Number.NaN, 0, 0] as const, [5, 0, 0] as const],
    ['Infinity Start[1]', [0, Number.POSITIVE_INFINITY, 0] as const, [5, 0, 0] as const],
    ['NaN End[2]', [0, 0, 0] as const, [5, 0, Number.NaN] as const],
    ['-Infinity End[0]', [0, 0, 0] as const, [Number.NEGATIVE_INFINITY, 0, 0] as const],
  ])('rejects non-finite coordinates (%s)', (_label, Start, End) => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);
    expect(() => addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 },
      { Start: [...Start], End: [...End], Thickness: 0.2, Height: 3 },
    )).toThrow(/finite/);
  });

  it('rejects a sloped (non-coplanar) Start/End', () => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);
    expect(() => addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 },
      { Start: [0, 0, 0], End: [5, 0, 2], Thickness: 0.2, Height: 3 },
    )).toThrow(/same storey plane/);
  });

  it('writes the placement Axis alongside its RefDirection (#5469)', () => {
    // IfcAxis2Placement3D.AxisAndRefDirProvision: both or neither. The wall
    // rotates its local X onto the wall direction, so the Axis must be there.
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);
    const result = addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 },
      { Start: [0, 0, 0], End: [0, 5, 0], Thickness: 0.2, Height: 3 },
    );
    const byRef = new Map(view.getNewEntities().map((e) => [`#${e.expressId}`, e]));
    const placement = byRef.get(`#${result.placementId}`);
    expect(placement?.attributes[0]).toBe('#54');
    const axisPlacement = byRef.get(placement?.attributes[1] as string);
    expect(axisPlacement?.type).toBe('IfcAxis2Placement3D');
    expect(byRef.get(axisPlacement?.attributes[1] as string)?.attributes[0]).toEqual([0, 0, 1]);
    expect(byRef.get(axisPlacement?.attributes[2] as string)?.attributes[0]).toEqual([0, 1, 0]);
  });

  it('drops PredefinedType for IFC2X3', () => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const result = addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54, schema: 'IFC2X3' },
      { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 },
    );

    const wall = view.getNewEntities().find((e) => e.expressId === result.wallId);
    // 8 attrs: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag
    expect(wall?.attributes).toHaveLength(8);
  });
});

const WALL_A: WallInStoreParams = { Start: [-5, 0, 0], End: [0, 0, 0], Thickness: 0.2, Height: 3, Name: 'A' };

function axisSetup(lengthUnitScale?: number) {
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(makeStore(50), view);
  const anchor = { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 20, lengthUnitScale };
  const entity = (id: number | string) => view.getNewEntity(typeof id === 'string' ? Number(id.slice(1)) : id);
  return { editor, anchor, entity };
}

describe('addWallToStore: Axis representation and body cuts', () => {
  it('writes an Axis by default, and none with Axis: false', () => {
    const { editor, anchor, entity } = axisSetup();
    expect(addWallToStore(editor, anchor, WALL_A).axisRepId).not.toBeNull();
    const result = addWallToStore(editor, anchor, { ...WALL_A, Axis: false });
    expect(result.axisRepId).toBeNull();
    expect(entity(result.productShapeId)?.attributes[2]).toEqual([`#${result.shapeRepId}`]);
  });

  it('writes an Axis Curve2D polyline beside the Body', () => {
    const { editor, anchor, entity } = axisSetup();
    const result = addWallToStore(editor, anchor, WALL_A);
    expect(entity(result.productShapeId)?.attributes[2]).toEqual([`#${result.shapeRepId}`, `#${result.axisRepId}`]);
    const axis = entity(result.axisRepId!);
    expect(axis?.type).toBe('IfcShapeRepresentation');
    expect(axis?.attributes.slice(0, 3)).toEqual(['#15', 'Axis', 'Curve2D']);
    const polyline = entity((axis?.attributes[3] as string[])[0]);
    expect(polyline?.type).toBe('IfcPolyline');
    expect((polyline?.attributes[0] as string[]).map((ref) => entity(ref)?.attributes[0])).toEqual([[0, 0], [5, 0]]);
  });

  it('shifts the body across the axis for an alignment and offset', () => {
    const { editor, anchor, entity } = axisSetup();
    const result = addWallToStore(editor, anchor, { ...WALL_A, Alignment: 'left', Offset: 0.05 });
    const profile = entity(result.profileId);
    expect(profile?.type).toBe('IfcRectangleProfileDef');
    const origin = entity(entity(profile?.attributes[2] as string)?.attributes[0] as string);
    expect(origin?.attributes[0]).toEqual([2.5, -0.05]);
    expect(profile?.attributes[4]).toBe(0.2);
  });

  it('writes a slanted end as an arbitrary closed profile, in native units', () => {
    const { editor, anchor, entity } = axisSetup(0.001);
    const result = addWallToStore(editor, anchor, { ...WALL_A, EndCut: { left: 0.1, right: -0.1 } });
    const profile = entity(result.profileId);
    expect(profile?.type).toBe('IfcArbitraryClosedProfileDef');
    const polyline = entity(profile?.attributes[2] as string);
    const points = (polyline?.attributes[0] as string[]).map((ref) => entity(ref)?.attributes[0]);
    expect(points).toEqual([[0, -100], [4900, -100], [5100, 100], [0, 100], [0, -100]]);
  });

  it('refuses cuts that leave no body', () => {
    const { editor, anchor } = axisSetup();
    expect(() => addWallToStore(editor, anchor, { ...WALL_A, StartCut: { left: -3, right: -3 }, EndCut: { left: -3, right: -3 } }))
      .toThrow(/ends cross/);
    expect(() => addWallToStore(editor, anchor, { ...WALL_A, Offset: Number.NaN })).toThrow(/finite/);
  });
});
