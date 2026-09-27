/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef, useState, useEffect } from 'react';
import { Boxes, CheckCircle2, AlertCircle, Layers } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import { formatNumber } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { selectActiveLoadProgress, selectLoadCanceller } from '@/store/slices/loadingSlice';
import { useTranslation } from '@/i18n';
import { useIfc } from '@/hooks/useIfc';
import { useWebGPU } from '@/hooks/useWebGPU';
import { useViewportStatusSummary } from '@/hooks/useViewportStatusSummary';
import { FlavorIndicator } from '@/components/extensions/FlavorIndicator';
import { StatusBarPresentationButton } from './StatusBarPresentationButton';
import { FpsMemoryStats, TriangleCount } from './PerformanceStats';
import { FlavorDialog } from '@/components/extensions/FlavorDialog';
import { collectEffectivePhysicalEntityIds } from '@/lib/physical-objects';
import { collectMeshedIds, countShapedObjects, createShapePredicate } from '@/lib/object-count';
import type { AggregationRelationships } from '@/utils/aggregation';
import type { IfcDataStore } from '@ifc-lite/parser';
import { fromGlobalIdFromModels, toGlobalIdFromModels } from '@/store/globalId';
import type { EntityRef } from '@/store/types';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { LEGACY_MODEL_ID, LEGACY_MUTATION_MODEL_ID } from '@/sdk/adapters/model-compat';
/** One loaded model's store paired with the geometry produced from it. */
interface CountedModel {
  modelId: string;
  store: IfcDataStore;
  meshedIds: Set<number>;
  geometryReady: boolean;
}

export function StatusBar() {
  const { t } = useTranslation();
  const { loading, geometryResult, ifcDataStore, models } = useIfc();
  const progress = useViewerStore(selectActiveLoadProgress);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const activeStorey = useViewerStore((s) => s.activeStorey);
  const selectedEntities = useViewerStore((s) => s.selectedEntities);
  const activeStreamCanceller = useViewerStore(selectLoadCanceller);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const showPerformanceStats = useViewerStore((s) => s.showPerformanceStats);
  const webgpu = useWebGPU();
  // The storey pill and the hidden/ghosted count moved here from
  // `ViewportOverlays` (#5504, charter #5478 item 22); mobile keeps its own
  // copy since it has no status bar (`ViewerLayout.tsx`'s
  // `{!isMobile && <StatusBar />}`).
  const { storeyNames, objectCounts } = useViewportStatusSummary();

  const [flavorDialogOpen, setFlavorDialogOpen] = useState(false);
  /** Deep-link from Command Palette → "Manage flavors…". */
  const flavorDialogRequested = useViewerStore((s) => s.flavorDialogRequested);
  const setFlavorDialogRequested = useViewerStore((s) => s.setFlavorDialogRequested);
  useEffect(() => {
    if (flavorDialogRequested) {
      setFlavorDialogOpen(true);
      setFlavorDialogRequested(false);
    }
  }, [flavorDialogRequested, setFlavorDialogRequested]);

  // Every model whose objects this bar speaks for, paired with its own
  // geometry. Federated models each carry their own store and meshes; legacy
  // single-model mode has one pair on the top-level hook.
  const countedModels = useMemo<CountedModel[]>(() => {
    if (models.size > 0) {
      const out: CountedModel[] = [];
      for (const model of models.values()) {
        if (!model.ifcDataStore) continue;
        const toLocalId = (id: number): number => {
          const ref = fromGlobalIdFromModels(models, id);
          return ref?.modelId === model.id ? ref.expressId : id;
        };
        out.push({
          modelId: model.id,
          store: model.ifcDataStore,
          meshedIds: collectMeshedIds(model.geometryResult, toLocalId),
          geometryReady: model.geometryResult != null,
        });
      }
      return out;
    }
    return ifcDataStore ? [{
      modelId: 'legacy',
      store: ifcDataStore,
      meshedIds: collectMeshedIds(geometryResult),
      geometryReady: geometryResult != null,
    }] : [];
  }, [models, ifcDataStore, geometryResult]);

  // PERF: `state.models` is a NEW Map on every streaming batch commit
  // (`appendGeometryBatch` in dataSlice.ts rebuilds it to swap one model's
  // geometryResult), so nothing memoised on it survives a stream. A model's
  // `ifcDataStore` identity IS stable across those commits, so the expensive
  // half — the schema walk over the whole effective entity set — is cached
  // per store, view and mutation version. Streaming only reruns the cheap
  // mesh-set lookup; an edit invalidates the physical-id set.
  const physicalIdsRef = useRef(new WeakMap<IfcDataStore, Map<string, {
    view: MutablePropertyView | null; version: number; ids: Set<number>;
  }>>());
  const physicalIdsByModel = useMemo(() => {
    const result = new Map<string, Set<number>>();
    for (const { modelId, store } of countedModels) {
      const view = models.size > 0 ? mutationViews.get(modelId) ?? null
        : mutationViews.get(LEGACY_MUTATION_MODEL_ID) ?? mutationViews.get(LEGACY_MODEL_ID) ?? null;
      let byModel = physicalIdsRef.current.get(store);
      if (!byModel) {
        byModel = new Map();
        physicalIdsRef.current.set(store, byModel);
      }
      let cached = byModel.get(modelId);
      if (!cached || cached.view !== view || cached.version !== mutationVersion) {
        cached = { view, version: mutationVersion, ids: collectEffectivePhysicalEntityIds(store, view) };
        byModel.set(modelId, cached);
      }
      result.set(modelId, cached.ids);
    }
    return result;
  }, [countedModels, models.size, mutationViews, mutationVersion]);
  const totalObjects = useMemo(() => {
    let total = 0;
    for (const { modelId, store, meshedIds, geometryReady } of countedModels) {
      const physicalIds = physicalIdsByModel.get(modelId) ?? new Set<number>();
      total += countShapedObjects(physicalIds, {
        relationships: store.relationships as AggregationRelationships | undefined,
        meshedIds,
        geometryReady,
      });
    }
    return total;
  }, [countedModels, physicalIdsByModel]);

  // `selectedStoreys` can contain legacy/local ids from HierarchyPanel or
  // renderer/global ids from other store clients. Resolve global ids through
  // the canonical federation helper. For local ids, the model-aware
  // `activeStorey` disambiguates a single row and `selectedEntities` preserves
  // every constituent of a unified row whose local ids collide.
  //
  // `byStorey` is the raw `IfcRelContainedInSpatialStructure` membership — no
  // schema filter and no geometry filter — so counting its length answered a
  // different question from every other "objects" number in the app, and a
  // storey holding a group-artifact proxy with `Representation = $` read one
  // higher than the trees (#4655).
  const visibleElements = useMemo(() => {
    if (selectedStoreys.size === 0) return totalObjects;
    const modelsById = new Map(countedModels.map((model) => [model.modelId, model]));
    const selectedRefs = new Map<string, EntityRef>();
    const addStoreyRef = (ref: EntityRef): boolean => {
      const model = modelsById.get(ref.modelId);
      if (!model?.store.spatialHierarchy?.byStorey.has(ref.expressId)) return false;
      selectedRefs.set(`${ref.modelId}:${ref.expressId}`, ref);
      return true;
    };
    const selectionMatchesRef = (selection: number, ref: EntityRef): boolean =>
      selection === ref.expressId ||
      selection === toGlobalIdFromModels(models, ref.modelId, ref.expressId);

    for (const storeyId of selectedStoreys) {
      const explicitRefs = selectedEntities.filter((ref) => selectionMatchesRef(storeyId, ref));
      let addedExplicitRef = false;
      for (const ref of explicitRefs) {
        if (addStoreyRef(ref)) addedExplicitRef = true;
      }
      if (addedExplicitRef) continue;
      if (activeStorey && selectionMatchesRef(storeyId, activeStorey) && addStoreyRef(activeStorey)) {
        continue;
      }
      const globalRef = fromGlobalIdFromModels(models, storeyId);
      if (globalRef && addStoreyRef(globalRef)) continue;
      // Legacy/raw selection with no model-aware companion. Preserve the old
      // fallback, but include every matching model rather than silently taking
      // the first colliding local id.
      for (const model of countedModels) {
        addStoreyRef({ modelId: model.modelId, expressId: storeyId });
      }
    }

    const predicates = new Map<string, (expressId: number) => boolean>();
    let count = 0;
    for (const { modelId, expressId: storeyId } of selectedRefs.values()) {
      const owner = modelsById.get(modelId);
      const storeyElements = owner?.store.spatialHierarchy?.byStorey.get(storeyId);
      if (!owner || !storeyElements) continue;
      let hasShape = predicates.get(modelId);
      if (!hasShape) {
        hasShape = createShapePredicate({
          relationships: owner.store.relationships as AggregationRelationships | undefined,
          meshedIds: owner.meshedIds,
          geometryReady: owner.geometryReady,
        });
        predicates.set(modelId, hasShape);
      }
      const physicalIds = physicalIdsByModel.get(modelId);
      for (const expressId of storeyElements) {
        if (physicalIds?.has(expressId) && hasShape(expressId)) count++;
      }
    }
    // A selection naming no storey this session can resolve says nothing about
    // the model — fall back to the whole-model total. A storey that resolves
    // and genuinely holds no objects reports 0, which is the answer.
    return selectedRefs.size > 0 ? count : totalObjects;
  }, [selectedStoreys, activeStorey, selectedEntities, countedModels, models, physicalIdsByModel, totalObjects]);

  return (
    <div className="h-7 px-3 border-t bg-muted/30 flex items-center justify-between text-xs text-muted-foreground">
      {/* Left: Status */}
      <div className="flex items-center gap-3">
        {/* A load error shows once, in the viewport's load-error card
            (#5851) — not here too. */}
        {loading ? (
          <span className="text-primary">{progress?.phase || t('shellChrome.statusBar.loadingFallback')}</span>
        ) : (
          <span>{t('shellChrome.statusBar.ready')}</span>
        )}
        {/* Cancel: shown while a model load (#5849) or point-cloud stream
            has published a canceller; the loading card uses the same selector. */}
        {activeStreamCanceller && (
          <button
            type="button"
            onClick={() => activeStreamCanceller()}
            className="px-2 py-0.5 rounded border border-destructive/40 text-destructive text-[10px] uppercase tracking-wider hover:bg-destructive hover:text-destructive-foreground transition-colors"
            title={t('shellChrome.statusBar.cancelStreamTitle')}
          >
            {t('shellChrome.statusBar.cancelButton')}
          </button>
        )}

        {/* Storey pill — moved from `ViewportOverlays` (#5504). Passive, so a
            model with no storey selection carries no extra chrome. */}
        {storeyNames && storeyNames.length > 0 && (
          <>
            <Separator orientation="vertical" className="h-3.5" />
            <div className="flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-primary" />
              <span className="font-medium text-foreground">
                {storeyNames.length === 1
                  ? storeyNames[0]
                  : t('viewportLighting.overlays.storeyCount', { count: storeyNames.length })}
              </span>
            </div>
          </>
        )}

        {/* Hidden/ghosted count — moved from `ViewportOverlays` (#5504).
            Reports what is WITHHELD, not a ratio: see that component's
            history for why. */}
        {(objectCounts.hidden > 0 || objectCounts.ghosted > 0) && (
          <>
            <Separator orientation="vertical" className="h-3.5" />
            <span className="tabular-nums">
              {[
                objectCounts.hidden > 0 && t('shellChrome.statusBar.hiddenCount', { count: objectCounts.hidden }),
                objectCounts.ghosted > 0 && t('shellChrome.statusBar.ghostedCount', { count: objectCounts.ghosted }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </>
        )}
      </div>

      {/* Center: Model Stats */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Boxes className="h-3.5 w-3.5" />
          <span>
            {formatNumber(visibleElements)}
            {selectedStoreys.size > 0 && totalObjects !== visibleElements && (
              <span className="opacity-60"> / {formatNumber(totalObjects)}</span>
            )}
            {' '}{t('shellChrome.statusBar.elementsCount', { count: visibleElements })}
          </span>
        </div>

        {showPerformanceStats && (
          <>
            <Separator orientation="vertical" className="h-3.5" />
            <TriangleCount models={models} geometryResult={geometryResult} />
          </>
        )}
      </div>

      {/* Right: Performance */}
      <div className="flex items-center gap-3">
        {showPerformanceStats && (
          <>
            <FpsMemoryStats />
            <Separator orientation="vertical" className="h-3.5" />
          </>
        )}

        <div className="flex items-center gap-1">
          {webgpu.checking ? (
            <Spinner size="sm" className="text-zinc-400" />
          ) : webgpu.supported ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-[#f7768e]" />
          )}
          <span className={!webgpu.supported && !webgpu.checking ? 'text-[#f7768e]' : ''}>
            {t(
              webgpu.checking
                ? 'shellChrome.statusBar.webgpuChecking'
                : webgpu.supported
                  ? 'shellChrome.statusBar.webgpuLabel'
                  : 'shellChrome.statusBar.noWebgpuLabel',
            )}
          </span>
        </div>

        <Separator orientation="vertical" className="h-3.5" />

        <StatusBarPresentationButton />
        <Separator orientation="vertical" className="h-3.5" />
        <FlavorIndicator onClick={() => setFlavorDialogOpen(true)} />

        <Separator orientation="vertical" className="h-3.5" />

        <span className="opacity-60">{t('shellChrome.statusBar.appVersion', { version: __APP_VERSION__ })}</span>

        <Separator orientation="vertical" className="h-3.5" />

        <a
          href="https://ifclite.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="opacity-60 hover:opacity-100 hover:text-primary transition-opacity"
          aria-label={t('shellChrome.statusBar.ifcliteAriaLabel')}
        >
          {t('shellChrome.statusBar.ifcliteLinkLabel')}
        </a>
      </div>

      <FlavorDialog open={flavorDialogOpen} onClose={() => setFlavorDialogOpen(false)} />
    </div>
  );
}
