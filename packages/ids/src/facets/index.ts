/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Facet checkers for IDS validation
 */

import type {
  IDSFacet,
  IDSEntityFacet,
  IDSAttributeFacet,
  IDSPropertyFacet,
  IDSClassificationFacet,
  IDSMaterialFacet,
  IDSPartOfFacet,
  IFCDataAccessor,
  IDSFailureDetail,
} from '../types.js';

import { checkEntityFacet, filterByEntityFacet, entityFacetPasses } from './entity-facet.js';
import { checkAttributeFacet } from './attribute-facet.js';
import { checkPropertyFacet, propertyFacetPasses } from './property-facet.js';
import { checkClassificationFacet } from './classification-facet.js';
import { checkMaterialFacet } from './material-facet.js';
import { checkPartOfFacet } from './partof-facet.js';

export {
  checkEntityFacet,
  filterByEntityFacet,
} from './entity-facet.js';
export { checkAttributeFacet } from './attribute-facet.js';
export { checkPropertyFacet } from './property-facet.js';
export { checkClassificationFacet } from './classification-facet.js';
export { checkMaterialFacet } from './material-facet.js';
export { checkPartOfFacet } from './partof-facet.js';

/** Result of a facet check */
export interface FacetCheckResult {
  /** Whether the facet check passed */
  passed: boolean;
  /** Actual value found (for diagnostics) */
  actualValue?: string;
  /** Expected value description */
  expectedValue?: string;
  /** Failure details if failed */
  failure?: IDSFailureDetail;
}

/**
 * Check if an entity matches a facet
 */
export function checkFacet(
  facet: IDSFacet,
  expressId: number,
  accessor: IFCDataAccessor
): FacetCheckResult {
  switch (facet.type) {
    case 'entity':
      return checkEntityFacet(facet, expressId, accessor);
    case 'attribute':
      return checkAttributeFacet(facet, expressId, accessor);
    case 'property':
      return checkPropertyFacet(facet, expressId, accessor);
    case 'classification':
      return checkClassificationFacet(facet, expressId, accessor);
    case 'material':
      return checkMaterialFacet(facet, expressId, accessor);
    case 'partOf':
      return checkPartOfFacet(facet, expressId, accessor);
    default:
      return {
        passed: false,
        failure: {
          type: 'ENTITY_TYPE_MISMATCH',
          expected: 'known facet type',
          actual: (facet as IDSFacet).type,
        },
      };
  }
}

/**
 * Diagnostics-free verdict for a facet — the exact `passed` boolean
 * `checkFacet` would compute, without allocating failure objects or
 * display strings. Entity and property facets (the ones applicability
 * filtering hammers — every candidate entity × every specification)
 * have dedicated string-free cores; the remaining facet types fall back
 * to the full checker.
 */
export function facetPasses(
  facet: IDSFacet,
  expressId: number,
  accessor: IFCDataAccessor
): boolean {
  switch (facet.type) {
    case 'entity':
      return entityFacetPasses(facet, expressId, accessor);
    case 'property':
      return propertyFacetPasses(facet, expressId, accessor);
    default:
      return checkFacet(facet, expressId, accessor).passed;
  }
}

/**
 * Get candidate entity IDs that might match a facet (broadphase filter)
 * Returns undefined if no efficient filtering is possible
 */
export function filterByFacet(
  facet: IDSFacet,
  accessor: IFCDataAccessor
): number[] | undefined {
  switch (facet.type) {
    case 'entity':
      return filterByEntityFacet(facet, accessor);
    // Other facets don't have efficient broadphase filtering
    default:
      return undefined;
  }
}
