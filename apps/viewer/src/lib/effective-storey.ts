/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { effectiveStoreyId as resolveEffectiveStoreyId, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations';
import { effectiveContextType } from '@/components/viewer/EntityContextMenu.effective-selection';

/** The selected product's effective storey, including containment and aggregate edits. */
export function effectiveStoreyId(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  selectedId: number,
): number | undefined {
  if (!view?.hasPendingChanges()) return resolveEffectiveStoreyId(store, selectedId);
  return resolveEffectiveStoreyId(store, selectedId, {
    relationships: effectiveMutationRelationships(store, view),
    isDeleted: (id) => view.isDeleted(id),
    typeName: (id) => effectiveContextType(store, view, id),
  });
}
