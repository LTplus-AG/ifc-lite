/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW: facets nested in `partOf` (#379, draft PR #380).
 *
 * #379 asks for "every IfcSpace in a storey named 01 …": partOf finds the
 * related element, and the proposal in #380 lets attribute, property,
 * classification and material facets sit next to partOf's entity, applying
 * to that related element. Conservative reading (P-12 worklog): an ancestor
 * reached through the relation counts only if it matches the entity AND
 * every nested facet, each judged exactly as an applicability facet would
 * judge the ancestor itself (presence plus value, no cardinality).
 */

import type { IDSPartOfFacet, IFCDataAccessor, ParentInfo } from '../types.js';
import type { FacetCheckResult } from '../facets/index.js';
import { checkAttributeFacet } from '../facets/attribute-facet.js';
import { checkPropertyFacet } from '../facets/property-facet.js';
import { checkClassificationFacet } from '../facets/classification-facet.js';
import { checkMaterialFacet } from '../facets/material-facet.js';

type NestedFacet = NonNullable<IDSPartOfFacet['facets']>[number];

function checkNested(facet: NestedFacet, expressId: number, accessor: IFCDataAccessor): FacetCheckResult {
  switch (facet.type) {
    case 'attribute':
      return checkAttributeFacet(facet, expressId, accessor);
    case 'property':
      return checkPropertyFacet(facet, expressId, accessor);
    case 'classification':
      return checkClassificationFacet(facet, expressId, accessor);
    case 'material':
      return checkMaterialFacet(facet, expressId, accessor);
  }
}

/**
 * The first nested facet `parent` fails, as a partOf failure, or
 * `undefined` when it satisfies all of them (or there are none).
 */
export function checkPartOfParentFacets(
  facet: IDSPartOfFacet,
  parent: ParentInfo,
  accessor: IFCDataAccessor,
): FacetCheckResult | undefined {
  for (const [index, nested] of (facet.facets ?? []).entries()) {
    const result = checkNested(nested, parent.expressId, accessor);
    if (result.passed) continue;
    return {
      passed: false,
      actualValue: `${parent.entityType}: ${result.actualValue ?? 'no match'}`,
      expectedValue: `${parent.entityType} with ${result.expectedValue ?? nested.type}`,
      failure: {
        // Reported as an entity mismatch on the related element: it is the
        // right kind of relation, but not to an element of the required kind.
        type: 'PARTOF_ENTITY_MISMATCH',
        field: `facets[${index}]`,
        actual: result.failure?.actual ?? result.actualValue,
        expected: result.failure?.expected ?? result.expectedValue,
        context: {
          relation: facet.relation,
          parentId: String(parent.expressId),
          nestedFacet: nested.type,
          nestedFailure: result.failure?.type ?? 'unknown',
        },
      },
    };
  }
  return undefined;
}

/**
 * IDS 1.1 PREVIEW: a partOf description followed by its nested facets in
 * brackets, each described as an applicability facet of the related element.
 * Unchanged for an IDS 1.0 partOf (no nested facets).
 */
export function describeWithNestedFacets(
  facet: IDSPartOfFacet,
  base: string,
  describe: (nested: NestedFacet) => string,
): string {
  if (!facet.facets || facet.facets.length === 0) return base;
  return `${base} [${facet.facets.map(describe).join('; ')}]`;
}
