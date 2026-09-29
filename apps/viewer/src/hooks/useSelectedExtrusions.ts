/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { useViewerStore, type EntityRef } from '@/store';
import { selectedExtrusionCache, type ProductExtrusions } from '@/lib/analytic/extrusion-cache';
import type { AnalyticSourceModel } from '@/lib/analytic/swept-disk-cache';
import { selectedSourceProducts } from '@/lib/analytic/selected-source-products';

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
    const { grouped, overlayRefs, diagnostics } = selectedSourceProducts(state, 'extrusion inspection');
    const overlayItems: SelectedExtrusion[] = overlayRefs.map((ref) => ({ ref, product: {
      occurrences: [], lengthUnitScale: 1,
      diagnostics: [`product #${ref.expressId}: created in the overlay; no authored extrusion source is available`],
    } }));
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
