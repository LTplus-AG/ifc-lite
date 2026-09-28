/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { useViewerStore, entityRefToString, stringToEntityRef, type EntityRef } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { normalizeMutationModelId } from '@/sdk/adapters/mutation-view';
import { selectedExtrusionCache, type ProductExtrusions } from '@/lib/analytic/extrusion-cache';
import type { AnalyticSourceModel } from '@/lib/analytic/swept-disk-cache';

export interface SelectedExtrusion {
  ref: EntityRef;
  product: ProductExtrusions;
}

export interface SelectedExtrusionsState {
  items: SelectedExtrusion[];
  loading: boolean;
  error: string | null;
}

const EMPTY: SelectedExtrusionsState = { items: [], loading: false, error: null };
const MAX_SELECTED_PRODUCTS = 256;

/** Read authored extrusions for selected products, preserving model-local IDs. */
export function useSelectedExtrusions(enabled: boolean): SelectedExtrusionsState {
  const models = useViewerStore((state) => state.models);
  const legacyStore = useViewerStore((state) => state.ifcDataStore);
  const selectedIds = useViewerStore((state) => state.selectedEntityIds);
  const primaryId = useViewerStore((state) => state.selectedEntityId);
  const selectedRefs = useViewerStore((state) => state.selectedEntitiesSet);
  const primaryRef = useViewerStore((state) => state.selectedEntity);
  const hidden = useViewerStore((state) => state.hiddenEntities);
  const isolated = useViewerStore((state) => state.isolatedEntities);
  const classFilter = useViewerStore((state) => state.classFilter);
  const lensHidden = useViewerStore((state) => state.lensHiddenIds);
  const [result, setResult] = useState<SelectedExtrusionsState>(EMPTY);

  useEffect(() => selectedExtrusionCache.retain(), []);
  useEffect(() => {
    const sources: AnalyticSourceModel[] = [...models.values()];
    if (models.size === 0 && legacyStore) sources.push({ id: 'legacy', ifcDataStore: legacyStore });
    selectedExtrusionCache.prune(sources);
  }, [models, legacyStore]);

  useEffect(() => {
    if (!enabled) { setResult(EMPTY); return; }
    let active = true;
    const state = useViewerStore.getState();
    const refs = new Map<string, EntityRef>();
    if (primaryRef) refs.set(entityRefToString(primaryRef), primaryRef);
    if (primaryId !== null) {
      const ref = resolveEntityRef(primaryId);
      refs.set(entityRefToString(ref), ref);
    }
    for (const id of selectedIds) {
      const ref = resolveEntityRef(id);
      refs.set(entityRefToString(ref), ref);
    }
    for (const key of selectedRefs) {
      const ref = stringToEntityRef(key);
      if (ref.expressId > 0) refs.set(entityRefToString(ref), ref);
    }
    const grouped = new Map<string, number[]>();
    const overlayItems: SelectedExtrusion[] = [];
    const diagnostics: string[] = [];
    let selectedProducts = 0;
    let omittedProducts = 0;
    for (const ref of refs.values()) {
      const model = ref.modelId === 'legacy' && models.size === 0
        ? { visible: true, schemaVersion: legacyStore?.schemaVersion, ifcDataStore: legacyStore }
        : models.get(ref.modelId);
      if (!model?.visible || !model.ifcDataStore || model.schemaVersion === 'IFC5') continue;
      let globalId: number;
      try { globalId = ref.modelId === 'legacy' && models.size === 0
        ? ref.expressId : state.toGlobalId(ref.modelId, ref.expressId); }
      catch (error) {
        diagnostics.push(`selected ${entityRefToString(ref)}: ${String(error)}`);
        continue;
      }
      if (hidden.has(globalId) || lensHidden.has(globalId)
        || (isolated !== null && !isolated.has(globalId))
        || (classFilter !== null && !classFilter.ids.has(globalId))) continue;
      if (selectedProducts >= MAX_SELECTED_PRODUCTS) { omittedProducts++; continue; }
      selectedProducts++;
      if (state.mutationViews.get(normalizeMutationModelId(state, ref.modelId))?.getNewEntity(ref.expressId)) {
        overlayItems.push({ ref, product: { occurrences: [], lengthUnitScale: 1,
          diagnostics: [`product #${ref.expressId}: created in the overlay; no authored extrusion source is available`] } });
        continue;
      }
      const ids = grouped.get(ref.modelId) ?? [];
      ids.push(ref.expressId);
      grouped.set(ref.modelId, ids);
    }
    if (omittedProducts) diagnostics.push(
      `Selected extrusion inspection limited to ${MAX_SELECTED_PRODUCTS} products; ${omittedProducts} selected products were omitted`,
    );
    if (grouped.size === 0) {
      setResult({ items: overlayItems, loading: false, error: diagnostics.join('; ') || null });
      return () => { active = false; };
    }
    setResult({ items: [], loading: true, error: null });
    void Promise.all([...grouped].map(async ([modelId, ids]) => {
      const model = models.get(modelId) ?? (modelId === 'legacy' && legacyStore
        ? { id: 'legacy', ifcDataStore: legacyStore } : null);
      if (!model) return [];
      const products = await selectedExtrusionCache.get(model, ids);
      return ids.map((expressId): SelectedExtrusion => ({
        ref: { modelId, expressId }, product: products.get(expressId) ?? {
          occurrences: [], diagnostics: [], lengthUnitScale: 1,
        },
      }));
    })).then((groups) => {
      if (active) setResult({ items: [...groups.flat(), ...overlayItems], loading: false, error: diagnostics.join('; ') || null });
    }).catch((error: unknown) => {
      if (active) setResult({ items: [], loading: false, error: String(error) });
    });
    return () => { active = false; };
  }, [enabled, models, legacyStore, selectedIds, primaryId, selectedRefs, primaryRef,
    hidden, isolated, classFilter, lensHidden]);

  return result;
}
