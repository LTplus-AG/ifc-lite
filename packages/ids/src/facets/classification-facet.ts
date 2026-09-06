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

  // Only entries whose attributes were actually readable can be matched
  // against a system/value constraint. An `unresolved` entry (confirmed
  // classified, but this store has no source bytes to read system/value/name
  // from — issue #3948) carries `system: ''`/`value: ''`, which is NOT a
  // genuine empty classification: matching it would either silently PASS a
  // required facet that should have failed, or silently FAIL/mismatch one
  // that would have matched had the data been readable. Match against the
  // resolved subset only, and report CLASSIFICATION_UNRESOLVED — distinct
  // from MISSING (genuinely unclassified) and from a MISMATCH (we read a
  // value and it didn't match) — whenever an unresolved entry could have
  // been the reason no resolved entry matched.
  const resolvedClassifications = classifications.filter((c) => !c.unresolved);
  const hasUnresolved = resolvedClassifications.length < classifications.length;

  // Filter by system if specified
  let matchingClassifications = resolvedClassifications;
  if (facet.system) {
    matchingClassifications = resolvedClassifications.filter((c) =>
      matchConstraint(facet.system!, c.system)
    );

    if (matchingClassifications.length === 0) {
      if (hasUnresolved) {
        return unresolvedResult(facet, 'system');
      }

      const availableSystems = [
        ...new Set(resolvedClassifications.map((c) => c.system)),
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
      if (hasUnresolved) {
        return unresolvedResult(facet, 'value');
      }

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

/**
 * Result for a system/value-constrained facet when the entity is confirmed
 * classified but no *readable* classification matched, and at least one
 * *unreadable* one exists that might have. `passed: false` is the closest
 * this engine's boolean result can get to "could not determine" — the
 * distinguishing signal is `failure.type` (`CLASSIFICATION_UNRESOLVED`,
 * never `_MISSING`/`_MISMATCH`), so a report can tell "cannot verify" apart
 * from a genuine violation instead of treating both as the same failure.
 */
function unresolvedResult(
  facet: IDSClassificationFacet,
  field: 'system' | 'value'
): FacetCheckResult {
  const expected = facet.system && facet.value
    ? `${formatConstraint(facet.system)}:${formatConstraint(facet.value)}`
    : facet.system
      ? formatConstraint(facet.system)
      : formatConstraint(facet.value!);

  return {
    passed: false,
    actualValue: '(unresolved)',
    expectedValue: expected,
    failure: {
      type: 'CLASSIFICATION_UNRESOLVED',
      field,
      expected,
      context: {
        reason:
          'Entity is classified, but the classification attributes are unavailable on this data source (server-parsed model without source bytes).',
      },
    },
  };
}
