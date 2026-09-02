/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { expandTypeNamesToDescendants } from './descendants.js';

describe('expandTypeNamesToDescendants', () => {
  it('IFC4 IfcWall includes itself and IfcWallStandardCase, excludes unrelated types', () => {
    const result = expandTypeNamesToDescendants(['IfcWall'], 'IFC4');
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCWALLSTANDARDCASE');
    expect(result).not.toContain('IFCDOOR');
  });

  it('IFC4 IfcBuildingElement includes many concrete subtypes, excludes non-elements', () => {
    const result = expandTypeNamesToDescendants(['IfcBuildingElement'], 'IFC4');
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCSLAB');
    expect(result).toContain('IFCCOLUMN');
    expect(result).not.toContain('IFCSPACE');
    expect(result).not.toContain('IFCPROJECT');
  });

  it('IFC4X3 IfcBuiltElement resolves per that schema (IfcBuildingElement was renamed)', () => {
    const result = expandTypeNamesToDescendants(['IfcBuiltElement'], 'IFC4X3');
    expect(result).toContain('IFCBUILTELEMENT');
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCCOURSE');
    expect(result).not.toContain('IFCSPACE');
  });

  it('an unrecognized type on a schema still falls back to itself, no crash', () => {
    const result = expandTypeNamesToDescendants(['IfcTotallyMadeUpType'], 'IFC4');
    expect(result).toEqual(['IFCTOTALLYMADEUPTYPE']);
  });

  it('is case-insensitive on input and uppercases output', () => {
    const result = expandTypeNamesToDescendants(['ifcwall'], 'IFC4');
    expect(result).toContain('IFCWALL');
  });

  it('deduplicates across multiple requested types', () => {
    const result = expandTypeNamesToDescendants(['IfcWall', 'IfcWallStandardCase'], 'IFC4');
    const count = result.filter((t) => t === 'IFCWALLSTANDARDCASE').length;
    expect(count).toBe(1);
  });

  it('falls back to IFC4 for an unrecognized schema version', () => {
    const result = expandTypeNamesToDescendants(['IfcWall'], 'IFC5');
    expect(result).toContain('IFCWALLSTANDARDCASE');
  });

  it('falls back to IFC4 for an undefined schema version', () => {
    const result = expandTypeNamesToDescendants(['IfcWall'], undefined);
    expect(result).toContain('IFCWALLSTANDARDCASE');
  });
});
