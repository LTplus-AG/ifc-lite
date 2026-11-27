/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as ifc4 from '../src/generated/ifc4/zod.js';

const wall = {
  GlobalId: '2xxxxxxxxxxxxxxxxxxxx8',
  OwnerHistory: { ref: 5 },
  Name: 'Wall A',
  ObjectPlacement: { ref: 30 },
  Representation: { ref: 41 },
  PredefinedType: 'STANDARD',
};

const messages = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  result.error?.issues.map((i) => i.message) ?? [];

describe('generated zod schemas (IFC4 authoring form)', () => {
  it('accepts a well-formed wall', () => {
    expect(ifc4.IfcWall.safeParse(wall).success).toBe(true);
  });

  it('refines with WHERE rules decidable from the entity itself', () => {
    const result = ifc4.IfcWall.safeParse({ ...wall, PredefinedType: 'USERDEFINED' });
    expect(result.success).toBe(false);
    expect(messages(result).some((m) => m.startsWith('IfcWall.CorrectPredefinedType'))).toBe(true);
    expect(ifc4.IfcWall.safeParse({ ...wall, PredefinedType: 'USERDEFINED', ObjectType: 'Curtain' }).success).toBe(true);
  });

  it('applies defined-type WHERE rules to attribute values', () => {
    const profile = { ProfileType: 'AREA', XDim: 5, YDim: 0 };
    const result = ifc4.IfcRectangleProfileDef.safeParse(profile);
    expect(messages(result).some((m) => m.startsWith('IfcPositiveLengthMeasure.WR1'))).toBe(true);
    expect(ifc4.IfcRectangleProfileDef.safeParse({ ...profile, YDim: 0.2 }).success).toBe(true);
  });

  it('rejects unknown attributes, missing mandatory ones and wrong enumeration items', () => {
    expect(ifc4.IfcWall.safeParse({ ...wall, Height: 3 }).success).toBe(false);
    expect(ifc4.IfcWall.safeParse({ ...wall, GlobalId: undefined }).success).toBe(false);
    expect(ifc4.IfcWall.safeParse({ ...wall, PredefinedType: 'CURVED' }).success).toBe(false);
    expect(ifc4.IfcWall.safeParse({ ...wall, GlobalId: 'short' }).success).toBe(false);
  });

  it('takes SELECT values of defined types in the typed form only', () => {
    const property = { Name: 'FireRating', NominalValue: { typed: { type: 'IfcLabel', value: 'REI90' } } };
    expect(ifc4.IfcPropertySingleValue.safeParse(property).success).toBe(true);
    expect(ifc4.IfcPropertySingleValue.safeParse({ ...property, NominalValue: 'REI90' }).success).toBe(false);
    expect(ifc4.IfcPropertySingleValue.safeParse({ ...property, NominalValue: { typed: { type: 'IfcPositiveLengthMeasure', value: -1 } } }).success).toBe(false);
  });

  it('enforces aggregate bounds', () => {
    expect(ifc4.IfcCartesianPoint.safeParse({ Coordinates: [0, 0, 0] }).success).toBe(true);
    expect(ifc4.IfcCartesianPoint.safeParse({ Coordinates: [0, 0, 0, 0] }).success).toBe(false);
  });
});
