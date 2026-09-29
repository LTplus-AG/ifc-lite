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
import { addStairToStore, stairFlightOutline, type StairInStoreParams } from './stair.js';
import { addRailingToStore, railingPostPoints, type RailingInStoreParams } from './railing.js';

function setup(schema?: SpatialAnchorSchema, extra: Partial<SpatialAnchor> = {}) {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= 60; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  const store: MutationStoreShape = { entityIndex: { byId } };
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(store, view);
  const anchor: SpatialAnchor = {
    ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54, schema, ...extra,
  };
  const entity = (id: number) => view.getNewEntities().find((e) => e.expressId === id)!;
  const ref = (value: unknown) => entity(Number(String(value).slice(1)));
  return { editor, view, anchor, entity, ref };
}

const STAIR: StairInStoreParams = { Position: [1, 2, 0], NumberOfRisers: 3, RiserHeight: 0.2, TreadLength: 0.3, Width: 1 };
const RAIL: RailingInStoreParams = { Path: [[0, 0, 0], [3, 0, 0], [3, 2, 0]], Height: 1 };

describe('addStairToStore', () => {
  it('emits an IfcStair in the storey aggregating an IfcStairFlight that carries the body', () => {
    const { editor, anchor, entity, ref } = setup('IFC4');
    const r = addStairToStore(editor, anchor, { ...STAIR, Name: 'S1' });

    const stair = entity(r.stairId);
    expect(stair.type).toBe('IfcStair');
    expect(stair.attributes[2]).toBe('S1');
    expect(stair.attributes[5]).toBe(`#${r.placementId}`);
    expect(stair.attributes[6]).toBeNull(); // geometry lives on the flight
    expect(stair.attributes[8]).toBe('.STRAIGHT_RUN_STAIR.');

    const flight = entity(r.flightId);
    expect(flight.type).toBe('IfcStairFlight');
    expect(flight.attributes[5]).toBe(`#${r.flightPlacementId}`);
    expect(flight.attributes[6]).toBe(`#${r.productShapeId}`);
    expect(flight.attributes.slice(8)).toEqual([3, 3, { real: 0.2 }, { real: 0.3 }, '.STRAIGHT.']);
    // The flight is placed relative to the stair.
    expect(entity(r.flightPlacementId).attributes[0]).toBe(`#${r.placementId}`);
    expect(entity(r.placementId).attributes[0]).toBe('#54');

    expect(entity(r.relAggregatesId).type).toBe('IfcRelAggregates');
    expect(entity(r.relAggregatesId).attributes.slice(4)).toEqual([`#${r.stairId}`, [`#${r.flightId}`]]);
    expect(entity(r.relContainedId).attributes.slice(4)).toEqual([[`#${r.stairId}`], '#43']);

    // One extruded stepped profile, across the width.
    const solid = entity(r.solidId);
    expect(solid.type).toBe('IfcExtrudedAreaSolid');
    expect(solid.attributes[3]).toBe(1);
    expect(entity(r.profileId).type).toBe('IfcArbitraryClosedProfileDef');
    const polyline = ref(entity(r.profileId).attributes[2]);
    // 1 + 2 per riser + back corner, closed.
    expect((polyline.attributes[0] as string[]).length).toBe(1 + 2 * 3 + 1 + 1);
  });

  it('rotates the run with Direction via the placement RefDirection', () => {
    const { editor, anchor, entity, ref } = setup();
    const r = addStairToStore(editor, anchor, { ...STAIR, Direction: Math.PI / 2 });
    const axes = ref(entity(r.placementId).attributes[1]);
    const refDirection = ref(axes.attributes[2]).attributes[0] as number[];
    expect(refDirection[0]).toBeCloseTo(0, 12);
    expect(refDirection[1]).toBeCloseTo(1, 12);
  });

  it('builds a stepped outline, solid or with a waist parallel to the pitch', () => {
    expect(stairFlightOutline(2, 0.2, 0.3)).toEqual([
      [0.6, 0], [0.6, 0.4], [0.3, 0.4], [0.3, 0.2], [0, 0.2], [0, 0],
    ]);
    const waisted = stairFlightOutline(2, 0.2, 0.3, 0.1);
    const drop = 0.1 * Math.hypot(0.2, 0.3) / 0.3;
    expect(waisted[0][0]).toBeCloseTo(drop * 0.3 / 0.2, 12);
    expect(waisted[0][1]).toBe(0);
    expect(waisted[1][0]).toBe(0.6);
    expect(waisted[1][1]).toBeCloseTo(0.4 - drop, 12);
  });

  it('lays out IFC2X3 (ShapeType, NumberOfRiser, no flight PredefinedType) and IFC4X3', () => {
    const v2 = setup('IFC2X3');
    const r2 = addStairToStore(v2.editor, v2.anchor, STAIR);
    expect(v2.entity(r2.stairId).attributes).toHaveLength(9);
    expect(v2.entity(r2.stairId).attributes[8]).toBe('.STRAIGHT_RUN_STAIR.');
    expect(v2.entity(r2.flightId).attributes.slice(8)).toEqual([3, 3, { real: 0.2 }, { real: 0.3 }]);

    const v43 = setup('IFC4X3');
    const r43 = addStairToStore(v43.editor, v43.anchor, STAIR);
    expect(v43.entity(r43.flightId).attributes).toHaveLength(13);
  });

  it('converts to the native length unit', () => {
    const { editor, anchor, entity } = setup('IFC4', { lengthUnitScale: 0.001 });
    const r = addStairToStore(editor, anchor, STAIR);
    expect(entity(r.flightId).attributes.slice(10, 12)).toEqual([{ real: 200 }, { real: 300 }]);
    expect(entity(r.solidId).attributes[3]).toBe(1000);
  });

  it.each([
    ['IFC5 model', 'IFC5', {}, /IFC5/],
    ['fractional risers', 'IFC4', { NumberOfRisers: 2.5 }, /NumberOfRisers/],
    ['zero riser', 'IFC4', { RiserHeight: 0 }, /RiserHeight/],
    ['NaN position', 'IFC4', { Position: [Number.NaN, 0, 0] }, /finite/],
    ['waist too thick', 'IFC4', { WaistThickness: 5 }, /WaistThickness/],
    ['bad PredefinedType', 'IFC4', { PredefinedType: 'ESCALATOR' }, /PredefinedType/],
    ['bad GlobalId', 'IFC4', { GlobalId: 'nope' }, /GlobalId/],
  ] as Array<[string, SpatialAnchorSchema, Partial<StairInStoreParams>, RegExp]>)('refuses %s before emitting', (_label, schema, patch, message) => {
    const { editor, anchor, view } = setup(schema);
    expect(() => addStairToStore(editor, anchor, { ...STAIR, ...patch })).toThrow(message);
    expect(view.getNewEntities()).toHaveLength(0);
  });

  it('refuses an IFC2X3 stair without an owner history (mandatory there) before emitting', () => {
    const { editor, anchor, view } = setup('IFC2X3', { ownerHistoryId: null });
    expect(() => addStairToStore(editor, anchor, STAIR)).toThrow(/OwnerHistory is mandatory/);
    expect(view.getNewEntities()).toHaveLength(0);
  });
});

describe('addRailingToStore', () => {
  it('sweeps a disk along the path at the rail centreline, with a post per vertex', () => {
    const { editor, anchor, entity, ref } = setup('IFC4');
    const r = addRailingToStore(editor, anchor, { ...RAIL, Name: 'R1' });

    const railing = entity(r.railingId);
    expect(railing.type).toBe('IfcRailing');
    expect(railing.attributes[2]).toBe('R1');
    expect(railing.attributes[8]).toBe('.HANDRAIL.');
    expect(entity(r.relContainedId).attributes.slice(4)).toEqual([[`#${r.railingId}`], '#43']);

    const rail = entity(r.railSolidId);
    expect(rail.type).toBe('IfcSweptDiskSolid');
    expect(rail.attributes.slice(1)).toEqual([{ real: 0.025 }, null, null, null]);
    const directrix = ref(rail.attributes[0]);
    expect(directrix.type).toBe('IfcPolyline');
    expect((directrix.attributes[0] as string[]).map((p) => ref(p).attributes[0])).toEqual([
      [0, 0, 0.975], [3, 0, 0.975], [3, 2, 0.975],
    ]);

    expect(r.postSolidIds).toHaveLength(3);
    for (const id of r.postSolidIds) {
      const post = entity(id);
      expect(post.type).toBe('IfcExtrudedAreaSolid');
      expect(ref(post.attributes[0]).type).toBe('IfcCircleProfileDef');
      expect(post.attributes[3]).toBe(0.975);
    }
    expect(entity(r.shapeRepId).attributes.slice(1)).toEqual([
      'Body', 'SolidModel', [r.railSolidId, ...r.postSolidIds].map((id) => `#${id}`),
    ]);
  });

  it('places the railing at the first path point and keeps the path relative to it', () => {
    const { editor, anchor, entity, ref } = setup();
    const r = addRailingToStore(editor, anchor, { Path: [[2, 3, 1], [4, 3, 2]], Height: 0.9 });
    const axes = ref(entity(r.placementId).attributes[1]);
    expect(ref(axes.attributes[0]).attributes[0]).toEqual([2, 3, 1]);
    const directrix = ref(entity(r.railSolidId).attributes[0]);
    expect((directrix.attributes[0] as string[]).map((p) => ref(p).attributes[0])).toEqual([
      [0, 0, 0.875], [2, 0, 1.875],
    ]);
  });

  it('adds intermediate posts no further apart than PostSpacing', () => {
    expect(railingPostPoints([[0, 0, 0], [3, 0, 0]], 1)).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]);
    expect(railingPostPoints([[0, 0, 0], [2.5, 0, 0]], 1).length).toBe(4);
    expect(railingPostPoints([[0, 0, 0], [1, 0, 0], [1, 1, 0]])).toHaveLength(3);
  });

  it('writes the polyline range as StartParam/EndParam on IFC2X3, where they are mandatory', () => {
    const { editor, anchor, entity } = setup('IFC2X3');
    const r = addRailingToStore(editor, anchor, RAIL);
    expect(entity(r.railSolidId).attributes.slice(2)).toEqual([null, { real: 0 }, { real: 2 }]);
  });

  it.each([
    ['IFC5 model', 'IFC5', {}, /IFC5/],
    ['one-point path', 'IFC4', { Path: [[0, 0, 0]] }, /two points/],
    ['repeated point', 'IFC4', { Path: [[0, 0, 0], [0, 0, 0]] }, /distinct/],
    ['NaN point', 'IFC4', { Path: [[0, 0, 0], [1, Number.NaN, 0]] }, /finite/],
    ['rail taller than the railing', 'IFC4', { Height: 0.04 }, /Height/],
    ['zero spacing', 'IFC4', { PostSpacing: 0 }, /PostSpacing/],
    ['bad PredefinedType', 'IFC4', { PredefinedType: 'FENCE' }, /PredefinedType/],
  ] as Array<[string, SpatialAnchorSchema, Partial<RailingInStoreParams>, RegExp]>)('refuses %s before emitting', (_label, schema, patch, message) => {
    const { editor, anchor, view } = setup(schema);
    expect(() => addRailingToStore(editor, anchor, { ...RAIL, ...patch })).toThrow(message);
    expect(view.getNewEntities()).toHaveLength(0);
  });
});
