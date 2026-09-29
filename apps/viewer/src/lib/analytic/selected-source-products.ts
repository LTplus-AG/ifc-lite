/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { entityRefToString, stringToEntityRef, type EntityRef, type ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { normalizeMutationModelId } from '@/sdk/adapters/mutation-view';

export interface SelectedSourceProducts {
  grouped: Map<string, number[]>;
  overlayRefs: EntityRef[];
  diagnostics: string[];
  priorityMissing: boolean;
}

const MAX_SELECTED_PRODUCTS = 256;

/** Shared model-aware selection and visibility policy for authored source queries. */
export function selectedSourceProducts(
  state: ViewerState, label: string, priorityRef: EntityRef | null = null,
  resolve = resolveEntityRef,
): SelectedSourceProducts {
  const refs = new Map<string, EntityRef>();
  if (state.selectedEntity) refs.set(entityRefToString(state.selectedEntity), state.selectedEntity);
  if (state.selectedEntityId !== null) {
    const ref = resolve(state.selectedEntityId);
    refs.set(entityRefToString(ref), ref);
  }
  for (const id of state.selectedEntityIds) {
    const ref = resolve(id);
    refs.set(entityRefToString(ref), ref);
  }
  for (const key of state.selectedEntitiesSet) {
    const ref = stringToEntityRef(key);
    if (ref.expressId > 0) refs.set(entityRefToString(ref), ref);
  }
  const priorityKey = priorityRef ? entityRefToString(priorityRef) : null;
  const ordered = new Map<string, EntityRef>();
  if (priorityKey) {
    const ref = refs.get(priorityKey);
    if (ref) ordered.set(priorityKey, ref);
  }
  for (const [key, ref] of refs) ordered.set(key, ref);

  const grouped = new Map<string, number[]>();
  const overlayRefs: EntityRef[] = [];
  const diagnostics: string[] = [];
  let included = 0;
  let omitted = 0;
  for (const ref of ordered.values()) {
    const model = ref.modelId === 'legacy' && state.models.size === 0
      ? { visible: true, schemaVersion: state.ifcDataStore?.schemaVersion, ifcDataStore: state.ifcDataStore }
      : state.models.get(ref.modelId);
    if (!model?.visible || !model.ifcDataStore || model.schemaVersion === 'IFC5') continue;
    let globalId: number;
    try { globalId = ref.modelId === 'legacy' && state.models.size === 0
      ? ref.expressId : state.toGlobalId(ref.modelId, ref.expressId); }
    catch (error) {
      diagnostics.push(`selected ${entityRefToString(ref)}: ${String(error)}`);
      continue;
    }
    if (state.hiddenEntities.has(globalId) || state.lensHiddenIds.has(globalId)
      || (state.isolatedEntities !== null && !state.isolatedEntities.has(globalId))
      || (state.classFilter !== null && !state.classFilter.ids.has(globalId))) continue;
    if (included >= MAX_SELECTED_PRODUCTS) { omitted++; continue; }
    included++;
    if (state.mutationViews.get(normalizeMutationModelId(state, ref.modelId))?.getNewEntity(ref.expressId)) {
      overlayRefs.push(ref);
      continue;
    }
    const ids = grouped.get(ref.modelId) ?? [];
    ids.push(ref.expressId);
    grouped.set(ref.modelId, ids);
  }
  if (omitted) diagnostics.push(
    `Selected ${label} limited to ${MAX_SELECTED_PRODUCTS} products; ${omitted} selected products were omitted`,
  );
  return { grouped, overlayRefs, diagnostics, priorityMissing: priorityKey !== null && !refs.has(priorityKey) };
}
