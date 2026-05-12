/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification facet checker
 */

import type { IDSClassificationFacet, IFCDataAccessor } from '../types.js';
import type { FacetCheckResult } from './index.js';
import { matchConstraint, formatConstraint } from '../constraints/index.js';

/**
 * Check if an entity matches a classification facet
 */
export function checkClassificationFacet(
  facet: IDSClassificationFacet,
  expressId: number,
  accessor: IFCDataAccessor
): FacetCheckResult {
  // Get classifications for the entity
  const classifications = accessor.getClassifications(expressId);
  const hasAnyClassifications = classifications.length > 0;

  // If no value or system constraint, just check if any classification exists
  if (!facet.system && !facet.value) {
    if (!hasAnyClassifications) {
      return {
        passed: false,
        actualValue: '(none)',
        expectedValue: 'any classification',
        failure: {
          type: 'CLASSIFICATION_MISSING',
          expected: 'any classification',
        },
      };
    }

    return {
      passed: true,
      actualValue: classifications
        .map((c) => `${c.system}:${c.value}`)
        .join(', '),
      expectedValue: 'any classification',
    };
  }

  // If entity has no classifications at all, return CLASSIFICATION_MISSING
  // (not SYSTEM_MISMATCH or VALUE_MISMATCH — those imply we found _some_ classifications)
  if (!hasAnyClassifications) {
    const expected = facet.system && facet.value
      ? `${formatConstraint(facet.system)}:${formatConstraint(facet.value)}`
      : facet.system
        ? formatConstraint(facet.system)
        : formatConstraint(facet.value!);

    return {
      passed: false,
      actualValue: '(none)',
      expectedValue: expected,
      failure: {
        type: 'CLASSIFICATION_MISSING',
        expected,
      },
    };
  }

  // Filter by system if specified
  let matchingClassifications = classifications;
  if (facet.system) {
    matchingClassifications = classifications.filter((c) =>
      matchConstraint(facet.system!, c.system)
    );

    if (matchingClassifications.length === 0) {
      const availableSystems = [
        ...new Set(classifications.map((c) => c.system)),
      ].join(', ');

      return {
        passed: false,
        actualValue: availableSystems,
        expectedValue: formatConstraint(facet.system),
        failure: {
          type: 'CLASSIFICATION_SYSTEM_MISMATCH',
          field: 'system',
          actual: availableSystems,
          expected: formatConstraint(facet.system),
          context: {
            availableSystems,
          },
        },
      };
    }
  }

  // Check value if specified
  if (facet.value) {
    const matchingValues = matchingClassifications.filter((c) =>
      matchConstraint(facet.value!, c.value)
    );

    if (matchingValues.length === 0) {
      const availableValues = matchingClassifications
        .map((c) => c.value)
        .join(', ');

      return {
        passed: false,
        actualValue: availableValues || '(none)',
        expectedValue: formatConstraint(facet.value),
        failure: {
          type: 'CLASSIFICATION_VALUE_MISMATCH',
          field: 'value',
          actual: availableValues,
          expected: formatConstraint(facet.value),
          context: {
            system: facet.system ? formatConstraint(facet.system) : 'any',
            availableValues,
          },
        },
      };
    }

    return {
      passed: true,
      actualValue: matchingValues
        .map((c) => `${c.system}:${c.value}`)
        .join(', '),
      expectedValue: facet.system
        ? `${formatConstraint(facet.system)}:${formatConstraint(facet.value)}`
        : formatConstraint(facet.value),
    };
  }

  // System matched, no value constraint
  return {
    passed: true,
    actualValue: matchingClassifications
      .map((c) => `${c.system}:${c.value}`)
      .join(', '),
    expectedValue: formatConstraint(facet.system!),
  };
}
