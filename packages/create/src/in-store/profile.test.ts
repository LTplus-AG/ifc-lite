/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared profile factory (`profile.ts`), exercised through the builders
 * that use it: `addBeamToStore`, `addColumnToStore`, `addMemberToStore`.
 */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import type { SpatialAnchor, SpatialAnchorSchema } from './anchor.js';
import { profileSectionExtent, type ProfileSection } from './profile.js';
import { addBeamToStore } from './beam.js';
import { addColumnToStore } from './column.js';
import { addMemberToStore } from './member.js';

function setup(schema?: SpatialAnchorSchema, lengthUnitScale?: number) {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= 60; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  const store: MutationStoreShape = { entityIndex: { byId } };
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(store, view);
  const anchor: SpatialAnchor = {
    ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54, schema, lengthUnitScale,
  };
  const entity = (id: number) => view.getNewEntities().find((e) => e.expressId === id)!;
  return { editor, view, anchor, entity };
}

/** The profile entity a beam with `section` is extruded from. */
function beamProfile(schema: SpatialAnchorSchema | undefined, section: ProfileSection, lengthUnitScale?: number) {
  const { editor, anchor, entity } = setup(schema, lengthUnitScale);
  const beam = addBeamToStore(editor, anchor, { Start: [0, 0, 3], End: [4, 0, 3], Profile: section });
  expect(entity(beam.solidId).attributes[0]).toBe(`#${beam.profileId}`);
  return { profile: entity(beam.profileId), entity };
}

const real = (v: number) => ({ real: v });

const SECTIONS: Array<[ProfileSection, string, unknown[]]> = [
  [{ Type: 'Rectangle', XDim: 0.3, YDim: 0.5 }, 'IfcRectangleProfileDef', [real(0.3), real(0.5)]],
  [{ Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016, FilletRadius: 0.02 },
    'IfcIShapeProfileDef', [real(0.2), real(0.4), real(0.01), real(0.016), real(0.02), null, null]],
  [{ Type: 'L', Depth: 0.1, Width: 0.08, Thickness: 0.01 }, 'IfcLShapeProfileDef', [real(0.1), real(0.08), real(0.01), null, null, null]],
  [{ Type: 'T', Depth: 0.12, FlangeWidth: 0.12, WebThickness: 0.01, FlangeThickness: 0.012 },
    'IfcTShapeProfileDef', [real(0.12), real(0.12), real(0.01), real(0.012), null, null, null, null, null]],
  [{ Type: 'U', Depth: 0.2, FlangeWidth: 0.075, WebThickness: 0.0085, FlangeThickness: 0.0115 },
    'IfcUShapeProfileDef', [real(0.2), real(0.075), real(0.0085), real(0.0115), null, null, null]],
  [{ Type: 'C', Depth: 0.2, Width: 0.07, WallThickness: 0.003, Girth: 0.02 },
    'IfcCShapeProfileDef', [real(0.2), real(0.07), real(0.003), real(0.02), null]],
  [{ Type: 'Circle', Radius: 0.15 }, 'IfcCircleProfileDef', [real(0.15)]],
  [{ Type: 'RectangleHollow', XDim: 0.1, YDim: 0.2, WallThickness: 0.008 },
    'IfcRectangleHollowProfileDef', [real(0.1), real(0.2), real(0.008), null, null]],
  [{ Type: 'CircleHollow', Radius: 0.1, WallThickness: 0.008 }, 'IfcCircleHollowProfileDef', [real(0.1), real(0.008)]],
];

describe('profile factory', () => {
  it.each(SECTIONS)('writes %j as %s, centred, laid out for IFC4', (section, cls, tail) => {
    const { profile, entity } = beamProfile('IFC4', section);
    expect(profile.type).toBe(cls);
    expect(profile.attributes.slice(0, 2)).toEqual(['.AREA.', null]);
    expect(profile.attributes.slice(3)).toEqual(tail);
    const position = entity(Number(String(profile.attributes[2]).slice(1)));
    expect(position.type).toBe('IfcAxis2Placement2D');
    expect(entity(Number(String(position.attributes[0]).slice(1))).attributes[0]).toEqual([0, 0]);
  });

  it('lays each schema out from its own registry (D2): IFC2X3 T carries CentreOfGravityInY, IFC4 I its edge radius and slope', () => {
    const t: ProfileSection = { Type: 'T', Depth: 0.12, FlangeWidth: 0.12, WebThickness: 0.01, FlangeThickness: 0.012 };
    const i: ProfileSection = { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 };
    const lengths = (schema: SpatialAnchorSchema) => [t, i].map((s) => beamProfile(schema, s).profile.attributes.length);
    expect(lengths('IFC2X3')).toEqual([13, 8]);
    expect(lengths('IFC4')).toEqual([12, 10]);
    expect(lengths('IFC4X3')).toEqual([12, 10]);
  });

  it('converts to the native length unit', () => {
    const { profile } = beamProfile('IFC4', { Type: 'CircleHollow', Radius: 0.1, WallThickness: 0.008 }, 0.001);
    expect(profile.attributes.slice(3)).toEqual([real(100), real(8)]);
  });

  it.each([
    [{ Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.2, FlangeThickness: 0.016 }, /WebThickness/],
    [{ Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.2 }, /FlangeThickness/],
    [{ Type: 'CircleHollow', Radius: 0.1, WallThickness: 0.1 }, /WallThickness/],
    [{ Type: 'RectangleHollow', XDim: 0.1, YDim: 0.2, WallThickness: 0.05 }, /WallThickness/],
    [{ Type: 'C', Depth: 0.2, Width: 0.07, WallThickness: 0.003, Girth: 0.15 }, /Girth/],
    [{ Type: 'Circle', Radius: 0 }, /IfcCircleProfileDef\.Radius/],
    [{ Type: 'Circle', Radius: Number.NaN }, /IfcCircleProfileDef\.Radius/],
    [{ Type: 'L', Depth: 0.1, Width: 0.08, Thickness: 0.01, FilletRadius: -1 }, /FilletRadius/],
    [{ Type: 'Hexagon', Radius: 1 }, /unknown section Type/],
  ] as Array<[ProfileSection, RegExp]>)('refuses %j before emitting anything', (section, message) => {
    const { editor, anchor, view } = setup('IFC4');
    expect(() => addBeamToStore(editor, anchor, { Start: [0, 0, 0], End: [1, 0, 0], Profile: section })).toThrow(message);
    expect(view.getNewEntities()).toHaveLength(0);
  });
});

describe('profileSectionExtent', () => {
  it('is each section\'s outer size, [along profile X, along profile Y]', () => {
    expect(SECTIONS.map(([s]) => profileSectionExtent(s))).toEqual([
      [0.3, 0.5], [0.2, 0.4], [0.08, 0.1], [0.12, 0.12], [0.075, 0.2], [0.07, 0.2], [0.3, 0.3], [0.1, 0.2], [0.2, 0.2],
    ]);
  });
});

describe('profiled beam / column / member', () => {
  const I: ProfileSection = { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 };

  it('extrudes the profile along the element axis', () => {
    const { editor, anchor, entity } = setup();
    const beam = addBeamToStore(editor, anchor, { Start: [0, 0, 3], End: [4, 0, 3], Profile: I });
    expect(entity(beam.profileId).type).toBe('IfcIShapeProfileDef');
    expect(entity(beam.solidId).attributes[3]).toBe(4);
    expect(entity(beam.beamId).attributes[8]).toBe('.BEAM.');

    const member = addMemberToStore(editor, anchor, { Start: [0, 0, 0], End: [0, 3, 0], Profile: { Type: 'L', Depth: 0.1, Width: 0.1, Thickness: 0.01 } });
    expect(entity(member.profileId).type).toBe('IfcLShapeProfileDef');
    expect(entity(member.solidId).attributes[0]).toBe(`#${member.profileId}`);

    const column = addColumnToStore(editor, anchor, { Position: [1, 1, 0], Height: 3, Profile: { Type: 'CircleHollow', Radius: 0.1, WallThickness: 0.01 } });
    expect(entity(column.profileId).type).toBe('IfcCircleHollowProfileDef');
    expect(entity(column.solidId).attributes[0]).toBe(`#${column.profileId}`);
    expect(entity(column.solidId).attributes[3]).toBe(3);
  });

  it('keeps the Width x Height rectangle as the default; a Rectangle Profile builds the same graph', () => {
    const a = setup();
    const b = setup();
    const rect = addBeamToStore(a.editor, a.anchor, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.3, Height: 0.5 });
    const viaProfile = addBeamToStore(b.editor, b.anchor, {
      Start: [0, 0, 3], End: [4, 0, 3], Profile: { Type: 'Rectangle', XDim: 0.3, YDim: 0.5 },
    });
    expect(a.entity(rect.profileId).attributes).toEqual(['.AREA.', null, expect.any(String), 0.3, 0.5]);
    expect(b.entity(viaProfile.profileId).attributes.slice(3)).toEqual([real(0.3), real(0.5)]);
    const types = (s: ReturnType<typeof setup>) => s.view.getNewEntities().map((e) => e.type);
    expect(types(a)).toEqual(types(b));
  });

  it('refuses a rectangle and a Profile together, a bad Profile or Height, and IFC5, before emitting', () => {
    const { editor, anchor, view } = setup();
    expect(() => addBeamToStore(editor, anchor, {
      Start: [0, 0, 0], End: [1, 0, 0], Profile: I, Width: 0.3,
    } as unknown as Parameters<typeof addBeamToStore>[2])).toThrow(/either Width and Height or a Profile/);
    expect(() => addColumnToStore(editor, anchor, {
      Position: [0, 0, 0], Height: 3, Profile: I, Depth: 0.3,
    } as unknown as Parameters<typeof addColumnToStore>[2])).toThrow(/either Width and Depth or a Profile/);
    expect(() => addMemberToStore(editor, anchor, {
      Start: [0, 0, 0], End: [1, 0, 0], Profile: { Type: 'Circle', Radius: -1 },
    })).toThrow(/IfcCircleProfileDef\.Radius/);
    expect(() => addColumnToStore(editor, anchor, { Position: [0, 0, 0], Height: 0, Profile: I })).toThrow(/Height must be a finite positive number/);
    expect(() => addBeamToStore(editor, { ...anchor, schema: 'IFC5' }, { Start: [0, 0, 0], End: [1, 0, 0], Profile: I })).toThrow(/IFC5/);
    expect(view.getNewEntities()).toHaveLength(0);
  });
});
