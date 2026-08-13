/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcSpatialZone` emission (#2508 item 3).
 *
 * The assertions that matter here are the SCHEMA ones, because the whole
 * argument for this type over `IfcZone` rests on them: nine attributes rather
 * than ten (no `CompositionType`, since a zone is not part of the containment
 * hierarchy), and elements attached by REFERENCE rather than by containment.
 * A test that only checked "an entity was emitted" would pass on the very
 * shape `docs/design/zone-emission.md` argues against.
 */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { addSpatialZonesToStore, spatialZonesSupported } from './spatial-zone.js';
import type { SpatialAnchor } from './anchor.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

const ANCHOR: SpatialAnchor = {
  ownerHistoryId: 5,
  bodyContextId: 14,
  axisContextId: 15,
  storeyId: 43,
  storeyPlacementId: 54,
};

function session(anchor: SpatialAnchor = ANCHOR) {
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(makeStore(50), view);
  return { view, editor, anchor };
}

const BOX = {
  Name: 'Takt A',
  Position: [10, 20, 0] as [number, number, number],
  Width: 6,
  Depth: 4,
  Height: 3,
};

describe('addSpatialZonesToStore', () => {
  it('emits an IfcSpatialZone with the NINE attributes the schema gives it', () => {
    const { editor, view } = session();
    const result = addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [BOX],
      RelatedElements: [[]],
    });

    const zone = view.getNewEntities().find((e) => e.expressId === result.zoneIds[0]);
    expect(zone?.type).toBe('IfcSpatialZone');
    // Nine, not ten: `IfcSpatialZone` derives from `IfcSpatialElement`, not
    // `IfcSpatialStructureElement`, so there is no `CompositionType`. Emitting
    // a tenth would produce a record no IFC4 reader can parse.
    expect(zone?.attributes).toHaveLength(9);
    expect(zone?.attributes[1]).toBe('#5');            // OwnerHistory
    expect(zone?.attributes[2]).toBe('Takt A');        // Name = the zone
    expect(zone?.attributes[7]).toBe('Takt areas');    // LongName = the set
    expect(zone?.attributes[8]).toBe('.CONSTRUCTION.'); // PredefinedType
  });

  it('attaches elements by REFERENCE, never by containment', () => {
    // The distinction the whole design rests on: containment is exclusive, so
    // re-pointing it would move the element out of the storey that owns it.
    const { editor, view } = session();
    const result = addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [BOX],
      RelatedElements: [[11, 22, 33]],
    });

    const entities = view.getNewEntities();
    expect(entities.some((e) => e.type === 'IfcRelContainedInSpatialStructure')).toBe(false);

    const rel = entities.find((e) => e.expressId === result.relReferencedIds[0]);
    expect(rel?.type).toBe('IfcRelReferencedInSpatialStructure');
    expect(rel?.attributes[4]).toEqual(['#11', '#22', '#33']);  // RelatedElements
    expect(rel?.attributes[5]).toBe(`#${result.zoneIds[0]}`);   // RelatingStructure
  });

  it('lets one element belong to every zone it crosses', () => {
    // A straddler is referenced twice. That is legal precisely because
    // referencing is many-to-many, and it is the truthful topology.
    const { editor, view } = session();
    const result = addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [BOX, { ...BOX, Name: 'Takt B', Position: [16, 20, 0] }],
      RelatedElements: [[77], [77]],
    });

    expect(result.zoneIds).toHaveLength(2);
    const rels = view.getNewEntities().filter((e) => e.type === 'IfcRelReferencedInSpatialStructure');
    expect(rels).toHaveLength(2);
    expect(rels.every((r) => (r.attributes[4] as string[]).includes('#77'))).toBe(true);
  });

  it('emits no relationship for a zone nothing touches', () => {
    const { editor, view } = session();
    addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [BOX],
      RelatedElements: [[]],
    });
    expect(view.getNewEntities().some((e) => e.type === 'IfcRelReferencedInSpatialStructure')).toBe(false);
  });

  it('converts every dimension into the file\'s native length unit', () => {
    // A millimetre file. Emitting metres here is the #2508 write-back's own
    // failure mode in geometric form: a zone a thousand times too small.
    const { editor, view } = session({ ...ANCHOR, lengthUnitScale: 0.001 });
    const result = addSpatialZonesToStore(editor, { ...ANCHOR, lengthUnitScale: 0.001 }, {
      LongName: 'Takt areas',
      zones: [BOX],
      RelatedElements: [[]],
    });

    const entities = view.getNewEntities();
    const zone = entities.find((e) => e.expressId === result.zoneIds[0]);
    const placement = entities.find((e) => `#${e.expressId}` === zone?.attributes[5]);
    const axis = entities.find((e) => `#${e.expressId}` === placement?.attributes[1]);
    const origin = entities.find((e) => `#${e.expressId}` === axis?.attributes[0]);
    expect(origin?.attributes[0]).toEqual([10000, 20000, 0]);

    const profile = entities.find((e) => e.type === 'IfcRectangleProfileDef');
    expect(profile?.attributes[3]).toBe(6000);
    expect(profile?.attributes[4]).toBe(4000);
    const solid = entities.find((e) => e.type === 'IfcExtrudedAreaSolid');
    expect(solid?.attributes[3]).toBe(3000);
  });

  it('carries rotation in the placement, leaving the profile a plain rectangle', () => {
    const { editor, view } = session();
    const result = addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [{ ...BOX, RotationZ: Math.PI / 2 }],
      RelatedElements: [[]],
    });

    const entities = view.getNewEntities();
    const zone = entities.find((e) => e.expressId === result.zoneIds[0]);
    const placement = entities.find((e) => `#${e.expressId}` === zone?.attributes[5]);
    const axis = entities.find((e) => `#${e.expressId}` === placement?.attributes[1]);
    const refDir = entities.find((e) => `#${e.expressId}` === axis?.attributes[2]);
    const dir = refDir?.attributes[0] as number[];
    expect(Math.abs(dir[0] - 0)).toBeLessThan(1e-9);
    expect(Math.abs(dir[1] - 1)).toBeLessThan(1e-9);

    // Still a rectangle: a receiving tool reads the shape without unpicking a
    // rotated polygon.
    expect(entities.some((e) => e.type === 'IfcRectangleProfileDef')).toBe(true);
  });

  it('emits an unrotated placement with no RefDirection at all', () => {
    const { editor, view } = session();
    const result = addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas', zones: [BOX], RelatedElements: [[]],
    });
    const entities = view.getNewEntities();
    const zone = entities.find((e) => e.expressId === result.zoneIds[0]);
    const placement = entities.find((e) => `#${e.expressId}` === zone?.attributes[5]);
    const axis = entities.find((e) => `#${e.expressId}` === placement?.attributes[1]);
    expect(axis?.attributes[2]).toBeNull();
  });

  it('places a prism by its polygon, relative to the placement rather than twice', () => {
    // The footprint arrives in world coordinates and the placement already
    // carries the position, so the points must be made relative. Emitting both
    // absolute would put the zone at twice its coordinates.
    const { editor, view } = session();
    const result = addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [{ ...BOX, Footprint: [[10, 20], [16, 20], [16, 24]] }],
      RelatedElements: [[]],
    });

    const entities = view.getNewEntities();
    const zone = entities.find((e) => e.expressId === result.zoneIds[0]);
    const placement = entities.find((e) => `#${e.expressId}` === zone?.attributes[5]);
    const axis = entities.find((e) => `#${e.expressId}` === placement?.attributes[1]);
    const origin = entities.find((e) => `#${e.expressId}` === axis?.attributes[0]);
    expect(origin?.attributes[0]).toEqual([10, 20, 0]);

    expect(entities.some((e) => e.type === 'IfcArbitraryClosedProfileDef')).toBe(true);
    expect(entities.some((e) => e.type === 'IfcRectangleProfileDef')).toBe(false);

    const polyline = entities.find((e) => e.type === 'IfcPolyline');
    const pointRefs = polyline?.attributes[0] as string[];
    const points = pointRefs.map((ref) => entities.find((e) => `#${e.expressId}` === ref)?.attributes[0]);
    // Relative to (10, 20), and closed back to the first point.
    expect(points[0]).toEqual([0, 0]);
    expect(points[1]).toEqual([6, 0]);
    expect(points[2]).toEqual([6, 4]);
    expect(points[3]).toEqual([0, 0]);
  });

  it('refuses IFC2X3, where the type does not exist', () => {
    expect(spatialZonesSupported('IFC2X3')).toBe(false);
    expect(spatialZonesSupported('IFC4')).toBe(true);
    expect(spatialZonesSupported(undefined)).toBe(true);

    const { editor } = session({ ...ANCHOR, schema: 'IFC2X3' });
    expect(() => addSpatialZonesToStore(editor, { ...ANCHOR, schema: 'IFC2X3' }, {
      LongName: 'Takt areas', zones: [BOX], RelatedElements: [[]],
    })).toThrow(/IFC4 or later/);
  });

  it('refuses a degenerate footprint rather than quietly emitting a box', () => {
    // Two points cannot be a profile. Falling back to Width/Depth would emit a
    // shape the caller did not ask for, and (before the fix) would also discard
    // the rotation, since the fallback path is the rotated one.
    const { editor } = session();
    expect(() => addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [{ ...BOX, Footprint: [[0, 0], [1, 0]] }],
      RelatedElements: [[]],
    })).toThrow(/fewer than 3 points/);
  });

  it('refuses a box with a zero extent', () => {
    // An IfcRectangleProfileDef with XDim 0 is a shape no reader can use, and
    // the emission would report success.
    const { editor } = session();
    for (const bad of [{ Width: 0 }, { Depth: Number.NaN }]) {
      expect(() => addSpatialZonesToStore(editor, ANCHOR, {
        LongName: 'Takt areas',
        zones: [{ ...BOX, ...bad }],
        RelatedElements: [[]],
      })).toThrow(/finite positive (Width|Depth)/);
    }
  });

  it('does not check the extents of a zone whose shape is a polygon', () => {
    // A prism carries its own extents, so a caller that leaves Width/Depth at
    // zero is not wrong.
    const { editor, view } = session();
    addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [{ ...BOX, Width: 0, Depth: 0, Footprint: [[10, 20], [16, 20], [16, 24]] }],
      RelatedElements: [[]],
    });
    expect(view.getNewEntities().some((e) => e.type === 'IfcArbitraryClosedProfileDef')).toBe(true);
  });

  it('writes NOTHING when a later zone is invalid', () => {
    // The one that makes prevalidation worth having: a caller told the call
    // failed, with the first zone already in the overlay, has a half-built
    // takt plan and no way to know it.
    const { editor, view } = session();
    expect(() => addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [BOX, { ...BOX, Name: 'Takt B', Height: 0 }],
      RelatedElements: [[], []],
    })).toThrow(/Height/);
    expect(view.getNewEntities()).toHaveLength(0);
  });

  it('refuses a PredefinedType outside IfcSpatialZoneTypeEnum', () => {
    const { editor } = session();
    expect(() => addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [BOX],
      RelatedElements: [[]],
      PredefinedType: 'TAKT' as never,
    })).toThrow(/IfcSpatialZoneTypeEnum/);
  });

  it('requires ObjectType with USERDEFINED, and writes it', () => {
    // IFC4's `CorrectPredefinedType`: USERDEFINED means the type is named in
    // ObjectType, so emitting `$` there is a file that breaks the rule.
    const { editor, view } = session();
    expect(() => addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas', zones: [BOX], RelatedElements: [[]], PredefinedType: 'USERDEFINED',
    })).toThrow(/ObjectType/);

    const result = addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [BOX],
      RelatedElements: [[]],
      PredefinedType: 'USERDEFINED',
      ObjectType: 'Takt area',
    });
    const zone = view.getNewEntities().find((e) => e.expressId === result.zoneIds[0]);
    expect(zone?.attributes[4]).toBe('Takt area');
    expect(zone?.attributes[8]).toBe('.USERDEFINED.');
  });

  it('refuses a non-finite Position rather than emitting NaN coordinates', () => {
    const { editor } = session();
    expect(() => addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [{ ...BOX, Position: [Number.NaN, 0, 0] }],
      RelatedElements: [[]],
    })).toThrow(/finite Position/);
  });

  it('refuses a zone with no height rather than emitting a flat solid', () => {
    const { editor } = session();
    expect(() => addSpatialZonesToStore(editor, ANCHOR, {
      LongName: 'Takt areas',
      zones: [{ ...BOX, Height: 0 }],
      RelatedElements: [[]],
    })).toThrow(/Height/);
  });
});
