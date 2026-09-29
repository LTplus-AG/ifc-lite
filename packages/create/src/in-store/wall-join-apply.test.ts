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
import type { SpatialAnchor, SpatialAnchorSchema } from './anchor.js';
import { addRelConnectsPathElementsToStore } from './rel-connects-path.js';
import { addWallToStore, type WallInStoreParams } from './wall.js';
import { applyWallJoinToStore, wallJoinTargetFromBuild } from './wall-join-apply.js';

function setup(schema?: SpatialAnchorSchema, lengthUnitScale?: number) {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= 50; id++) byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  const store: MutationStoreShape = { entityIndex: { byId } };
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(store, view);
  const anchor: SpatialAnchor = {
    ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 20, schema, lengthUnitScale,
  };
  const entity = (id: number | string) => view.getNewEntity(typeof id === 'string' ? Number(id.slice(1)) : id);
  /** Attribute `index` of overlay entity `id`, with a positional edit winning over the authored value. */
  const attr = (id: number, index: number) => {
    const edits = view.getPositionalMutationsForEntity(id);
    return edits?.has(index) ? edits.get(index) : view.getNewEntity(id)?.attributes[index];
  };
  const build = (params: WallInStoreParams) => wallJoinTargetFromBuild(addWallToStore(editor, anchor, params), params);
  return { view, editor, anchor, entity, attr, build };
}

const WALL_A: WallInStoreParams = { Start: [-5, 0, 0], End: [0, 0, 0], Thickness: 0.2, Height: 3, Name: 'A' };
const WALL_B: WallInStoreParams = { Start: [0, 0, 0], End: [0, 4, 0], Thickness: 0.2, Height: 3, Name: 'B' };

describe('addWallToStore: Axis representation and body cuts', () => {
  it('writes no Axis unless asked', () => {
    const { editor, anchor, entity } = setup();
    const result = addWallToStore(editor, anchor, WALL_A);
    expect(result.axisRepId).toBeNull();
    expect(entity(result.productShapeId)?.attributes[2]).toEqual([`#${result.shapeRepId}`]);
  });

  it('writes an Axis Curve2D polyline beside the Body', () => {
    const { editor, anchor, entity } = setup();
    const result = addWallToStore(editor, anchor, { ...WALL_A, Axis: true });
    expect(entity(result.productShapeId)?.attributes[2]).toEqual([`#${result.shapeRepId}`, `#${result.axisRepId}`]);
    const axis = entity(result.axisRepId!);
    expect(axis?.type).toBe('IfcShapeRepresentation');
    expect(axis?.attributes.slice(0, 3)).toEqual(['#15', 'Axis', 'Curve2D']);
    const polyline = entity((axis?.attributes[3] as string[])[0]);
    expect(polyline?.type).toBe('IfcPolyline');
    expect((polyline?.attributes[0] as string[]).map((ref) => entity(ref)?.attributes[0])).toEqual([[0, 0], [5, 0]]);
  });

  it('shifts the body across the axis for an alignment and offset', () => {
    const { editor, anchor, entity } = setup();
    const result = addWallToStore(editor, anchor, { ...WALL_A, Alignment: 'left', Offset: 0.05 });
    const profile = entity(result.profileId);
    expect(profile?.type).toBe('IfcRectangleProfileDef');
    const origin = entity(entity(profile?.attributes[2] as string)?.attributes[0] as string);
    expect(origin?.attributes[0]).toEqual([2.5, -0.05]);
    expect(profile?.attributes[4]).toBe(0.2);
  });

  it('writes a slanted end as an arbitrary closed profile, in native units', () => {
    const { editor, anchor, entity } = setup(undefined, 0.001);
    const result = addWallToStore(editor, anchor, { ...WALL_A, EndCut: { left: 0.1, right: -0.1 } });
    const profile = entity(result.profileId);
    expect(profile?.type).toBe('IfcArbitraryClosedProfileDef');
    const polyline = entity(profile?.attributes[2] as string);
    const points = (polyline?.attributes[0] as string[]).map((ref) => entity(ref)?.attributes[0]);
    expect(points).toEqual([[0, -100], [4900, -100], [5100, 100], [0, 100], [0, -100]]);
  });

  it('refuses cuts that leave no body', () => {
    const { editor, anchor } = setup();
    expect(() => addWallToStore(editor, anchor, { ...WALL_A, StartCut: { left: -3, right: -3 }, EndCut: { left: -3, right: -3 } }))
      .toThrow(/ends cross/);
    expect(() => addWallToStore(editor, anchor, { ...WALL_A, Offset: Number.NaN })).toThrow(/finite/);
  });
});

describe('applyWallJoinToStore', () => {
  it('trims and extends two in-store walls at a right-angle corner and writes the relationship', () => {
    const { view, editor, anchor, entity, attr, build } = setup();
    const a = build({ ...WALL_A, Axis: true });
    const b = build(WALL_B);
    const oldProfile = a.profileId;
    const oldAxis = a.axisRepId!;
    const result = applyWallJoinToStore(editor, anchor, a, b);

    expect(result.join.kind).toBe('L');
    // A runs through: 5.1 long, centred 0.05 past its middle.
    const profileA = entity(result.a.profileId);
    expect(profileA?.type).toBe('IfcRectangleProfileDef');
    expect(profileA?.attributes[3]).toBeCloseTo(5.1, 12);
    expect(entity(entity(profileA?.attributes[2] as string)?.attributes[0] as string)?.attributes[0]).toEqual([2.55, 0]);
    expect(attr(a.solidId, 0)).toBe(`#${result.a.profileId}`);
    // B stops at A's face: 3.9 long, from 0.1 to 4.
    const profileB = entity(result.b.profileId);
    expect(profileB?.attributes[3]).toBeCloseTo(3.9, 12);
    expect((entity(entity(profileB?.attributes[2] as string)?.attributes[0] as string)?.attributes[0] as number[])[0]).toBeCloseTo(2.05, 12);

    // The old overlay profile and axis are gone, the new axis replaced it in place.
    expect(view.getNewEntity(oldProfile)).toBeNull();
    expect(view.getNewEntity(oldAxis)).toBeNull();
    expect(attr(a.productShapeId, 2)).toEqual([`#${a.representationIds[0]}`, `#${result.a.axisRepId}`]);
    // B had no Axis: one is appended after its Body.
    expect(attr(b.productShapeId, 2)).toEqual([`#${b.representationIds[0]}`, `#${result.b.axisRepId}`]);

    // Placements are untouched.
    const rel = entity(result.relId);
    expect(rel?.type).toBe('IfcRelConnectsPathElements');
    expect(rel?.attributes).toEqual([
      expect.stringMatching(/^.{22}$/), '#5', null, null, null,
      `#${a.wallId}`, `#${b.wallId}`, [], [], '.ATSTART.', '.ATEND.',
    ]);
  });

  it('keeps the placement and writes the moved Start into the wall frame', () => {
    const { editor, anchor, entity, build } = setup();
    // B drawn from 0.3 short of the corner: its Start moves back to the corner.
    const b = build({ ...WALL_B, Start: [0, 0.3, 0] });
    const a = build(WALL_A);
    const result = applyWallJoinToStore(editor, anchor, b, a, { priority: 'b' });
    expect(result.join.b.runsThrough).toBe(true);
    expect(result.b.origin).toEqual([-5, 0]);
    // B's axis now runs from -0.3 (the corner) to 3.7 in its frame, which starts at y = 0.3.
    const axis = entity(result.a.axisRepId!);
    const polyline = entity((axis?.attributes[3] as string[])[0]);
    const [from, to] = (polyline?.attributes[0] as string[]).map((ref) => entity(ref)?.attributes[0] as number[]);
    expect(from[0]).toBeCloseTo(-0.3, 12);
    expect(to[0]).toBeCloseTo(3.7, 12);
    // The body starts at A's face, y = 0.1: x = -0.2 in B's frame.
    const profile = entity(result.a.profileId);
    const centre = entity(entity(profile?.attributes[2] as string)?.attributes[0] as string)?.attributes[0] as number[];
    expect(centre[0] - (profile?.attributes[3] as number) / 2).toBeCloseTo(-0.2, 12);
  });

  it('chains: a wall joined at both ends keeps the first cut', () => {
    const { editor, anchor, entity, build } = setup();
    const a = build(WALL_A);
    const b = build(WALL_B);
    const c = build({ Start: [0, 4, 0], End: [-5, 4, 0], Thickness: 0.2, Height: 3 });
    const first = applyWallJoinToStore(editor, anchor, a, b);
    const second = applyWallJoinToStore(editor, anchor, first.b, c, { priority: 'b' });
    expect(second.a.wall.startCut).toEqual(first.b.wall.startCut);
    // B: from y = 0.1 (A's face) to y = 3.9 (C's face).
    expect(entity(second.a.profileId)?.attributes[3]).toBeCloseTo(3.8, 12);
  });

  it('a T leaves the through wall alone and slants the other at an angle', () => {
    const { editor, anchor, entity, attr, build } = setup();
    const r = build({ Start: [-4, 0, 0], End: [4, 0, 0], Thickness: 0.3, Height: 3 });
    const w = build({ Start: [1, 0, 0], End: [3, 3, 0], Thickness: 0.2, Height: 3 });
    const before = attr(r.productShapeId, 2);
    const result = applyWallJoinToStore(editor, anchor, w, r);
    expect(result.join.kind).toBe('T');
    expect(result.b).toEqual(r);
    expect(attr(r.productShapeId, 2)).toEqual(before);
    expect(attr(r.solidId, 0)).toBe(`#${r.profileId}`);
    expect(entity(result.a.profileId)?.type).toBe('IfcArbitraryClosedProfileDef');
    expect(entity(result.relId)?.attributes.slice(5)).toEqual([`#${r.wallId}`, `#${w.wallId}`, [], [], '.ATSTART.', '.ATPATH.']);
  });

  it('passes layer priorities through by wall', () => {
    const { editor, anchor, entity, build } = setup();
    const a = build(WALL_A);
    const b = build(WALL_B);
    const result = applyWallJoinToStore(editor, anchor, a, b, { priority: 'b', priorities: { a: [10], b: [80, 20] } });
    expect(entity(result.relId)?.attributes.slice(5, 9)).toEqual([`#${b.wallId}`, `#${a.wallId}`, [80, 20], [10]]);
  });

  it.each(['IFC2X3', 'IFC4X3'] as const)('writes the %s layout', (schema) => {
    const { editor, anchor, entity, build } = setup(schema);
    const result = applyWallJoinToStore(editor, anchor, build(WALL_A), build(WALL_B));
    expect(entity(result.relId)?.attributes).toHaveLength(11);
    expect(entity(result.relId)?.attributes.slice(9)).toEqual(['.ATSTART.', '.ATEND.']);
  });

  it.each(['IFC5', 'IFCX'])('refuses %s before writing anything', (schema) => {
    const { view, editor, anchor, build } = setup();
    const a = build(WALL_A);
    const b = build(WALL_B);
    const count = view.getNewEntities().length;
    expect(() => applyWallJoinToStore(editor, { ...anchor, schema: schema as SpatialAnchorSchema }, a, b)).toThrow(/not supported/);
    expect(view.getNewEntities()).toHaveLength(count);
  });

  it('writes nothing when the walls do not meet, or IFC2X3 has no OwnerHistory', () => {
    const { view, editor, anchor, build } = setup('IFC2X3');
    const a = build(WALL_A);
    const b = build({ ...WALL_B, Start: [3, 1, 0], End: [3, 4, 0] });
    const count = view.getNewEntities().length;
    expect(() => applyWallJoinToStore(editor, anchor, a, b)).toThrow(/cross|do not meet/);
    const c = build(WALL_B);
    const after = view.getNewEntities().length;
    expect(() => applyWallJoinToStore(editor, { ...anchor, ownerHistoryId: null }, a, c)).toThrow(/OwnerHistory is mandatory/);
    expect(view.getNewEntities()).toHaveLength(after);
    expect(after).toBeGreaterThan(count);
  });
});

describe('addRelConnectsPathElementsToStore', () => {
  it('writes the relationship and refuses non-elements and self-connections', () => {
    const { editor, anchor, entity, build } = setup();
    const a = build(WALL_A);
    const b = build(WALL_B);
    const relId = addRelConnectsPathElementsToStore(editor, anchor, {
      RelatingElement: a.wallId, RelatedElement: b.wallId, RelatingConnectionType: 'ATPATH', RelatedConnectionType: 'ATEND', Name: 'Join',
    });
    expect(entity(relId)?.attributes.slice(2)).toEqual(['Join', null, null, `#${a.wallId}`, `#${b.wallId}`, [], [], '.ATEND.', '.ATPATH.']);
    const params = { RelatingElement: a.wallId, RelatedElement: b.wallId, RelatingConnectionType: 'ATSTART', RelatedConnectionType: 'ATEND' } as const;
    expect(() => addRelConnectsPathElementsToStore(editor, anchor, { ...params, RelatedElement: a.wallId })).toThrow(/itself/);
    expect(() => addRelConnectsPathElementsToStore(editor, anchor, { ...params, RelatedElement: a.solidId })).toThrow(/not an IfcElement/);
    expect(() => addRelConnectsPathElementsToStore(editor, anchor, { ...params, RelatedElement: 9999 })).toThrow(/not a live entity/);
    expect(() => addRelConnectsPathElementsToStore(editor, anchor, { ...params, RelatingPriorities: [1.5] })).toThrow(/integers/);
    expect(() => addRelConnectsPathElementsToStore(editor, { ...anchor, schema: 'IFC5' }, params)).toThrow(/IFC5 models is not supported/);
  });
});
