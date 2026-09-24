/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `inherit: 'aggregation'` on a list condition (#5433): an element with no
 * value of its own takes the nearest `IfcRelAggregates` ancestor's, the
 * same meaning the rule engine gives it (`@ifc-lite/rules`'
 * `read-measure-subject.ts`). Type values need no option here: list
 * conditions have always fallen back to the type (#1745). The walk is
 * iterative with a visited set, so a cyclic aggregation in a broken file
 * ends.
 */

import type { CellValue, ListDataProvider, PropertyCondition } from './types.js';

export function withAggregateInheritance(
  entityId: number,
  condition: PropertyCondition,
  provider: ListDataProvider,
  read: (id: number) => CellValue,
): CellValue {
  const own = read(entityId);
  const parentsOf = provider.getAggregateParents?.bind(provider);
  if ((own !== null && own !== '') || condition.inherit !== 'aggregation' || !parentsOf) return own;
  const visited = new Set<number>([entityId]);
  let frontier = parentsOf(entityId);
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const parent of frontier) {
      if (visited.has(parent)) continue;
      visited.add(parent);
      const value = read(parent);
      if (value !== null && value !== '') return value;
      next.push(...parentsOf(parent));
    }
    frontier = next;
  }
  return own;
}
