/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getAttributeNamesForSchema` / `getAttributeTypeForSchema` accept a schema
 * as a store's family (`IFC4X3`) or as the FILE_SCHEMA identifier a file
 * carries (`IFC4X3_ADD2`). The identifier used to be stripped to `IFC4X3ADD2`,
 * which matched no family, so it silently got the IFC4 answer.
 */

import { describe, it, expect } from 'vitest';
import { getAttributeNamesForSchema, getAttributeTypeForSchema } from './ifc-schema.js';

describe('per-schema attribute lookups accept FILE_SCHEMA identifiers', () => {
  it.each(['IFC4X3', 'IFC4X3_ADD2', 'IFC4X3_ADD1', 'ifc4x3_add2'])('%s resolves to the IFC4X3 layout', schema => {
    // IfcPropertySingleValue's second attribute is Specification in IFC4X3, Description in IFC4.
    expect(getAttributeNamesForSchema('IfcPropertySingleValue', schema)[1]).toBe('Specification');
    expect(getAttributeTypeForSchema('IfcPropertySingleValue', 'Specification', schema)).toBeDefined();
  });

  it.each(['IFC4', 'IFC4_ADD2', 'IFC4_ADD2_TC1'])('%s resolves to the IFC4 layout', schema => {
    expect(getAttributeNamesForSchema('IfcPropertySingleValue', schema)[1]).toBe('Description');
  });

  it.each(['IFC2X3', 'IFC2X3_TC1'])('%s resolves to the IFC2X3 layout', schema => {
    // IfcWall has no PredefinedType in IFC2X3.
    expect(getAttributeNamesForSchema('IfcWall', schema)).not.toContain('PredefinedType');
  });

  it('unknown or missing schemas keep the bundled-union fallback', () => {
    expect(getAttributeNamesForSchema('IfcWall', undefined)).toContain('GlobalId');
    expect(getAttributeNamesForSchema('IfcWall', 'IFC5')).toContain('GlobalId');
  });
});
