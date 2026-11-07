/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isValidIfcGuid, uuidToIfcGuid, uuidV5 } from '@ifc-lite/encoding';
import type { QuantitySet } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** ifc-lite's fixed namespace for the relationship attaching a derived set. Never change it. */
const DERIVED_SET_REL_NAMESPACE = '0f7c6a1e-3b9d-4c55-9a8e-2d1b7e6f4a30';

/**
 * The GlobalIds to write for a set an unaliased overlay-created element derives:
 * the set's own name-based id, and one derived from it for the relationship, so
 * exporting the same model twice writes the same file. Null for every other set,
 * which keeps a fresh id: a loaded element's sets, a copy's (it would repeat its
 * source's id) and a set a person created.
 */
export function derivedSetGlobalIds(view: MutablePropertyView | null, entityId: number, set: QuantitySet): { set: string; rel: string } | null {
  if (!view || !set.globalId || !isValidIfcGuid(set.globalId)) return null;
  if (!view.getNewEntity(entityId) || view.resolveBaseEntityId(entityId) !== entityId) return null;
  return { set: set.globalId, rel: uuidToIfcGuid(uuidV5(DERIVED_SET_REL_NAMESPACE, set.globalId)) };
}

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
