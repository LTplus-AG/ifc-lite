/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8306: when an entity had property sets but none matched the facet's
 * `propertySet`, the checker put the literal key `'propertySet'` in
 * `failure.field`, and both formatters (`describeFailure`,
 * `formatFailureReason`) read `field || expected`, so every message said
 * `Property set "propertySet" not found` instead of naming the required
 * set. This pins the required name / constraint in both failure branches
 * and keeps the available-sets list.
 */

import { describe, it, expect } from 'vitest';
import { checkPropertyFacet } from '../facets/property-facet.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import { formatFailureReason } from '../validation/format-failure-reason.js';
import { createTranslationService } from './index.js';
import type { IDSConstraint, IDSPropertyFacet, IDSRequirementResult } from '../types.js';

const accessor = createMockAccessor([
  {
    expressId: 1,
    type: 'IfcWall',
    properties: [
      { psetName: 'Pset_WallCommon', propName: 'IsExternal', value: true, dataType: 'IFCBOOLEAN' },
      { psetName: 'Pset_EnvironmentalImpactIndicators', propName: 'Reference', value: 'X', dataType: 'IFCLABEL' },
    ],
  },
  { expressId: 2, type: 'IfcWall' },
]);

const facetFor = (propertySet: IDSConstraint): IDSPropertyFacet => ({
  type: 'property',
  propertySet,
  baseName: { type: 'simpleValue', value: 'IsExternal' },
});

const cases: Array<{ label: string; constraint: IDSConstraint; shown: string }> = [
  { label: 'simple value', constraint: { type: 'simpleValue', value: 'Pset_RequiredExample' }, shown: 'Pset_RequiredExample' },
  { label: 'pattern', constraint: { type: 'pattern', pattern: 'Pset_Required.*' }, shown: 'pattern "Pset_Required.*"' },
  {
    label: 'enumeration',
    constraint: { type: 'enumeration', values: ['Pset_A', 'Pset_B'] },
    shown: 'one of ["Pset_A", "Pset_B"]',
  },
];

function messages(expressId: number, constraint: IDSConstraint) {
  const result = checkPropertyFacet(facetFor(constraint), expressId, accessor);
  expect(result.failure?.type).toBe('PSET_MISSING');
  const translated = createTranslationService('en').describeFailure({
    failure: result.failure,
  } as unknown as IDSRequirementResult);
  return { translated, reason: formatFailureReason(result) };
}

describe('PSET_MISSING names the required property set (#8306)', () => {
  for (const { label, constraint, shown } of cases) {
    it(`entity with non-matching sets: ${label}`, () => {
      const { translated, reason } = messages(1, constraint);
      for (const message of [translated, reason]) {
        expect(message).toContain(shown);
        expect(message).not.toContain('"propertySet"');
      }
      expect(translated).toContain('Available: Pset_WallCommon, Pset_EnvironmentalImpactIndicators');
    });

    it(`entity with no sets: ${label}`, () => {
      const { translated, reason } = messages(2, constraint);
      for (const message of [translated, reason]) {
        expect(message).toContain(shown);
        expect(message).not.toContain('"propertySet"');
      }
      expect(translated).not.toContain('Available');
    });
  }
});
