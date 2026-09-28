/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared derivation behind the storey-name pill and the hidden/ghosted
 * count — moved off the 3D canvas (`ViewportOverlays`, desktop) and into
 * `StatusBar` (#5504, charter #5478 item 22), and still used, mobile-only,
 * by `ViewportOverlays` itself (the status bar is hidden on mobile to
 * maximize viewport space — `ViewerLayout.tsx`'s `{!isMobile && <StatusBar
 * />}` — so mobile has nowhere else to show either one).
 *
 * One hook, one derivation: before this, `ViewportOverlays` alone computed
 * both numbers; duplicating that logic per consumer would let the desktop
 * and mobile readings drift.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import {
  collectEffectivePhysicalEntityIds,
  countPhysicalObjects,
  type PhysicalObjectCounts,
} from '@/lib/physical-objects';
import { LEGACY_MODEL_ID, LEGACY_MUTATION_MODEL_ID } from '@/sdk/adapters/model-compat';
import { effectiveContextType } from '@/components/viewer/EntityContextMenu.effective-selection';
import { effectiveAttribute } from '@/lib/document/effective-binding-fields';
import { toGlobalIdFromModels } from '@/store/globalId';
import { resolveEntityRef } from '@/store/resolveEntityRef';

export interface ViewportStatusSummary {
  /** Names of every selected storey, or `null` when none is selected. */
  storeyNames: string[] | null;
  /** Physical-object visibility counts for the active model. */
  objectCounts: PhysicalObjectCounts;
}

export function useViewportStatusSummary(): ViewportStatusSummary {
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const activeStorey = useViewerStore((s) => s.activeStorey);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const classFilter = useViewerStore((s) => s.classFilter);
  const ghostExceptEntities = useViewerStore((s) => s.ghostExceptEntities);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const { ifcDataStore, models, activeModelId } = useIfc();

  // Selections may be local ids or renderer ids. Prefer the explicit model
  // selection, then the store-backed resolver (which sees authored ids), and
  // finally probe each model for legacy local selections.
  const storeyNames = useMemo(
    () => (selectedStoreys.size > 0 && (ifcDataStore || models.size > 0)
      ? Array.from(selectedStoreys).map((id) => {
          const nameFor = (modelId: string, expressId: number): string | null => {
            const model = models.get(modelId);
            const store = model?.ifcDataStore ?? (models.size === 0 ? ifcDataStore : null);
            if (!store) return null;
            const view = models.size > 0 ? mutationViews.get(modelId) ?? null
              : mutationViews.get(LEGACY_MUTATION_MODEL_ID) ?? mutationViews.get(LEGACY_MODEL_ID) ?? null;
            if (view?.isDeleted(expressId) || effectiveContextType(store, view, expressId) !== 'IfcBuildingStorey') return null;
            return effectiveAttribute({ id: modelId, name: model?.name ?? '', store, view: view ?? undefined }, expressId, 'Name') || null;
          };
          const activeMatches = activeStorey && (id === activeStorey.expressId
            || id === toGlobalIdFromModels(models, activeStorey.modelId, activeStorey.expressId));
          if (activeMatches) {
            const name = nameFor(activeStorey.modelId, activeStorey.expressId);
            if (name) return name;
          }
          const ref = resolveEntityRef(id);
          const resolved = nameFor(ref.modelId, ref.expressId);
          if (resolved) return resolved;
          for (const modelId of models.keys()) {
            const name = nameFor(modelId, id);
            if (name) return name;
          }
          return `Storey #${id}`;
        })
      : null),
    [selectedStoreys, activeStorey, ifcDataStore, models, mutationViews, mutationVersion],
  );

  // Physical objects in the active model — include live creates, deletes and
  // retypes. Keep the scan off camera-driven renders; edits bump the version.
  const countModelId = Array.from(models.values()).find((model) => model.ifcDataStore === ifcDataStore)?.id
    ?? activeModelId;
  const countView = models.size > 0
    ? (countModelId ? mutationViews.get(countModelId) : null)
    : mutationViews.get(LEGACY_MUTATION_MODEL_ID) ?? mutationViews.get(LEGACY_MODEL_ID);
  const physicalIds = useMemo(
    () => (ifcDataStore ? collectEffectivePhysicalEntityIds(ifcDataStore, countView) : new Set<number>()),
    [ifcDataStore, countView, mutationVersion],
  );

  const objectCounts = useMemo(
    () => countPhysicalObjects(physicalIds, {
      hiddenEntities,
      isolatedEntities,
      classFilter,
      ghostExceptEntities,
    }),
    [physicalIds, hiddenEntities, isolatedEntities, classFilter, ghostExceptEntities],
  );

  return { storeyNames, objectCounts };
}
