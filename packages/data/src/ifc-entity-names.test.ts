/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IFC_ENTITY_NAMES } from './ifc-entity-names.js';
import { IfcTypeEnum, IfcTypeEnumToString } from './types.js';

describe('IFC_ENTITY_NAMES', () => {
  // These four were confirmed missing (issue tracked in PR #2318, which
  // works around the gap in the parquet export layer rather than fixing
  // it at source). All four ARE representable in IfcTypeEnum /
  // IfcTypeEnumToString, so leaving them out of this table is a genuine
  // asymmetry: any direct `IFC_ENTITY_NAMES[upper] ?? upper` lookup (used
  // by packages/mcp's query/diff/validation/discovery tools and
  // packages/cli's info/diff commands) silently displays the raw
  // UPPERCASE STEP keyword instead of the PascalCase entity name for
  // these types.
  it('covers IfcProxy', () => {
    expect(IFC_ENTITY_NAMES['IFCPROXY']).toBe('IfcProxy');
  });

  it('covers IfcSolidStratum', () => {
    expect(IFC_ENTITY_NAMES['IFCSOLIDSTRATUM']).toBe('IfcSolidStratum');
  });

  it('covers IfcVoidStratum', () => {
    expect(IFC_ENTITY_NAMES['IFCVOIDSTRATUM']).toBe('IfcVoidStratum');
  });

  it('covers IfcWaterStratum', () => {
    expect(IFC_ENTITY_NAMES['IFCWATERSTRATUM']).toBe('IfcWaterStratum');
  });

  /**
   * Completeness control: every non-Unknown IfcTypeEnum member that has a
   * known PascalCase spelling via IfcTypeEnumToString must also be
   * reachable from IFC_ENTITY_NAMES under its UPPERCASE STEP keyword.
   * This is the general shape of the four bugs above — it fails loudly if
   * a future codegen run drops entries again, instead of relying on
   * someone noticing four missing dictionary keys by eye.
   */
  it('has an entry for every representable IfcTypeEnum member', () => {
    const missing: string[] = [];
    for (const key of Object.keys(IfcTypeEnum)) {
      if (/^\d+$/.test(key) || key === 'Unknown') continue; // numeric reverse-map keys
      const enumValue = (IfcTypeEnum as unknown as Record<string, number>)[key];
      const pascal = IfcTypeEnumToString(enumValue);
      if (pascal === 'Unknown') continue; // not representable either direction
      const upper = key.toUpperCase();
      if (IFC_ENTITY_NAMES[upper] !== pascal) {
        missing.push(`${upper} -> expected ${pascal}, got ${IFC_ENTITY_NAMES[upper]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
