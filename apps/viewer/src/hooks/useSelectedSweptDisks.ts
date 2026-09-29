/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import type { SweptDiskDescriptions } from '@ifc-lite/geometry';
import { useViewerStore, type EntityRef } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { selectedSweptDiskCache, sourceIdentity, type AnalyticSourceModel } from '@/lib/analytic/swept-disk-cache';
import { loadSelectedSourceGroups, selectedSourceProducts } from '@/lib/analytic/selected-source-products';

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

/** One selection query shared by drawing and the later source-geometry inspector. */
export function useSelectedSweptDisks(enabled: boolean): SelectedSweptDisksState {
  const models = useViewerStore((state) => state.models);
  const legacyStore = useViewerStore((state) => state.ifcDataStore);
  const selectedIds = useViewerStore((state) => state.selectedEntityIds);
  const primaryId = useViewerStore((state) => state.selectedEntityId);
  const selectedRefs = useViewerStore((state) => state.selectedEntitiesSet);
  const primaryRef = useViewerStore((state) => state.selectedEntity);
  const highlightedSegment = useViewerStore((state) => state.selectedDirectrixSegment);
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
      const source = sourceIdentity(model);
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
    const priority = highlightedSegment
      ? { modelId: highlightedSegment.modelId, expressId: highlightedSegment.expressId } : null;
    const { grouped, overlayRefs, diagnostics, priorityMissing } = selectedSourceProducts(state, 'centreline', resolveEntityRef, priority);
    if (priorityMissing) state.setSelectedDirectrixSegment(null);
    const createdInOverlay: SelectedSweptDisk[] = overlayRefs.map((ref) => ({ ref, occurrences: [], diagnostics: [
      `product #${ref.expressId}: created in the overlay; no authored swept-disk source is available`,
    ] }));
    if (grouped.size === 0) {
      setResult({ items: createdInOverlay, loading: false, error: diagnostics.join('; ') || null });
      return () => { active = false; };
    }
    setResult({ items: [], loading: true, error: null });
    void loadSelectedSourceGroups(grouped, async (modelId, ids) => {
      const model = models.get(modelId) ?? (modelId === 'legacy' && legacyStore
        ? { id: 'legacy', ifcDataStore: legacyStore } : null);
      if (!model) return [];
      const products = await selectedSweptDiskCache.get(model, ids);
      return ids.map((expressId): SelectedSweptDisk => {
        const product = products.get(expressId);
        return { ref: { modelId, expressId }, occurrences: product?.occurrences ?? [], diagnostics: product?.diagnostics ?? [] };
      });
    }).then(({ items, errors }) => {
      if (active) setResult({ items: [...items, ...createdInOverlay], loading: false,
        error: [...diagnostics, ...errors].join('; ') || null });
    }).catch((error: unknown) => {
      if (active) setResult({ items: [], loading: false, error: String(error) });
    });
    return () => { active = false; };
  }, [enabled, models, legacyStore, selectedIds, primaryId, selectedRefs, primaryRef, highlightedSegment,
    hidden, isolated, classFilter, lensHidden]);

  return result;
}
