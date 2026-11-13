/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expandAffectedSet as expandCore, type RemeshCause } from '@ifc-lite/export';
import { getFootprintRoofPlaneParts } from '@ifc-lite/create';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

export type { RemeshCause };

/** A footprint roof's geometry belongs to its slab parts (#9357). */
export function expandAffectedSet(store: IfcDataStore, view: MutablePropertyView | null,
  ids: Iterable<number>, cause: RemeshCause): Set<number> {
  const targets = new Set(ids);
  if (view) for (const id of [...targets]) {
    for (const part of getFootprintRoofPlaneParts(store, view, id)) targets.add(part);
  }
  return expandCore(store, view, targets, cause);
}
