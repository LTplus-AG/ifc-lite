/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ATTRIBUTE_NAMES_BY_SCHEMA.IFC4` (`subset-entity-reader.ts`) used to read
 * `@ifc-lite/data`'s `ENTITIES_IFC4` directly. That table (issue #5204,
 * vendored from buildingSMART's C# `SchemaInfo` source) gives
 * `IfcCartesianPointList2D`/`3D` a `TagList` attribute IFC4 has never had,
 * and misfiles 24 draft-alignment-extension entities as IFC4-valid — none of
 * which can appear in a real IFC4 STEP file, so `attrIndex(type, name,
 * 'IFC4')` resolving a positional slot for one of them was always a wrong
 * answer for an actual IFC4 source model.
 */

import { describe, it, expect } from 'vitest';
import { attrIndex } from './subset-entity-reader.js';

describe('attrIndex against the IFC4 STEP table (#5204)', () => {
  it('does not resolve TagList as a slot on IfcCartesianPointList3D in IFC4', () => {
    expect(attrIndex('IfcCartesianPointList3D', 'TagList', 'IFC4')).toBe(-1);
    expect(attrIndex('IfcCartesianPointList3D', 'CoordList', 'IFC4')).toBe(0);
  });

  it('does not resolve any slot for a phantom draft-alignment entity in IFC4', () => {
    expect(attrIndex('IfcAlignment2DHorizontal', 'StartDistAlong', 'IFC4')).toBe(-1);
  });

  it('still resolves an ordinary IFC4 entity attribute correctly (no regression)', () => {
    expect(attrIndex('IfcWall', 'Name', 'IFC4')).toBe(2);
    expect(attrIndex('IfcWall', 'GlobalId', 'IFC4')).toBe(0);
  });

  it('leaves IFC2X3 and IFC4X3 resolution untouched', () => {
    // IFC2X3's IfcWall has no `PredefinedType` slot IFC4 added — a
    // regression here would mean the filter leaked into the wrong table.
    expect(attrIndex('IfcWall', 'Tag', 'IFC2X3')).toBe(7);
  });
});
