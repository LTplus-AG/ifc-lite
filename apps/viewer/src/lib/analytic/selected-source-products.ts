/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { entityRefToString, stringToEntityRef, type EntityRef, type ViewerState } from '@/store';
import { normalizeMutationModelId } from '@/sdk/adapters/mutation-view';
import { sourceIdentity } from './analytic-product-cache';

export interface SelectedSourceProducts {
  grouped: Map<string, number[]>;
  overlayRefs: EntityRef[];
  diagnostics: string[];
  priorityMissing: boolean;
}

const MAX_SELECTED_PRODUCTS = 256;

/** Shared model-aware selection and visibility policy for authored source queries. */
export function selectedSourceProducts(
  state: ViewerState, label: string, resolve: (globalId: number) => EntityRef,
  priorityRef: EntityRef | null = null,
): SelectedSourceProducts {
  const diagnostics: string[] = [];
  const refs = new Map<string, EntityRef>();
  // Model-aware selection is authoritative when its basket is populated.
  // removeEntityFromSelection can retain an older renderer selectedEntityId.
  if (state.selectedEntity && (state.selectedEntitiesSet.size === 0
    || state.selectedEntitiesSet.has(entityRefToString(state.selectedEntity)))) {
    refs.set(entityRefToString(state.selectedEntity), state.selectedEntity);
  }
  if (state.selectedEntitiesSet.size === 0) {
    // The renderer's multi-selection is current only when it still contains
    // the model-aware primary. setSelectedEntity can leave older renderer IDs.
    let includeRendererSet = !state.selectedEntity;
    if (state.selectedEntity && state.selectedEntityIds.size > 0) {
      try {
        const primaryGlobalId = state.selectedEntity.modelId === 'legacy' && state.models.size === 0
          ? state.selectedEntity.expressId
          : state.toGlobalId(state.selectedEntity.modelId, state.selectedEntity.expressId);
        includeRendererSet = state.selectedEntityIds.has(primaryGlobalId);
      } catch (error) {
        diagnostics.push(`selected ${entityRefToString(state.selectedEntity)}: ${String(error)}`);
      }
    }
    if (!state.selectedEntity && state.selectedEntityId !== null) {
      const ref = resolve(state.selectedEntityId);
      refs.set(entityRefToString(ref), ref);
    }
    if (includeRendererSet) {
      for (const id of state.selectedEntityIds) {
        const ref = resolve(id);
        refs.set(entityRefToString(ref), ref);
      }
    }
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
  let included = 0;
  let omitted = 0;
  for (const ref of ordered.values()) {
    const model = ref.modelId === 'legacy' && state.models.size === 0
      ? { id: 'legacy', visible: true, schemaVersion: state.ifcDataStore?.schemaVersion,
        ifcDataStore: state.ifcDataStore, loadFormat: 'ifc', sourceFile: undefined }
      : state.models.get(ref.modelId);
    if (!model?.visible || !model.ifcDataStore || model.schemaVersion === 'IFC5') continue;
    // Federated GLB has a compatibility IFC4 store with no STEP source.
    // Legacy/cached models may lack loadFormat, so also require real IFC bytes
    // or a retained IFC source file before attempting the analytic decoder.
    if (model.loadFormat && model.loadFormat !== 'ifc') continue;
    const retainedFileIsIfc = !!model.sourceFile && (model.loadFormat === 'ifc'
      || /\.ifc(?:zip)?$/i.test(model.sourceFile.name));
    if (!sourceIdentity(model) || (!model.ifcDataStore.source?.byteLength && !retainedFileIsIfc)) continue;
    let globalId: number;
    try { globalId = ref.modelId === 'legacy' && state.models.size === 0
      ? ref.expressId : state.toGlobalId(ref.modelId, ref.expressId); }
    catch (error) {
      const message = `selected ${entityRefToString(ref)}: ${String(error)}`;
      if (!diagnostics.includes(message)) diagnostics.push(message);
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

/** One broken source must not suppress valid records from another model. */
export async function loadSelectedSourceGroups<T>(
  groups: ReadonlyMap<string, readonly number[]>,
  load: (modelId: string, ids: readonly number[]) => Promise<T[]>,
): Promise<{ items: T[]; errors: string[] }> {
  const entries = [...groups];
  const settled = await Promise.allSettled(entries.map(([modelId, ids]) => load(modelId, ids)));
  const items: T[] = [];
  const errors: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') items.push(...result.value);
    else errors.push(`model ${entries[index][0]}: ${String(result.reason)}`);
  });
  return { items, errors };
}
