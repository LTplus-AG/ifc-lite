/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native length-unit emission across every in-store builder.
 *
 * Builder params are metres (the renderer frame); the emitted STEP
 * coordinates must land in the file's native length unit or a space/
 * wall/… baked into a millimetre model exports 1000× too small while
 * its in-session mesh (built separately in metres) looks correct.
 * One test per builder pins the conversion (lengthUnitScale 0.001).
 */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
  type NewEntity,
} from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { addWallToStore } from './wall.js';
import { addSlabToStore } from './slab.js';
import { addBeamToStore } from './beam.js';
import { addColumnToStore } from './column.js';
import { addDoorToStore } from './door.js';
import { addWindowToStore } from './window.js';
import { addRoofToStore } from './roof.js';
import { addPlateToStore } from './plate.js';
import { addMemberToStore } from './member.js';
import { duplicateInStore } from './duplicate.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

/** Millimetre-file anchor: 0.001 metres per native unit. */
const MM_ANCHOR: SpatialAnchor = {
  ownerHistoryId: 5,
  bodyContextId: 14,
  storeyId: 43,
  storeyPlacementId: 54,
  lengthUnitScale: 0.001,
};

function harness(): { view: MutablePropertyView; editor: StoreEditor; byId: () => Map<number, NewEntity> } {
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(makeStore(60), view);
  return { view, editor, byId: () => new Map(view.getNewEntities().map((e) => [e.expressId, e])) };
}

describe('in-store builders emit native length units (mm model)', () => {
  it('wall: profile dims, profile origin, and extrusion in mm', () => {
    const { editor, byId } = harness();
    const r = addWallToStore(editor, MM_ANCHOR, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    const ents = byId();
    const profile = ents.get(r.profileId);
    expect(profile?.attributes[3]).toBeCloseTo(5000, 6);  // XDim = length
    expect(profile?.attributes[4]).toBeCloseTo(200, 6);   // YDim = thickness
    expect(ents.get(r.solidId)?.attributes[3]).toBeCloseTo(3000, 6);
  });

  it('slab (polygon): outline points and extrusion in mm', () => {
    const { view, editor, byId } = harness();
    const r = addSlabToStore(editor, MM_ANCHOR, {
      Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 3], [0, 3]], Thickness: 0.25,
    });
    expect(byId().get(r.solidId)?.attributes[3]).toBeCloseTo(250, 6);
    const corner = view.getNewEntities().find((e) => e.type === 'IfcCartesianPoint'
      && Array.isArray(e.attributes[0])
      && (e.attributes[0] as number[])[0] === 4000 && (e.attributes[0] as number[])[1] === 3000);
    expect(corner, 'expected a (4000, 3000) mm outline point').toBeTruthy();
  });

  it('beam: start point, cross-section, and length in mm', () => {
    const { view, editor, byId } = harness();
    const r = addBeamToStore(editor, MM_ANCHOR, { Start: [1, 0, 3], End: [5, 0, 3], Width: 0.3, Height: 0.5 });
    const ents = byId();
    expect(ents.get(r.profileId)?.attributes[3]).toBeCloseTo(300, 6);
    expect(ents.get(r.profileId)?.attributes[4]).toBeCloseTo(500, 6);
    expect(ents.get(r.solidId)?.attributes[3]).toBeCloseTo(4000, 6); // beam length
    const start = view.getNewEntities().find((e) => e.type === 'IfcCartesianPoint'
      && Array.isArray(e.attributes[0]) && (e.attributes[0] as number[])[0] === 1000);
    expect(start, 'expected the (1000, 0, 3000) mm start point').toBeTruthy();
  });

  it('column: position, profile dims, and height in mm', () => {
    const { view, editor, byId } = harness();
    const r = addColumnToStore(editor, MM_ANCHOR, { Position: [2, 3, 0], Width: 0.4, Depth: 0.4, Height: 3 });
    const ents = byId();
    expect(ents.get(r.profileId)?.attributes[3]).toBeCloseTo(400, 6);
    expect(ents.get(r.solidId)?.attributes[3]).toBeCloseTo(3000, 6);
    const pos = view.getNewEntities().find((e) => e.type === 'IfcCartesianPoint'
      && Array.isArray(e.attributes[0])
      && (e.attributes[0] as number[])[0] === 2000 && (e.attributes[0] as number[])[1] === 3000);
    expect(pos, 'expected the (2000, 3000, 0) mm position').toBeTruthy();
  });

  it('door: OverallHeight/OverallWidth attributes and solid in mm', () => {
    const { editor, byId } = harness();
    const r = addDoorToStore(editor, MM_ANCHOR, { Position: [1, 0, 0], Width: 0.9, Height: 2.1 });
    const ents = byId();
    const door = ents.get(r.doorId);
    expect(door?.attributes[8]).toBeCloseTo(2100, 6); // OverallHeight
    expect(door?.attributes[9]).toBeCloseTo(900, 6);  // OverallWidth
    expect(ents.get(r.solidId)?.attributes[3]).toBeCloseTo(2100, 6);
    expect(ents.get(r.profileId)?.attributes[4]).toBeCloseTo(50, 6); // default 0.05 m frame
  });

  it('window: OverallHeight/OverallWidth attributes and solid in mm', () => {
    const { editor, byId } = harness();
    const r = addWindowToStore(editor, MM_ANCHOR, { Position: [1, 0, 1], Width: 1.2, Height: 1.4 });
    const ents = byId();
    const win = ents.get(r.windowId);
    expect(win?.attributes[8]).toBeCloseTo(1400, 6);
    expect(win?.attributes[9]).toBeCloseTo(1200, 6);
    expect(ents.get(r.solidId)?.attributes[3]).toBeCloseTo(1400, 6);
  });

  it('roof (rectangle): profile dims and thickness in mm', () => {
    const { editor, byId } = harness();
    const r = addRoofToStore(editor, MM_ANCHOR, { Position: [0, 0, 6], Width: 10, Depth: 8, Thickness: 0.3 });
    const ents = byId();
    expect(ents.get(r.profileId)?.attributes[3]).toBeCloseTo(10000, 6);
    expect(ents.get(r.profileId)?.attributes[4]).toBeCloseTo(8000, 6);
    expect(ents.get(r.solidId)?.attributes[3]).toBeCloseTo(300, 6);
  });

  it('plate (polygon): outline and thickness in mm', () => {
    const { view, editor, byId } = harness();
    const r = addPlateToStore(editor, MM_ANCHOR, {
      Profile: 'polygon', OuterCurve: [[0, 0], [2, 0], [2, 1], [0, 1]], Thickness: 0.02,
    });
    expect(byId().get(r.solidId)?.attributes[3]).toBeCloseTo(20, 6);
    const corner = view.getNewEntities().find((e) => e.type === 'IfcCartesianPoint'
      && Array.isArray(e.attributes[0])
      && (e.attributes[0] as number[])[0] === 2000 && (e.attributes[0] as number[])[1] === 1000);
    expect(corner, 'expected a (2000, 1000) mm outline point').toBeTruthy();
  });

  it('member: cross-section and length in mm', () => {
    const { editor, byId } = harness();
    const r = addMemberToStore(editor, MM_ANCHOR, { Start: [0, 0, 0], End: [0, 0, 2.5], Width: 0.1, Height: 0.1 });
    const ents = byId();
    expect(ents.get(r.profileId)?.attributes[3]).toBeCloseTo(100, 6);
    expect(ents.get(r.solidId)?.attributes[3]).toBeCloseTo(2500, 6);
  });

  it('metre models (no lengthUnitScale) emit params verbatim', () => {
    const { editor, byId } = harness();
    const r = addWallToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 },
    );
    expect(byId().get(r.solidId)?.attributes[3]).toBe(3);
  });
});

describe('duplicateInStore offset in native units', () => {
  it('converts the metre offset onto a mm-file source location', () => {
    const { view, editor } = harness();
    const r = duplicateInStore(editor, {
      type: 'IfcWall',
      attributes: ['gid', null, 'Wall', null, null, '#10', '#11', null],
      placementExpressId: 10,
      parentPlacementId: 9,
      sourceLocation: [1000, 0, 0],   // 1 m, in mm
      representationId: 11,
      ownerHistoryId: null,
      axisRef: null,
      refDirectionRef: null,
      storeyId: 43,
      lengthUnitScale: 0.001,
    }, { offset: [2, 0, 0] });        // 2 m
    const point = view.getNewEntities().find((e) => e.expressId === r.newPointId);
    expect(point?.attributes[0]).toEqual([3000, 0, 0]); // 1 m + 2 m = 3000 mm
  });

  it('defaults to metres when the source carries no scale', () => {
    const { view, editor } = harness();
    const r = duplicateInStore(editor, {
      type: 'IfcWall',
      attributes: ['gid', null, 'Wall', null, null, '#10', '#11', null],
      placementExpressId: 10,
      parentPlacementId: 9,
      sourceLocation: [1, 0, 0],
      representationId: 11,
      ownerHistoryId: null,
      axisRef: null,
      refDirectionRef: null,
      storeyId: 43,
    }, { offset: [2, 0, 0] });
    const point = view.getNewEntities().find((e) => e.expressId === r.newPointId);
    expect(point?.attributes[0]).toEqual([3, 0, 0]);
  });
});
