/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';

/**
 * Name the quantity sets an element created this session reads from its view's
 * quantity base, so the file carries what the panel shows (#9026 item 20).
 *
 * The exporter writes a set only when an edit names it, and a set derived from
 * live geometry has no edit behind it. A copy of a loaded element is passed over:
 * it reads its source's sets, and how those reach the file is unchanged.
 */
export function nominateViewBaseQuantitySets(view: MutablePropertyView, quantityEdits: Map<number, Set<string>>): void {
  // Optional like `collectPropertyAndQuantitySetMutations`' probe: an older view has no base to ask.
  if (!view.hasQuantityBase?.()) return;
  for (const { expressId } of view.getNewEntities()) {
    if (!view.getNewEntity(view.resolveBaseEntityId(expressId))) continue;
    for (const set of view.getQuantitiesForEntity(expressId)) {
      let names = quantityEdits.get(expressId);
      if (!names) quantityEdits.set(expressId, names = new Set());
      names.add(set.name);
    }
  }
}
