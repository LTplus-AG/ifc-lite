/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Material facet checker
 */

import type { IDSMaterialFacet, IFCDataAccessor } from '../types.js';
import type { FacetCheckResult } from './index.js';
import { matchConstraint, formatConstraint } from '../constraints/index.js';

/**
 * Check if an entity matches a material facet
 */
export function checkMaterialFacet(
  facet: IDSMaterialFacet,
  expressId: number,
  accessor: IFCDataAccessor
): FacetCheckResult {
  // Get materials for the entity
  const materials = accessor.getMaterials(expressId);

  // An `unresolved` entry (#5227) is a real IfcRelAssociatesMaterial edge
  // whose material this store cannot read (server-parsed, no source
  // bytes). It PROVES the entity has a material, so it satisfies a
  // presence-only facet, but it can neither match nor fail a value. This is
  // the same contract as the classification facet's `unresolved` (#3948).
  const resolvedMaterials = materials.filter((m) => !m.unresolved);
  const hasUnresolved = resolvedMaterials.length < materials.length;

  // If no value constraint, just check if any material exists
  if (!facet.value) {
    if (materials.length === 0) {
      return {
        passed: false,
        actualValue: '(none)',
        expectedValue: 'any material',
        failure: {
          type: 'MATERIAL_MISSING',
          expected: 'any material',
        },
      };
    }

    return {
      passed: true,
      actualValue: materials.map((m) => m.name ?? '(unresolved)').join(', '),
      expectedValue: 'any material',
    };
  }

  // Check if any readable material matches the value constraint
  const matchingMaterials = resolvedMaterials.filter(
    (m) =>
      matchConstraint(facet.value!, m.name) ||
      (m.category && matchConstraint(facet.value!, m.category))
  );

  if (matchingMaterials.length === 0) {
    if (materials.length === 0) {
      return {
        passed: false,
        actualValue: '(none)',
        expectedValue: formatConstraint(facet.value),
        failure: {
          type: 'MATERIAL_MISSING',
          expected: formatConstraint(facet.value),
        },
      };
    }

    // An unreadable material might be the one that matches: we cannot say
    // it doesn't, so this is not a MISMATCH. The validator fails it even
    // under a prohibition, so "cannot verify" is never a pass.
    if (hasUnresolved) {
      return unresolvedResult(facet);
    }

    const availableMaterials = resolvedMaterials.map((m) => m.name).join(', ');

    return {
      passed: false,
      actualValue: availableMaterials,
      expectedValue: formatConstraint(facet.value),
      failure: {
        type: 'MATERIAL_VALUE_MISMATCH',
        field: 'material',
        actual: availableMaterials,
        expected: formatConstraint(facet.value),
        context: {
          availableMaterials,
        },
      },
    };
  }

  return {
    passed: true,
    actualValue: matchingMaterials.map((m) => m.name).join(', '),
    expectedValue: formatConstraint(facet.value),
  };
}

/**
 * Result for a value-constrained facet when the entity has a material this
 * data source cannot read, and no readable material matched. `passed:
 * false` is the closest the boolean result gets to "could not determine";
 * `failure.type` `MATERIAL_UNRESOLVED` (never `_MISSING`/`_MISMATCH`) is
 * what tells a report "cannot verify" apart from a genuine violation.
 */
function unresolvedResult(facet: IDSMaterialFacet): FacetCheckResult {
  const expected = formatConstraint(facet.value!);
  return {
    passed: false,
    actualValue: '(unresolved)',
    expectedValue: expected,
    failure: {
      type: 'MATERIAL_UNRESOLVED',
      expected,
      context: {
        reason:
          'Entity has a material association, but the material attributes are unavailable on this data source (server-parsed model without source bytes).',
      },
    },
  };
}
