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
import { IFC2X3_MAPPED_ALIASES, rowsForOccurrence } from './ifc2x3-type-mapping.js';

/** IFC entity/predefined type comparisons are case-insensitive per IDS spec */
const IFC_CASE_INSENSITIVE = { caseInsensitive: true } as const;

/**
 * Does `facet.name` match this entity through buildingSMART's IFC2X3
 * occurrence/type mapping table, when a direct type-name comparison
 * already failed?
 *
 * "The following table lists all special cases for checking IFC2X3
 * models['] identification of model subsets is further restricted by
 * the type object." — an IDS facet naming an IFC4-only class
 * (`IfcAirTerminal`) must still match the IFC2X3 (occurrence, type)
 * pair that represents it (`IfcFlowTerminal` typed by
 * `IfcAirTerminalType`).
 * https://github.com/buildingSMART/IDS/blob/master/Documentation/ImplementersDocumentation/ifc2x3-occurrence-type-mapping-table.md
 *
 * Scoped to IFC2X3: IFC4+ already has a dedicated class for every alias
 * in the table, so this must not also fire there.
 */
function matchesIfc2x3Mapping(
  facet: IDSEntityFacet,
  entityType: string,
  expressId: number,
  accessor: IFCDataAccessor
): boolean {
  if ((accessor.getSchemaVersion?.() || '').toUpperCase() !== 'IFC2X3') return false;
  const rows = rowsForOccurrence(entityType.toUpperCase());
  if (rows.length === 0) return false;
  const typeEntityType = accessor.getTypeEntityType?.(expressId);
  if (!typeEntityType) return false;
  const typeEntityUpper = typeEntityType.toUpperCase();
  for (const row of rows) {
    if (row.typeEntity !== typeEntityUpper) continue;
    if (matchConstraint(facet.name, row.alias, IFC_CASE_INSENSITIVE)) return true;
  }
  return false;
}

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

  // Per IDS 1.0 spec, entity-name simpleValue literals MUST be
  // uppercase (`IFCWALL`, not `IfcWall`). Reject malformed authoring
  // outright before attempting the case-insensitive comparison —
  // otherwise mixed-case literals would silently match.
  if (
    facet.name.type === 'simpleValue' &&
    facet.name.value !== facet.name.value.toUpperCase()
  ) {
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

  // Check entity type (case-insensitive per IDS spec — IFC entity names are case-agnostic)
  if (
    !matchConstraint(facet.name, entityType, IFC_CASE_INSENSITIVE) &&
    !matchesIfc2x3Mapping(facet, entityType, expressId, accessor)
  ) {
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
    // Predefined-type enum tokens (BEAM, USERDEFINED, …) MUST be
    // uppercase per the IFC schema, and the IDS literal MUST match
    // exactly. Case-sensitive comparison is the spec.
    if (rawType && matchConstraint(facet.predefinedType, rawType)) {
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
      matchConstraint(facet.predefinedType, userDefinedType)
    ) {
      // No raw enum reported (legacy accessor) — case-sensitive match
      // against the substituted form.
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
 * Diagnostics-free verdict for an entity facet — the exact `passed`
 * boolean `checkEntityFacet` would compute, without allocating failure
 * objects or display strings. Applicability filtering runs this against
 * every candidate entity for every specification and reads ONLY the
 * boolean, so the diagnostic work was pure waste (~86% of validation
 * time on code-list IDS packs).
 *
 * Any semantic change to `checkEntityFacet` MUST be mirrored here; the
 * differential test in validation-scale.test.ts pins the equivalence.
 */
export function entityFacetPasses(
  facet: IDSEntityFacet,
  expressId: number,
  accessor: IFCDataAccessor
): boolean {
  const entityType = accessor.getEntityType(expressId);
  if (!entityType) return false;

  // Mixed-case simpleValue literals are malformed authoring — rejected
  // outright (mirrors checkEntityFacet).
  if (
    facet.name.type === 'simpleValue' &&
    facet.name.value !== facet.name.value.toUpperCase()
  ) {
    return false;
  }

  if (
    !matchConstraint(facet.name, entityType, IFC_CASE_INSENSITIVE) &&
    !matchesIfc2x3Mapping(facet, entityType, expressId, accessor)
  ) {
    return false;
  }

  if (facet.predefinedType) {
    const rawType = accessor.getPredefinedTypeRaw?.(expressId);
    const userDefinedType = accessor.getObjectType(expressId);

    if (!rawType && !userDefinedType) return false;

    if (rawType && matchConstraint(facet.predefinedType, rawType)) {
      return true;
    }
    if (
      rawType === 'USERDEFINED' &&
      userDefinedType &&
      userDefinedType !== rawType &&
      matchConstraint(facet.predefinedType, userDefinedType)
    ) {
      return true;
    }
    if (
      !rawType &&
      userDefinedType &&
      matchConstraint(facet.predefinedType, userDefinedType)
    ) {
      return true;
    }
    return false;
  }

  return true;
}

/**
 * Get candidate entity IDs that might match an entity facet (broadphase filter)
 */
export function filterByEntityFacet(
  facet: IDSEntityFacet,
  accessor: IFCDataAccessor
): number[] | undefined {
  const constraint = facet.name;

  // IFC2X3: a literal naming a mapping-table alias (`IFCAIRTERMINAL`)
  // never appears as an actual entity type in the model — only its
  // mapped occurrence class does (`IFCFLOWTERMINAL`). A type-indexed
  // broadphase filter keyed on the alias itself would come back empty
  // and wrongly prune every candidate before the per-entity check (and
  // its type-object lookup) ever runs. Falling back to a full scan
  // keeps `matchesIfc2x3Mapping` as the single source of truth instead
  // of duplicating its (occurrence, type) resolution here.
  const isIfc2x3 = (accessor.getSchemaVersion?.() || '').toUpperCase() === 'IFC2X3';

  // For simple values, we can efficiently filter by type
  if (constraint.type === 'simpleValue') {
    if (isIfc2x3 && IFC2X3_MAPPED_ALIASES.has(constraint.value.toUpperCase())) {
      return undefined;
    }
    return accessor.getEntitiesByType(constraint.value);
  }

  // For enumerations, collect entities of all specified types
  if (constraint.type === 'enumeration') {
    if (
      isIfc2x3 &&
      constraint.values.some((v) => IFC2X3_MAPPED_ALIASES.has(v.toUpperCase()))
    ) {
      return undefined;
    }
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
        // Legitimately silent: an uncompilable pattern matches no entity type,
        // and the IDS audit reports the bad pattern itself under
        // W_REGEX_UNVERIFIED / the coherence regex check. Warning here would
        // duplicate that per candidate-type resolution.
        return [];
      }
    default:
      return allTypes;
  }
}
