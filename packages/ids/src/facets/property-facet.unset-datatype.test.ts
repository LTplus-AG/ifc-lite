/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { checkPropertyFacet, propertyFacetPasses } from './property-facet.js';
import type {
  IFCDataAccessor,
  IDSPropertyFacet,
  IDSSimpleValue,
  PropertySetInfo,
} from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

/**
 * A minimal accessor built by hand rather than `createMockAccessor`
 * (./test-helpers.js). That helper defaults EVERY property's dataType to
 * `prop.dataType || 'IFCLABEL'` (`getPropertySets`, line ~113), so a test
 * routed through it can never produce a falsy `dataType` and can never
 * reach the ifc-lite #5224 gate at property-facet.ts:101/363 — the bug
 * would pass under that helper regardless of whether the fix is applied.
 * This accessor returns exactly the `PropertySetInfo` given, undoctored.
 */
function accessorFor(psets: PropertySetInfo[]): IFCDataAccessor {
  return {
    getEntityType: () => 'IfcWall',
    getEntityName: () => undefined,
    getGlobalId: () => undefined,
    getDescription: () => undefined,
    getObjectType: () => undefined,
    getEntitiesByType: () => [],
    getAllEntityIds: () => [1],
    getPropertyValue: () => undefined,
    getPropertySets: () => psets,
    getClassifications: () => [],
    getMaterials: () => [],
    getParent: () => undefined,
    getAttribute: () => undefined,
  };
}

describe('property facet dataType gate with an unrecorded dataType (#5224)', () => {
  // Pin: a genuinely spec-legal case — `IfcPropertyTableValue` (and any
  // other multi-valued property) deliberately carries no single
  // representative `dataType` (packages/parser/src/property-value-parser.ts
  // leaves it unset; packages/ids/src/bridge/properties.ts:329 projects
  // that through as `dataType: undefined`). The dataType gate must keep
  // falling through to a pure value match for this shape — this is the
  // behaviour the harder half of #5224 must NOT break.
  it('an IfcPropertyTableValue-shaped property (no dataType, multi-value candidates) still passes a dataType-constrained facet when one candidate value matches', () => {
    const psets: PropertySetInfo[] = [
      {
        name: 'Pset_Foo',
        properties: [
          {
            name: 'MixedTable',
            value: 'Table (2 rows)',
            dataType: undefined,
            values: ['true', '42'],
          },
        ],
      },
    ];
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_Foo'),
      baseName: sv('MixedTable'),
      dataType: sv('IFCBOOLEAN'),
      value: sv('true'),
    };

    expect(checkPropertyFacet(facet, 1, accessorFor(psets)).passed).toBe(true);
    expect(propertyFacetPasses(facet, 1, accessorFor(psets))).toBe(true);
  });

  // Documents the exact defect ifc-lite #5224 reports: with no
  // `facet.value` to fall back on, an unrecorded dataType is currently
  // indistinguishable from a deliberately-omitted one, so a facet
  // requiring IFCBOOLEAN reports PASS against a value that was never
  // checked against any type. Not a regression from this change — the
  // property-facet.ts gate itself is intentionally NOT changed here (see
  // the accompanying report: no flag/sentinel exists at the gate to tell
  // "genuinely unknowable" apart from "nobody recorded a type"). This
  // test documents current, unchanged behaviour so a future change to
  // the gate has to consciously touch this assertion.
  it('CURRENT BEHAVIOUR (undesirable, not fixed by this change): an existence-only-reachable property with no dataType and no facet.value skips the dataType requirement entirely', () => {
    const psets: PropertySetInfo[] = [
      {
        name: 'Pset_Foo',
        properties: [
          { name: 'IsExternal', value: 'not-a-boolean-at-all', dataType: undefined },
        ],
      },
    ];
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_Foo'),
      baseName: sv('IsExternal'),
      dataType: sv('IFCBOOLEAN'),
    };

    expect(checkPropertyFacet(facet, 1, accessorFor(psets)).passed).toBe(true);
    expect(propertyFacetPasses(facet, 1, accessorFor(psets))).toBe(true);
  });

  // Control: the same mismatch, but with a present (wrong) dataType —
  // correctly fails. Confirms the gate itself works when it has a type to
  // compare against; it's the falsy-skip in the guard that's the problem.
  it('control: the same value mismatch WITH a recorded (wrong) dataType correctly fails', () => {
    const psets: PropertySetInfo[] = [
      {
        name: 'Pset_Foo',
        properties: [
          { name: 'IsExternal', value: 'not-a-boolean-at-all', dataType: 'IFCLABEL' },
        ],
      },
    ];
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: sv('Pset_Foo'),
      baseName: sv('IsExternal'),
      dataType: sv('IFCBOOLEAN'),
    };

    const result = checkPropertyFacet(facet, 1, accessorFor(psets));
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_DATATYPE_MISMATCH');
    expect(propertyFacetPasses(facet, 1, accessorFor(psets))).toBe(false);
  });
});
