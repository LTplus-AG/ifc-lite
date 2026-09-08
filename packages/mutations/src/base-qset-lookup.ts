/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Find a quantity by (qsetName, quantityName) across every quantity set
 * carrying that name in `qsets`, first match wins. An entity can
 * legitimately carry two distinct qsets sharing `qsetName` (one from the
 * type definition, one from the occurrence) -- `qsets.find(...)?.quantities
 * .find(...)` only ever sees the first one. Same defect family as
 * `findQuantityInSets` in `@ifc-lite/query`, duplicated here rather than
 * imported: `@ifc-lite/query` depends on `@ifc-lite/parser`, which depends
 * on `@ifc-lite/ifcx`, which depends on `@ifc-lite/mutations` -- taking the
 * dependency here would be a cycle.
 */

import type { QuantitySet, Quantity } from '@ifc-lite/data';

export function findQuantityInBaseSets(
  qsets: readonly QuantitySet[],
  qsetName: string,
  quantityName: string,
): Quantity | undefined {
  for (const qset of qsets) {
    if (qset.name !== qsetName) continue;
    const match = qset.quantities.find(q => q.name === quantityName);
    if (match) return match;
  }
  return undefined;
}
