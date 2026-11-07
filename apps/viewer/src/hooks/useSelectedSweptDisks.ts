/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SweptDiskDescriptions } from '@ifc-lite/geometry';
import { useViewerStore, type EntityRef, type ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { sourceIdentity, type AnalyticSourceModel } from '@/lib/analytic/analytic-product-cache';
import { selectedSweptDiskCache } from '@/lib/analytic/swept-disk-cache';
import { loadSelectedSourceGroups, selectedSourceProducts, withoutMeasuredOverlayItems } from '@/lib/analytic/selected-source-products';
import { selectedModelVisibility, sourceModelFrame } from '@/lib/analytic/source-model-key';

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
  /**
   * False once a newer query (selection, visibility, highlight or models)
   * has superseded the one this state answers; absent on the idle state.
   */
  current?: () => boolean;
}

const EMPTY: SelectedSweptDisksState = { items: [], loading: false, error: null };

/** The products whose swept disks the centreline query loads: selection, visibility and the cap, highlighted product first. */
export function selectedSweptDiskProducts(state: ViewerState) {
  const highlighted = state.selectedDirectrixSegment;
  const priority = highlighted ? { modelId: highlighted.modelId, expressId: highlighted.expressId } : null;
  return selectedSourceProducts(state, 'centreline', resolveEntityRef, priority);
}

/**
 * The model inputs of the query and the curves it feeds, as keys that keep
 * their identity while nothing they read changes: `frame` places the curves,
 * `shown` is the visibility of the models the selection reaches. A collapsed
 * or renamed model row, or an unrelated model toggled, changes neither (#9158).
 * `shown` resolves the selection, so it is empty while the caller is off.
 */
export function useSourceModelKeys(enabled: boolean): { frame: readonly unknown[]; shown: readonly unknown[] } {
  const frame = useViewerStore(useShallow((state) => sourceModelFrame(state.models)));
  const models = useViewerStore((state) => state.models);
  const selectedIds = useViewerStore((state) => state.selectedEntityIds);
  const primaryId = useViewerStore((state) => state.selectedEntityId);
  const selectedRefs = useViewerStore((state) => state.selectedEntitiesSet);
  const primaryRef = useViewerStore((state) => state.selectedEntity);
  const stable = useShallow((key: unknown[]) => key);
  const shown = stable(useMemo(() => (enabled ? selectedModelVisibility(useViewerStore.getState()) : []),
    [enabled, models, selectedIds, primaryId, selectedRefs, primaryRef]));
  return { frame, shown };
}

/** One selection query shared by drawing and the later source-geometry inspector. */
export function useSelectedSweptDisks(enabled: boolean): SelectedSweptDisksState {
  const models = useViewerStore((state) => state.models);
  // In a federation `ifcDataStore` only mirrors the active model; the query reads it only without one.
  const legacyStore = useViewerStore((state) => state.models.size === 0 ? state.ifcDataStore : null);
  const { frame, shown } = useSourceModelKeys(enabled);
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
    const current = () => active;
    const state = useViewerStore.getState();
    const { grouped, overlayRefs, diagnostics, priorityMissing } = selectedSweptDiskProducts(state);
    if (priorityMissing) state.setSelectedDirectrixSegment(null);
    const createdInOverlay: SelectedSweptDisk[] = overlayRefs.map((ref) => ({ ref, occurrences: [], diagnostics: [
      `product #${ref.expressId}: created in the overlay; no authored swept-disk source is available`,
    ] }));
    if (grouped.size === 0) {
      setResult({ items: createdInOverlay, loading: false, error: diagnostics.join('; ') || null, current });
      return () => { active = false; };
    }
    setResult({ items: [], loading: true, error: null, current });
    void loadSelectedSourceGroups(grouped, async (modelId, ids) => {
      const model = state.models.get(modelId) ?? (modelId === 'legacy' && legacyStore
        ? { id: 'legacy', ifcDataStore: legacyStore } : null);
      if (!model) return [];
      const products = await selectedSweptDiskCache.get(model, ids);
      return ids.map((expressId): SelectedSweptDisk => {
        const product = products.get(expressId);
        return { ref: { modelId, expressId }, occurrences: product?.occurrences ?? [], diagnostics: product?.diagnostics ?? [] };
      });
    }).then(({ items, errors }) => {
      if (active) setResult({ items: [...items, ...createdInOverlay], loading: false,
        error: [...diagnostics, ...errors].join('; ') || null, current });
    }).catch((error: unknown) => {
      if (active) setResult({ items: [], loading: false, error: String(error), current });
    });
    return () => { active = false; };
  }, [enabled, frame, shown, legacyStore, selectedIds, primaryId, selectedRefs, primaryRef, highlightedSegment,
    hidden, isolated, classFilter, lensHidden]);

  const mutationVersion = useViewerStore((state) => state.mutationVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the version is what a set gained or lost changes.
  return useMemo(() => withoutMeasuredOverlayItems(useViewerStore.getState(), result), [result, mutationVersion]);
}
