/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { effectiveStoreyId as resolveEffectiveStoreyId, type IfcDataStore } from '@ifc-lite/parser';
import { edgeSurvives, RelationshipType } from '@ifc-lite/data';
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

/**
 * The IFC type of the spatial element that DIRECTLY contains the product
 * (containment edits included), storey or not: e.g. `IfcBuilding` for a wall
 * placed on the building rather than a storey. Lets a refusal that needs a
 * storey say where the element is. Aggregated parts are not walked: this only
 * names a container, the storey walk above decides.
 */
export function effectiveContainerTypeName(
  store: IfcDataStore,
  view: MutablePropertyView,
  selectedId: number,
): string | undefined {
  if (view.isDeleted(selectedId)) return undefined;
  const overlay = effectiveMutationRelationships(store, view);
  const edited = overlay.relationships.find((r) => r.relationshipType.toUpperCase() === 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
    && r.related.includes(selectedId));
  const superseded = (id: number) => view.isDeleted(id) || overlay.supersededSourceIds.has(id);
  const container = edited?.relating[0]
    ?? store.relationships.inverse.getEdges(selectedId, RelationshipType.ContainsElements)
      .find((edge) => edgeSurvives(edge, superseded))?.target;
  return container === undefined || view.isDeleted(container) ? undefined : effectiveContextType(store, view, container);
}
