/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `entities()`'s `descriptor.filters` predicate, split out of
 * `backend-query.ts` (module-size ratchet).
 *
 * Any-match, not first-match (#3490): an entity can carry two distinct
 * same-named property sets (type + occurrence), so a filter predicate
 * passes when ANY of them satisfies the condition, not just the first
 * one found. This applies uniformly to every operator, `!=` included.
 */

import type { PropertySetData, QueryFilter } from '@ifc-lite/sdk';
import { findAllPropertiesInSets, compareFilterValue, type FilterComparisonOp } from '@ifc-lite/query';

// compareFilterValue is the same comparison the viewer SDK adapter, CLI
// HeadlessBackend, and CLI --where flag use for their QueryBackendMethods
// `where`, so this can't drift from their boolean-normalization/case
// -insensitive-`contains` semantics.
export function matchesPropertyFilter(props: PropertySetData[], filter: QueryFilter): boolean {
  const matchingProps = findAllPropertiesInSets(props, filter.psetName, filter.propName);
  if (matchingProps.length === 0) return false;
  if (filter.operator === 'exists') return true;
  return matchingProps.some((prop) =>
    compareFilterValue(prop.value, filter.operator as FilterComparisonOp, filter.value)
  );
}
