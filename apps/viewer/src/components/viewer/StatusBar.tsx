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
import type { GeometryResult } from '@ifc-lite/geometry';

/** One loaded model's store paired with the geometry produced from it. */
interface CountedModel {
  store: IfcDataStore;
  geometry: GeometryResult | null | undefined;
}

export function StatusBar() {
  const { loading, geometryResult, ifcDataStore, models } = useIfc();
  const progress = useViewerStore((s) => s.progress);
  const error = useViewerStore((s) => s.error);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
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
        if (model.ifcDataStore) out.push({ store: model.ifcDataStore, geometry: model.geometryResult });
      }
      return out;
    }
    return ifcDataStore ? [{ store: ifcDataStore, geometry: geometryResult }] : [];
  }, [models, ifcDataStore, geometryResult]);

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
    for (const { store, geometry } of countedModels) {
      let physicalIds = physicalIdsRef.current.get(store);
      if (!physicalIds) {
        physicalIds = collectPhysicalEntityIds(store.entityIndex?.byType);
        physicalIdsRef.current.set(store, physicalIds);
      }
      total += countShapedObjects(physicalIds, {
        relationships: store.relationships as AggregationRelationships | undefined,
        meshedIds: collectMeshedIds(geometry),
      });
    }
    return total;
  }, [countedModels]);

  // `selectedStoreys` holds raw model-space expressIds (see HierarchyPanel's
  // `setStoreysSelection`), which may belong to ANY federated model, not just
  // the active one — `ifcDataStore` only tracks the active model
  // (`modelSlice.ts`). Resolve each id through the model whose own spatial
  // hierarchy actually contains it as a storey. Mirrors ViewportOverlays'
  // storey-name lookup (#3506) for the same reason: a non-active model's
  // storey must not be counted against the active model's hierarchy.
  //
  // `byStorey` is the raw `IfcRelContainedInSpatialStructure` membership — no
  // schema filter and no geometry filter — so counting its length answered a
  // different question from every other "objects" number in the app, and a
  // storey holding a group-artifact proxy with `Representation = $` read one
  // higher than the trees (#4655).
  const visibleElements = useMemo(() => {
    if (selectedStoreys.size === 0) return totalObjects;
    const predicates = new Map<IfcDataStore, (expressId: number) => boolean>();
    let count = 0;
    let resolvedAnyStorey = false;
    for (const storeyId of selectedStoreys) {
      const owner = countedModels.find((m) => m.store.spatialHierarchy?.byStorey.has(storeyId));
      const storeyElements = owner?.store.spatialHierarchy?.byStorey.get(storeyId);
      if (!owner || !storeyElements) continue;
      resolvedAnyStorey = true;
      let isObject = predicates.get(owner.store);
      if (!isObject) {
        isObject = createObjectPredicate({
          getTypeName: (expressId) => owner.store.entities.getTypeName(expressId),
          relationships: owner.store.relationships as AggregationRelationships | undefined,
          meshedIds: collectMeshedIds(owner.geometry),
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
    return resolvedAnyStorey ? count : totalObjects;
  }, [selectedStoreys, countedModels, totalObjects]);

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
          <span>{formatNumber(geometryResult?.totalTriangles ?? 0)} tris</span>
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
