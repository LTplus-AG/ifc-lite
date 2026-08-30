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
import { findAllPropertiesInSets } from '@ifc-lite/query';

function normalizeBoolean(value: unknown): unknown {
  if (value === true || value === '.T.' || value === 'true' || value === 'TRUE') return 'true';
  if (value === false || value === '.F.' || value === 'false' || value === 'FALSE') return 'false';
  return value;
}

export function matchesPropertyFilter(props: PropertySetData[], filter: QueryFilter): boolean {
  const matchingProps = findAllPropertiesInSets(props, filter.psetName, filter.propName);
  if (matchingProps.length === 0) return false;
  if (filter.operator === 'exists') return true;
  const f = normalizeBoolean(filter.value);
  return matchingProps.some((prop) => {
    const v = normalizeBoolean(prop.value);
    switch (filter.operator) {
      case '=': return String(v) === String(f);
      case '!=': return String(v) !== String(f);
      case '>': return Number(v) > Number(f);
      case '<': return Number(v) < Number(f);
      case '>=': return Number(v) >= Number(f);
      case '<=': return Number(v) <= Number(f);
      case 'contains': return String(v).toLowerCase().includes(String(f).toLowerCase());
      default: return false;
    }
  });
}
