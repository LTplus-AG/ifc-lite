/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IDSSpecification } from '@ifc-lite/ids';

/**
 * Literal entity names of a specification's applicability (a simple value or
 * the members of an enumeration), as stored (upper case). Pickers use them to
 * offer the attributes and property sets that apply; a pattern yields none.
 */
export function applicabilityEntities(spec: IDSSpecification): string[] {
  const out: string[] = [];
  for (const facet of spec.applicability.facets) {
    if (facet.type !== 'entity') continue;
    if (facet.name.type === 'simpleValue') out.push(facet.name.value);
    else if (facet.name.type === 'enumeration') out.push(...facet.name.values);
  }
  return [...new Set(out)];
}
