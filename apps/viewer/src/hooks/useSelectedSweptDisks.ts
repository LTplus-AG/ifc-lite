/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import type { SweptDiskDescriptions } from '@ifc-lite/geometry';
import { useViewerStore, stringToEntityRef, entityRefToString, type EntityRef } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { selectedSweptDiskCache, type AnalyticSourceModel } from '@/lib/analytic/swept-disk-cache';

type Occurrences = SweptDiskDescriptions['elements'][string];

export interface SelectedSweptDisk {
  ref: EntityRef;
  occurrences: Occurrences;
  diagnostics: string[];
}

export interface SelectedSweptDisksState {
  items: SelectedSweptDisk[];
  loading: boolean;
  error: string | null;
}

const EMPTY: SelectedSweptDisksState = { items: [], loading: false, error: null };
const MAX_SELECTED_PRODUCTS = 256;

/** One selection query shared by drawing and the later source-geometry inspector. */
export function useSelectedSweptDisks(enabled: boolean): SelectedSweptDisksState {
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
  const [result, setResult] = useState<SelectedSweptDisksState>(EMPTY);
  const sourceIdentities = useRef<Map<string, object> | null>(null);

  useEffect(() => selectedSweptDiskCache.retain(), []);

  useEffect(() => {
    const sourceModels: AnalyticSourceModel[] = [...models.values()];
    if (models.size === 0 && legacyStore) sourceModels.push({ id: 'legacy', ifcDataStore: legacyStore });
    selectedSweptDiskCache.prune(sourceModels);
    const next = new Map(sourceModels.flatMap((model) => {
      const source = model.ifcDataStore?.source.byteLength ? model.ifcDataStore.source : model.sourceFile;
      return source ? [[model.id, source] as const] : [];
    }));
    const highlighted = useViewerStore.getState().selectedDirectrixSegment;
    if (highlighted && sourceIdentities.current
      && sourceIdentities.current.get(highlighted.modelId) !== next.get(highlighted.modelId)) {
      useViewerStore.getState().setSelectedDirectrixSegment(null);
    }
    sourceIdentities.current = next;
  }, [models, legacyStore]);

  useEffect(() => {
    if (!enabled) { setResult(EMPTY); return; }
    let active = true;
    const state = useViewerStore.getState();
    const refs = new Map<string, EntityRef>();
    // Keep the active product inside the extraction cap even for select-all.
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
    const highlighted = state.selectedDirectrixSegment;
    const highlightedKey = highlighted
      ? entityRefToString({ modelId: highlighted.modelId, expressId: highlighted.expressId }) : null;
    if (highlightedKey && !refs.has(highlightedKey)) {
      state.setSelectedDirectrixSegment(null);
    }
    // A highlighted source stays eligible under the selected-product cap.
    const orderedRefs = new Map<string, EntityRef>();
    if (highlightedKey) {
      const ref = refs.get(highlightedKey);
      if (ref) orderedRefs.set(highlightedKey, ref);
    }
    for (const [key, ref] of refs) orderedRefs.set(key, ref);
    const grouped = new Map<string, number[]>();
    const createdInOverlay: SelectedSweptDisk[] = [];
    const diagnostics: string[] = [];
    let selectedProducts = 0;
    let omittedProducts = 0;
    for (const ref of orderedRefs.values()) {
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
      if (state.mutationViews.get(ref.modelId)?.getNewEntity(ref.expressId)) {
        createdInOverlay.push({ ref, occurrences: [], diagnostics: [
          `product #${ref.expressId}: created in the overlay; no authored swept-disk source is available`,
        ] });
        continue;
      }
      if (selectedProducts >= MAX_SELECTED_PRODUCTS) {
        omittedProducts++;
        continue;
      }
      selectedProducts++;
      const ids = grouped.get(ref.modelId) ?? [];
      ids.push(ref.expressId);
      grouped.set(ref.modelId, ids);
    }
    if (omittedProducts > 0) diagnostics.push(
      `Selected centreline limited to ${MAX_SELECTED_PRODUCTS} products; ${omittedProducts} selected products were omitted`,
    );
    if (grouped.size === 0) {
      setResult({ items: createdInOverlay, loading: false, error: diagnostics.join('; ') || null });
      return () => { active = false; };
    }
    setResult({ items: [], loading: true, error: null });
    void Promise.all([...grouped].map(async ([modelId, ids]) => {
      const model = models.get(modelId) ?? (modelId === 'legacy' && legacyStore
        ? { id: 'legacy', ifcDataStore: legacyStore } : null);
      if (!model) return [];
      const products = await selectedSweptDiskCache.get(model, ids);
      return ids.map((expressId): SelectedSweptDisk => {
        const product = products.get(expressId);
        return { ref: { modelId, expressId }, occurrences: product?.occurrences ?? [], diagnostics: product?.diagnostics ?? [] };
      });
    })).then((groups) => {
      if (active) setResult({ items: [...groups.flat(), ...createdInOverlay], loading: false, error: diagnostics.join('; ') || null });
    }).catch((error: unknown) => {
      if (active) setResult({ items: [], loading: false, error: String(error) });
    });
    return () => { active = false; };
  }, [enabled, models, legacyStore, selectedIds, primaryId, selectedRefs, primaryRef,
    hidden, isolated, classFilter, lensHidden]);

  return result;
}
