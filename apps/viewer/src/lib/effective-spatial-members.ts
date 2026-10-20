/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveSpatialMemberIds, type IfcDataStore } from '@ifc-lite/parser';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations';
import { effectiveContextType } from '@/components/viewer/EntityContextMenu.effective-selection';
import { entityOwnership } from '@/utils/entity-ownership';

/** Direct members of a spatial container in one model's current session. */
export function effectiveSpatialMembers(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  containerId: number,
): number[] {
  const context = view?.hasPendingChanges() ? {
    relationships: effectiveMutationRelationships(store, view),
    isDeleted: (id: number) => view.isDeleted(id),
    typeName: (id: number) => effectiveContextType(store, view, id),
  } : undefined;
  return effectiveSpatialMemberIds(store, containerId, context).filter(entityOwnership(store, view));
}
