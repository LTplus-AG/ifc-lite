/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PartOf facet checker
 */

import type {
  IDSPartOfFacet,
  IFCDataAccessor,
  ParentInfo,
  PartOfRelation,
} from '../types.js';
import type { FacetCheckResult } from './index.js';
import { matchConstraint, formatConstraint, type MatchOptions } from '../constraints/index.js';
import { matchPredefinedType } from './predefined-type-match.js';

/** IFC entity NAME comparisons are case-insensitive per IDS spec. Predefined
 *  types are NOT — see `predefined-type-match.ts`. */
const IFC_CASE_INSENSITIVE: MatchOptions = { caseInsensitive: true };

/** Human-readable relation names */
const RELATION_NAMES: Record<PartOfRelation, string> = {
  IfcRelAggregates: 'aggregated in',
  IfcRelAssignsToGroup: 'grouped in',
  IfcRelContainedInSpatialStructure: 'contained in',
  IfcRelNests: 'nested in',
  IfcRelVoidsElement: 'voiding',
  IfcRelFillsElement: 'filling',
  'IfcRelVoidsElement IfcRelFillsElement': 'connected through an opening to',
};

/**
 * The six part-of relations the IDS manual lists, plus the merged
 * voids/fills token. The single fills and voids links are asked for
 * directly so the opening a window fills is reached whatever an
 * accessor's merged walk returns.
 */
const ALL_PARTOF_RELATIONS: readonly PartOfRelation[] = [
  'IfcRelAggregates',
  'IfcRelAssignsToGroup',
  'IfcRelContainedInSpatialStructure',
  'IfcRelNests',
  'IfcRelVoidsElement',
  'IfcRelFillsElement',
  'IfcRelVoidsElement IfcRelFillsElement',
];

/** The relation a failure names: `part of` when the facet leaves it open. */
function relationKey(facet: IDSPartOfFacet): string {
  return facet.anyRelation ? 'part of' : facet.relation;
}

function describeRelation(facet: IDSPartOfFacet): string {
  if (facet.anyRelation) return 'part of';
  return RELATION_NAMES[facet.relation] || facet.relation;
}

/** Ancestors reachable through one relation (transitive within it). */
function collectAncestors(
  expressId: number,
  relation: PartOfRelation,
  accessor: IFCDataAccessor
): ParentInfo[] {
  const ancestors = accessor.getAncestors ? accessor.getAncestors(expressId, relation) : [];
  if (ancestors.length === 0) {
    const direct = accessor.getParent(expressId, relation);
    if (direct) ancestors.push(direct);
  }
  return ancestors;
}

/**
 * A partOf facet without a relation considers every part-of relation,
 * recursively (IDS 1.0 user manual, #7401), so a chain may mix them: a
 * mullion aggregated into a curtain wall contained in a storey is part of
 * that storey. Walk to a fixpoint over all relations, nearest first.
 */
function collectAnyRelationAncestors(
  expressId: number,
  accessor: IFCDataAccessor
): ParentInfo[] {
  const out: ParentInfo[] = [];
  const seen = new Set<number>([expressId]);
  const queue = [expressId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const relation of ALL_PARTOF_RELATIONS) {
      for (const parent of collectAncestors(id, relation, accessor)) {
        if (seen.has(parent.expressId)) continue;
        seen.add(parent.expressId);
        out.push(parent);
        queue.push(parent.expressId);
      }
    }
  }
  return out;
}

/**
 * Check if an entity matches a partOf facet
 */
export function checkPartOfFacet(
  facet: IDSPartOfFacet,
  expressId: number,
  accessor: IFCDataAccessor
): FacetCheckResult {
  // Per IDS spec, partOf is transitive — a wall contained in a storey
  // in a building IS partOf the building. Walk every ancestor and
  // pass if ANY matches the requirement entity. Fall back to single-
  // step `getParent` when the accessor doesn't expose ancestor
  // traversal.
  const ancestors = facet.anyRelation
    ? collectAnyRelationAncestors(expressId, accessor)
    : collectAncestors(expressId, facet.relation, accessor);

  if (ancestors.length === 0) {
    const relationName = describeRelation(facet);
    const expectedEntity = facet.entity
      ? formatConstraint(facet.entity.name)
      : 'any entity';

    return {
      passed: false,
      actualValue: '(no parent)',
      expectedValue: `${relationName} ${expectedEntity}`,
      failure: {
        type: 'PARTOF_RELATION_MISSING',
        field: relationKey(facet),
        expected: `${relationName} ${expectedEntity}`,
        context: {
          relation: relationKey(facet),
        },
      },
    };
  }

  // Try each ancestor against the requirement; pass on the first
  // match. Track the most-specific failure so a partial match (right
  // entity, wrong predefinedType, say) is reported instead of the
  // generic "no match" form.
  let bestFailure: FacetCheckResult | undefined;
  for (const parent of ancestors) {
    const result = checkAncestorAgainstFacet(facet, parent);
    if (result.passed) return result;
    if (
      !bestFailure ||
      (result.failure?.type !== 'PARTOF_ENTITY_MISMATCH' &&
        bestFailure.failure?.type === 'PARTOF_ENTITY_MISMATCH')
    ) {
      bestFailure = result;
    }
  }
  return bestFailure!;
}

function checkAncestorAgainstFacet(
  facet: IDSPartOfFacet,
  parent: ParentInfo
): FacetCheckResult {

  // If no entity constraint, just check if relationship exists
  if (!facet.entity) {
    const relationName = describeRelation(facet);

    return {
      passed: true,
      actualValue: `${relationName} ${parent.entityType}`,
      expectedValue: `${relationName} any entity`,
    };
  }

  // Check parent entity type (case-insensitive for IFC entity names)
  if (!matchConstraint(facet.entity.name, parent.entityType, IFC_CASE_INSENSITIVE)) {
    const relationName = describeRelation(facet);

    return {
      passed: false,
      actualValue: `${relationName} ${parent.entityType}`,
      expectedValue: `${relationName} ${formatConstraint(facet.entity.name)}`,
      failure: {
        type: 'PARTOF_ENTITY_MISMATCH',
        field: 'entity',
        actual: parent.entityType,
        expected: formatConstraint(facet.entity.name),
        context: {
          relation: relationKey(facet),
          parentId: String(parent.expressId),
        },
      },
    };
  }

  // Check parent predefined type if specified. The IDS XSD gives this
  // nested `<entity>` the same complex type an entity facet uses, so the
  // matching rule is the shared one in `predefined-type-match.ts` — the
  // raw enum token first, the parent's user-defined name only as the
  // USERDEFINED fallback, both compared case-sensitively. Only the
  // PARTOF_-prefixed failure wording below is specific to this facet.
  if (facet.entity.predefinedType) {
    const outcome = matchPredefinedType(
      facet.entity.predefinedType,
      parent.predefinedType,
      parent.objectType
    );

    if (outcome.kind === 'absent') {
      return {
        passed: false,
        actualValue: `${parent.entityType} (no predefinedType)`,
        expectedValue: `${formatConstraint(facet.entity.name)} with predefinedType ${formatConstraint(facet.entity.predefinedType)}`,
        failure: {
          type: 'PARTOF_PREDEFINED_TYPE_MISSING',
          field: 'predefinedType',
          expected: formatConstraint(facet.entity.predefinedType),
          context: {
            relation: relationKey(facet),
            parentType: parent.entityType,
          },
        },
      };
    }

    if (outcome.kind === 'mismatch') {
      return {
        passed: false,
        actualValue: `${parent.entityType}[${outcome.actual}]`,
        expectedValue: `${formatConstraint(facet.entity.name)}[${formatConstraint(facet.entity.predefinedType)}]`,
        failure: {
          type: 'PARTOF_PREDEFINED_TYPE_MISMATCH',
          field: 'predefinedType',
          actual: outcome.actual,
          expected: formatConstraint(facet.entity.predefinedType),
          context: {
            relation: relationKey(facet),
            parentType: parent.entityType,
          },
        },
      };
    }
  }

  const relationName = describeRelation(facet);
  const parentDesc = parent.predefinedType
    ? `${parent.entityType}[${parent.predefinedType}]`
    : parent.entityType;

  return {
    passed: true,
    actualValue: `${relationName} ${parentDesc}`,
    expectedValue: `${relationName} ${formatConstraint(facet.entity.name)}`,
  };
}
