/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef, useState, useEffect } from 'react';
import { Boxes, Triangle, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { formatNumber, formatBytes } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { useWebGPU } from '@/hooks/useWebGPU';
import { FlavorIndicator } from '@/components/extensions/FlavorIndicator';
import { FlavorDialog } from '@/components/extensions/FlavorDialog';
import { collectPhysicalEntityIds } from '@/lib/physical-objects';
import { collectMeshedIds, countShapedObjects, createObjectPredicate } from '@/lib/object-count';
import type { AggregationRelationships } from '@/utils/aggregation';
import type { IfcDataStore } from '@ifc-lite/parser';
import { fromGlobalIdFromModels, toGlobalIdFromModels } from '@/store/globalId';
import type { EntityRef } from '@/store/types';

/** One loaded model's store paired with the geometry produced from it. */
interface CountedModel {
  modelId: string;
  store: IfcDataStore;
  meshedIds: Set<number>;
  geometryReady: boolean;
}

export function StatusBar() {
  const { loading, geometryResult, ifcDataStore, models } = useIfc();
  const progress = useViewerStore((s) => s.progress);
  const error = useViewerStore((s) => s.error);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const activeStorey = useViewerStore((s) => s.activeStorey);
  const selectedEntities = useViewerStore((s) => s.selectedEntities);
  const activeStreamCanceller = useViewerStore((s) => s.activeStreamCanceller);
  const webgpu = useWebGPU();

  const [fps, setFps] = useState(60);
  const [memory, setMemory] = useState(0);
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

  // FPS counter (simplified)
  useEffect(() => {
    let frameCount = 0;
    let lastTime = performance.now();
    let animationId: number;

    const measureFps = () => {
      frameCount++;
      const currentTime = performance.now();

      if (currentTime - lastTime >= 1000) {
        setFps(frameCount);
        frameCount = 0;
        lastTime = currentTime;
      }

      animationId = requestAnimationFrame(measureFps);
    };

    animationId = requestAnimationFrame(measureFps);
    return () => cancelAnimationFrame(animationId);
  }, []);

  // Memory usage (if available)
  useEffect(() => {
    const updateMemory = () => {
      // Avoid `as any` per repo TypeScript rules — narrow to a concrete shape.
      // `performance.memory` is Chromium-only and absent from lib.dom.
      type PerformanceWithMemory = Performance & {
        memory?: { usedJSHeapSize: number };
      };
      const memoryInfo = (performance as PerformanceWithMemory).memory;
      if (memoryInfo) {
        setMemory(memoryInfo.usedJSHeapSize);
      }
    };

    updateMemory();
    const interval = setInterval(updateMemory, 2000);
    return () => clearInterval(interval);
  }, []);

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

  const triangleCount = useMemo(() => {
    if (models.size === 0) return geometryResult?.totalTriangles ?? 0;
    let total = 0;
    for (const model of models.values()) {
      total += model.geometryResult?.totalTriangles ?? 0;
    }
    return total;
  }, [models, geometryResult]);

  // PERF: `state.models` is a NEW Map on every streaming batch commit
  // (`appendGeometryBatch` in dataSlice.ts rebuilds it to swap one model's
  // geometryResult), so nothing memoised on it survives a stream. A model's
  // `ifcDataStore` identity IS stable across those commits, so the expensive
  // half — the schema walk over the whole entity index — is cached per store
  // and only the cheap half (a mesh-set lookup per physical id) re-runs as
  // geometry arrives. Keyed on the store, so it lives exactly as long as the
  // model does — the same store-identity scope ViewportOverlays' badge uses
  // for the same walk.
  const physicalIdsRef = useRef(new WeakMap<IfcDataStore, Set<number>>());
  const totalObjects = useMemo(() => {
    let total = 0;
    for (const { store, meshedIds, geometryReady } of countedModels) {
      let physicalIds = physicalIdsRef.current.get(store);
      if (!physicalIds) {
        physicalIds = collectPhysicalEntityIds(store.entityIndex?.byType);
        physicalIdsRef.current.set(store, physicalIds);
      }
      total += countShapedObjects(physicalIds, {
        relationships: store.relationships as AggregationRelationships | undefined,
        meshedIds,
        geometryReady,
      });
    }
    return total;
  }, [countedModels]);

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

    const predicates = new Map<IfcDataStore, (expressId: number) => boolean>();
    let count = 0;
    for (const { modelId, expressId: storeyId } of selectedRefs.values()) {
      const owner = modelsById.get(modelId);
      const storeyElements = owner?.store.spatialHierarchy?.byStorey.get(storeyId);
      if (!owner || !storeyElements) continue;
      let isObject = predicates.get(owner.store);
      if (!isObject) {
        isObject = createObjectPredicate({
          getTypeName: (expressId) => owner.store.entities.getTypeName(expressId),
          relationships: owner.store.relationships as AggregationRelationships | undefined,
          meshedIds: owner.meshedIds,
          geometryReady: owner.geometryReady,
        });
        predicates.set(owner.store, isObject);
      }
      for (const expressId of storeyElements) {
        if (isObject(expressId)) count++;
      }
    }
    // A selection naming no storey this session can resolve says nothing about
    // the model — fall back to the whole-model total. A storey that resolves
    // and genuinely holds no objects reports 0, which is the answer.
    return selectedRefs.size > 0 ? count : totalObjects;
  }, [selectedStoreys, activeStorey, selectedEntities, countedModels, models, totalObjects]);

  return (
    <div className="h-7 px-3 border-t bg-muted/30 flex items-center justify-between text-xs text-muted-foreground">
      {/* Left: Status */}
      <div className="flex items-center gap-3">
        {loading ? (
          <span className="text-primary">{progress?.phase || 'Loading...'}</span>
        ) : error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <span>Ready</span>
        )}
        {/* Cancel button — only visible while a long-running stream
            (LAS/LAZ/PLY/PCD/E57) is in flight. The loader hooks
            register/clear the canceller around `await ingest.done`. */}
        {activeStreamCanceller && (
          <button
            type="button"
            onClick={() => activeStreamCanceller()}
            className="px-2 py-0.5 rounded border border-destructive/40 text-destructive text-[10px] uppercase tracking-wider hover:bg-destructive hover:text-destructive-foreground transition-colors"
            title="Cancel the active point cloud stream"
          >
            Cancel
          </button>
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
            {' '}elements
          </span>
        </div>

        <Separator orientation="vertical" className="h-3.5" />

        <div className="flex items-center gap-1.5">
          <Triangle className="h-3.5 w-3.5" />
          <span>{formatNumber(triangleCount)} tris</span>
        </div>
      </div>

      {/* Right: Performance */}
      <div className="flex items-center gap-3">
        <span className={fps < 30 ? 'text-destructive' : fps < 50 ? 'text-yellow-500' : ''}>
          {fps} FPS
        </span>

        {memory > 0 && (
          <>
            <Separator orientation="vertical" className="h-3.5" />
            <span>{formatBytes(memory)}</span>
          </>
        )}

        <Separator orientation="vertical" className="h-3.5" />

        <div className="flex items-center gap-1">
          {webgpu.checking ? (
            <Loader2 className="h-3.5 w-3.5 text-zinc-400 animate-spin" />
          ) : webgpu.supported ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-[#f7768e]" />
          )}
          <span className={!webgpu.supported && !webgpu.checking ? 'text-[#f7768e]' : ''}>
            {webgpu.checking ? 'Checking...' : webgpu.supported ? 'WebGPU' : 'No WebGPU'}
          </span>
        </div>

        <Separator orientation="vertical" className="h-3.5" />

        <FlavorIndicator onClick={() => setFlavorDialogOpen(true)} />

        <Separator orientation="vertical" className="h-3.5" />

        <span className="opacity-60">v{__APP_VERSION__}</span>

        <Separator orientation="vertical" className="h-3.5" />

        <a
          href="https://ifclite.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="opacity-60 hover:opacity-100 hover:text-primary transition-opacity"
          aria-label="Visit ifclite.dev — about, docs, and packages"
        >
          ifclite.dev →
        </a>
      </div>

      <FlavorDialog open={flavorDialogOpen} onClose={() => setFlavorDialogOpen(false)} />
    </div>
  );
}
