/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity facet checker
 */

import type {
  IDSEntityFacet,
  IDSConstraint,
  IFCDataAccessor,
} from '../types.js';
import type { FacetCheckResult } from './index.js';
import { matchConstraint, formatConstraint } from '../constraints/index.js';

/** IFC entity/predefined type comparisons are case-insensitive per IDS spec */
const IFC_CASE_INSENSITIVE = { caseInsensitive: true } as const;

/**
 * Check if an entity matches an entity facet
 */
export function checkEntityFacet(
  facet: IDSEntityFacet,
  expressId: number,
  accessor: IFCDataAccessor
): FacetCheckResult {
  const entityType = accessor.getEntityType(expressId);

  if (!entityType) {
    return {
      passed: false,
      actualValue: undefined,
      expectedValue: formatConstraint(facet.name),
      failure: {
        type: 'ENTITY_TYPE_MISMATCH',
        field: 'entityType',
        actual: 'unknown',
        expected: formatConstraint(facet.name),
      },
    };
  }

  // Check entity type (case-insensitive per IDS spec — IFC entity names are case-agnostic)
  if (!matchConstraint(facet.name, entityType, IFC_CASE_INSENSITIVE)) {
    return {
      passed: false,
      actualValue: entityType,
      expectedValue: formatConstraint(facet.name),
      failure: {
        type: 'ENTITY_TYPE_MISMATCH',
        field: 'entityType',
        actual: entityType,
        expected: formatConstraint(facet.name),
      },
    };
  }

  // Check predefined type if specified
  if (facet.predefinedType) {
    // Per IDS spec, predefined-type matching has two distinct paths:
    //   1. Compare against the raw IFC `PredefinedType` enum token
    //      (BEAM, USERDEFINED, NOTDEFINED, …) — case-insensitive.
    //   2. When the raw token is `USERDEFINED`, fall back to the
    //      user-defined name (`ObjectType`/`ElementType`/`ProcessType`)
    //      — case-sensitive.
    // The order matters: a fixture asking for `USERDEFINED` literally
    // must match an entity whose enum is `USERDEFINED` regardless of
    // its accompanying user-defined name.
    const rawType = accessor.getPredefinedTypeRaw?.(expressId);
    const userDefinedType = accessor.getObjectType(expressId);

    if (!rawType && !userDefinedType) {
      return {
        passed: false,
        actualValue: entityType,
        expectedValue: `${formatConstraint(facet.name)} with predefinedType ${formatConstraint(facet.predefinedType)}`,
        failure: {
          type: 'PREDEFINED_TYPE_MISSING',
          field: 'predefinedType',
          expected: formatConstraint(facet.predefinedType),
        },
      };
    }

    let matched = false;
    if (rawType && matchConstraint(facet.predefinedType, rawType, IFC_CASE_INSENSITIVE)) {
      matched = true;
    } else if (
      rawType === 'USERDEFINED' &&
      userDefinedType &&
      userDefinedType !== rawType &&
      matchConstraint(facet.predefinedType, userDefinedType)
    ) {
      // Case-sensitive comparison for user-defined names.
      matched = true;
    } else if (
      !rawType &&
      userDefinedType &&
      matchConstraint(facet.predefinedType, userDefinedType, IFC_CASE_INSENSITIVE)
    ) {
      // No raw enum reported (legacy accessor) — fall back to the
      // substituted form with case-insensitive comparison.
      matched = true;
    }

    if (!matched) {
      const display = userDefinedType || rawType || '(none)';
      return {
        passed: false,
        actualValue: `${entityType}[${display}]`,
        expectedValue: `${formatConstraint(facet.name)} with predefinedType ${formatConstraint(facet.predefinedType)}`,
        failure: {
          type: 'PREDEFINED_TYPE_MISMATCH',
          field: 'predefinedType',
          actual: display,
          expected: formatConstraint(facet.predefinedType),
        },
      };
    }
  }

  return {
    passed: true,
    actualValue: facet.predefinedType
      ? `${entityType}[${accessor.getObjectType(expressId) || ''}]`
      : entityType,
    expectedValue: formatConstraint(facet.name),
  };
}

/**
 * Get candidate entity IDs that might match an entity facet (broadphase filter)
 */
export function filterByEntityFacet(
  facet: IDSEntityFacet,
  accessor: IFCDataAccessor
): number[] | undefined {
  const constraint = facet.name;

  // For simple values, we can efficiently filter by type
  if (constraint.type === 'simpleValue') {
    return accessor.getEntitiesByType(constraint.value);
  }

  // For enumerations, collect entities of all specified types
  if (constraint.type === 'enumeration') {
    const ids: number[] = [];
    for (const value of constraint.values) {
      ids.push(...accessor.getEntitiesByType(value));
    }
    return ids;
  }

  // For patterns, we need to check all entity types
  // Return undefined to indicate full scan needed
  return undefined;
}

/**
 * Get all entity types that could match a constraint
 */
export function getMatchingEntityTypes(
  constraint: IDSConstraint,
  allTypes: string[]
): string[] {
  switch (constraint.type) {
    case 'simpleValue':
      return allTypes.filter(
        (t) => t.toUpperCase() === constraint.value.toUpperCase()
      );
    case 'enumeration':
      return allTypes.filter((t) =>
        constraint.values.some(
          (v) => v.toUpperCase() === t.toUpperCase()
        )
      );
    case 'pattern':
      try {
        const regex = new RegExp(`^${constraint.pattern}$`, 'i');
        return allTypes.filter((t) => regex.test(t));
      } catch {
        return [];
      }
    default:
      return allTypes;
  }
}
