/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { extractClassificationSystemsOnDemand, type IfcDataStore } from '@ifc-lite/parser';

/** Metadata and native query consumers share one effective classification reader (#7131). */
export function effectiveClassificationSystems(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): { names: string[]; unresolved: boolean } {
  return extractClassificationSystemsOnDemand(store, view ?? undefined);
}

const CLASSIFICATION_TYPES = new Set(['IFCCLASSIFICATION', 'IFCCLASSIFICATIONREFERENCE', 'IFCRELASSOCIATESCLASSIFICATION', 'IFCRELDEFINESBYTYPE']);

/** Current classification edits, shared by discovery and availability checks (#7131). */
export function hasClassificationEdits(
  store: IfcDataStore | null | undefined,
  view: MutablePropertyView | null | undefined,
): boolean {
  if (!store || !view) return false;
  // Effective changes are current; append-only history would incorrectly
  // report an unavailable edit after undo restored the source value.
  return view.getEffectiveChanges().some(change => {
    const types = [store.entities.getTypeName(change.entityId), view.getNewEntity(change.entityId)?.type, view.getEntityTypeMutation(change.entityId)?.newType];
    return types.some(type => type !== undefined && CLASSIFICATION_TYPES.has(type.toUpperCase()));
  });
}

/** Missing source membership inputs or edits cannot prove a complete population (#7131). */
export function classificationPopulationUnavailable(
  store: IfcDataStore | null | undefined,
  view: MutablePropertyView | null | undefined,
): boolean {
  return Boolean(store && !store.source?.length && (
    (!store.onDemandClassificationMap && !store.relationships) || hasClassificationEdits(store, view)
  ));
}
