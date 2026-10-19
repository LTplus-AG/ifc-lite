/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for multi-model federation operations
 * Handles addModel, removeModel, ID offset management, RTC alignment,
 * IFCX federated layer composition, and legacy model migration
 *
 * Extracted from useIfc.ts for better separation of concerns
 */

import { assertWorkflowOwner } from '@/lib/flow/run-session';
import type { ModelLoadOptions, FederationAddModelOptions } from './modelLoadOptions.js';
import { commitRealignmentFrame } from '@/lib/model-placement/realignment-frame';
import { useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore, type FederatedModel } from '../store/index.js';
import { chooseSharedRtcOffset } from '@ifc-lite/geometry/world-frame';
import { IfcQuery } from '@ifc-lite/query';
import type { IfcxDataStore } from './ingest/ifcxComposition.js';
export type { IfcxDataStore } from './ingest/ifcxComposition.js';
import { extractModelSpatialPlacement, findReferenceSpatialModel } from './ingest/federationAlign.js';
import { realignFederationModels } from './ingest/federationRealign.js';
import { withModelRotationsUnbaked } from '../components/viewer/useModelRotationSync.js';
import { convergeFederationRtcFrame } from './ingest/federationRtcRebase.js';
import { toast } from '../components/ui/toast.js';
import { acquireFederationLoadSlot, releaseFederationLoadSlot } from './federationLoadGate.js';
import { realignFederatedPointClouds } from './ingest/pointCloudFederationLifecycle.js';
import { showLoadError } from '@/lib/analytics';

/**
 * Hook providing multi-model federation operations
 * Includes addModel, removeModel, federated IFCX loading, overlay management,
 * and ID resolution helpers
 */
export function useIfcFederation(
  // The ONE canonical loader. Federated adds route through it (target
  // 'federated') so model #1 and model #N share an identical pipeline.
  loadFile: (
    file: File,
    target?: import('./useIfcLoader.js').LoadTarget,
    options?: ModelLoadOptions,
  ) => Promise<void>,
) {
  const {
    setLoading,
    setError,
    setProgress,
    setIfcDataStore,
    setGeometryResult,
    // Multi-model state and actions
    removeModel: storeRemoveModel,
    getModel,
    // Federation Registry helpers
    fromGlobalId,
    findModelForGlobalId,
    resolveGlobalIdFromModels,
  } = useViewerStore(useShallow((s) => ({
    setLoading: s.setLoading,
    setError: s.setError,
    setProgress: s.setProgress,
    setIfcDataStore: s.setIfcDataStore,
    setGeometryResult: s.setGeometryResult,
    removeModel: s.removeModel,
    getModel: s.getModel,
    fromGlobalId: s.fromGlobalId,
    findModelForGlobalId: s.findModelForGlobalId,
    resolveGlobalIdFromModels: s.resolveGlobalIdFromModels,
  })));

  // Per-call ownership token. Each addModel() bumps this; state writes
  // (loading/error/progress) in the catch block must compare back to
  // their captured value before mutating, so a cancelled load A doesn't
  // overwrite progress for a newer load B that started after A's abort.
  // Mirrors the same pattern in useIfcLoader.ts.
  const loadSessionRef = useRef(0), realignSessionRef = useRef(0);

  const reportError = (message: string, code: string, retry: (() => void) | null) => // #5851: retry required
    showLoadError(setError, useViewerStore.getState().setLastLoadRetry, message, code, retry);

  /**
   * Add a model to the federation (multi-model support)
   * Uses FederationRegistry to assign unique ID offsets - BULLETPROOF against ID collisions
   * Returns the model ID on success, null on failure
   */
  const addModel = useCallback(async (
    file: File,
    options?: FederationAddModelOptions
  ): Promise<string | null> => {
    assertWorkflowOwner(options?.workflowOwner);
    const modelId = options?.modelId ?? crypto.randomUUID();
    // Request order, not completion order, decides the RTC anchor of overlapping loads (#4897).
    const loadedAt = options?.loadedAt ?? Date.now();
    const addStart = performance.now();
    // Bump the per-call ownership token first so that any error path
    // (including the load gate) can compare against this captured value
    // before mutating shared loading/error/progress state.
    const currentSession = ++loadSessionRef.current;
    // Memory-aware load gate: if a previous federation load is still in
    // flight on this tab and admitting this one would exceed the device
    // memory budget, wait until headroom frees. Single-file loads never
    // wait. See `federationLoadGate.ts` for the budget formula. (#600)
    const fileSizeForGateMB = (typeof (file as File).size === 'number' ? (file as File).size : 0) / (1024 * 1024);
    const gateSlot = await acquireFederationLoadSlot(fileSizeForGateMB);
    try {
      // (Removed the legacy→Map migration: every model — including model #1 —
      // now registers in the FederationRegistry + models Map via loadFile's
      // upsertModel/finalizeModel, so a top-level-only "legacy" model can no
      // longer exist. See PR description for the audit.)
      setLoading(true);
      setError(null);
      setProgress({ phase: 'Loading file', percent: 0 });

      // Shared RTC origin: earliest existing model with a real anchor, or
      // `undefined` if none has one yet; the convergence after the load makes
      // THAT case order-independent too (#4897).
      const sharedRtcOffset = chooseSharedRtcOffset(useViewerStore.getState().models.values() as Iterable<FederatedModel>);

      // THE canonical load path. loadFile acquires bytes, detects format
      // (IFC / IFCX / GLB / point cloud), produces geometry through the single
      // GeometryProcessor pipeline, parses the data store, and — because the
      // target is federated — finalizeModel aligns to the anchor, offsets ids,
      // builds the spatial index, and registers the model via addModel. loadFile
      // awaits that finalize, so on return the model is already in the map.
      await loadFile(file, {
        kind: 'federated',
        modelId,
        name: options?.name,
        visible: options?.visible,
        collapsed: options?.collapsed,
        loadedAt,
        sharedRtcOffset,
      }, { sourceHandle: options?.sourceHandle, workflowOwner: options?.workflowOwner });

      // Before the session check: a superseded load still settled a model (#4897, `federationRtcRebase.ts`).
      if (useViewerStore.getState().models.has(modelId)) convergeFederationRtcFrame();
      if (loadSessionRef.current !== currentSession) return null;
      const registered = useViewerStore.getState().models.has(modelId);
      if (registered) {
        console.log(`[ifc-lite] Added model ${file.name} (${fileSizeForGateMB.toFixed(1)}MB) in ${(performance.now() - addStart).toFixed(0)}ms`);
      }
      return registered ? modelId : null;

    } catch (err) {
      // Only mutate shared loading/error/progress state if our session
      // is still the active one. A second addModel() that started after
      // we were cancelled has already taken over the spinner — we must
      // not overwrite it with our "Cancelled" state.
      const isCurrent = loadSessionRef.current === currentSession;
      // User-initiated cancel surfaces as an AbortError. Map it to a
      // benign "Cancelled" state so the federated path matches the
      // single-model loader rather than reporting a parse failure.
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.log('[useIfc] addModel cancelled by user');
        if (isCurrent) {
          setError(null);
          setProgress({ phase: 'Cancelled', percent: 0 });
          setLoading(false);
        }
        return null;
      }
      console.error('[useIfc] addModel failed:', err);
      if (isCurrent) {
        reportError(err instanceof Error ? err.message : 'Unknown error', 'federated_add_failed',
          () => { void addModel(file, options); });
        setLoading(false);
      }
      return null;
    } finally {
      releaseFederationLoadSlot(gateSlot);
    }
  }, [loadFile, setLoading, setError, setProgress]);

  /**
   * Re-apply federation alignment using the currently selected anchor
   * (`anchorModelIdOverride` from the store, falling back to earliest-loaded).
   *
   * Restores every model's geometry from its pre-alignment snapshot — the
   * anchor included, because it may have been aligned under a previous anchor
   * (#2007) — then re-runs alignment on the non-anchors. Models with no
   * geometry or no georeference are left in their own frame and counted as
   * skipped. Updates `federationAlignmentStatus` on every touched model so the
   * UI badges reflect the new state.
   *
   * The mechanics live in `ingest/federationRealign.ts`; what stays here is the
   * store and toast wiring.
   *
   * Per user preference: this is an explicit operation, not auto-triggered by
   * remove/reorder/anchor-change. Wire it to a "Re-align federation" button.
   */
  const realignFederation = useCallback(async (): Promise<void> => {
    const realignSession = ++realignSessionRef.current;
    const state = useViewerStore.getState();
    if (state.models.size === 0) { toast.info('No models loaded — nothing to re-align.'); return; }

    const referenceSelection = findReferenceSpatialModel();
    if (!referenceSelection) {
      realignFederatedPointClouds(null);
      toast.error('Cannot re-align: no model with valid georeferencing.');
      return;
    }
    // Snapshot edits: an awaited cross-CRS pass must never mix old and new frames.
    const georefMutations = state.georefMutations;
    const selectedAnchor = state.models.get(referenceSelection.modelId);
    if (!selectedAnchor) return;
    state.closeReposition();
    // Keep rotations outside preAlignment; useModelRotationSync reapplies headings once.
    const { counts, anchorGeoref, movedModelIds, stale } = await withModelRotationsUnbaked(() => realignFederationModels({
      models: () => Array.from(useViewerStore.getState().models.entries()) as Array<[string, FederatedModel]>,
      getModel: (modelId) => useViewerStore.getState().models.get(modelId),
      anchorModelId: referenceSelection.modelId,
      anchorModel: selectedAnchor,
      anchorGeoref: referenceSelection.placement,
      resolveGeoref: (modelId, model) => (
        model.geometryResult && model.spatialReference
          ? { spatialReference: model.spatialReference, coordinateInfo: model.geometryResult.coordinateInfo }
          : model.ifcDataStore && model.geometryResult
            ? extractModelSpatialPlacement(
            model.ifcDataStore,
            model.geometryResult.coordinateInfo,
            georefMutations.get(modelId),
          )
          : null
      ),
      updateModel: state.updateModel,
      isCurrent: () => realignSession === realignSessionRef.current,
    }));
    if (stale || realignSession !== realignSessionRef.current) return; // Stale rollback must not publish frame/index/scan work.
    // Manual offsets remain explicit workspace vectors after re-alignment.
    // Picked anchors were cancelled above; exchange files must name the new frame.
    const frameCommitted = commitRealignmentFrame(state.models, anchorGeoref);

    // Everything keyed on "whose geometry actually moved", not on the align
    // count — a restored anchor (#2007) and a restored-then-skipped model both
    // move without being aligned.
    if (movedModelIds.length > 0) {
      // Signal that mesh content was mutated in place — forces the merged-mesh
      // cache in ViewportContainer to rebuild AND the streaming hook to clear
      // the WebGPU scene and re-upload buffers. Without this, the success toast
      // fires but the visible model doesn't move because the GPU still has the
      // old vertex positions cached.
      useViewerStore.getState().bumpGeometryContentVersion();

      // The placement index sync observes the content revision and rebuilds
      // from placed flat meshes plus any uploaded instances.
      const models = useViewerStore.getState().models;
      for (const modelId of movedModelIds) {
        const moved = models.get(modelId) as FederatedModel | undefined;
        if (moved?.ifcDataStore && moved.geometryResult) {
          useViewerStore.getState().updateModel(modelId, {});
        }
      }
    }

    realignFederatedPointClouds(findReferenceSpatialModel()?.placement ?? null);

    if (!frameCommitted) return; // Surviving geometry still needed the invalidation above.
    const messageParts: string[] = [];
    if (counts.aligned > 0) messageParts.push(`${counts.aligned} aligned`);
    if (counts.reprojected > 0) messageParts.push(`${counts.reprojected} reprojected`);
    if (counts.skipped > 0) messageParts.push(`${counts.skipped} skipped`);
    if (counts.failed > 0) messageParts.push(`${counts.failed} failed`);
    const summary = messageParts.length > 0 ? messageParts.join(', ') : 'no changes needed';
    if (counts.failed > 0) {
      toast.error(`Federation re-aligned against "${anchorGeoref.spatialReference.horizontal?.id ?? 'unknown CRS'}": ${summary}.`);
    } else {
      toast.success(`Federation re-aligned against "${anchorGeoref.spatialReference.horizontal?.id ?? 'unknown CRS'}": ${summary}.`);
    }
  }, []);

  /**
   * Remove a model from the federation
   */
  const removeModel = useCallback((modelId: string) => {
    storeRemoveModel(modelId);

    // Read fresh state from store after removal to avoid stale closure
    const freshModels = useViewerStore.getState().models;
    const remaining = Array.from(freshModels.values()) as FederatedModel[];
    if (remaining.length > 0) {
      const newActive = remaining[0];
      setIfcDataStore(newActive.ifcDataStore);
      setGeometryResult(newActive.geometryResult);
    } else {
      setIfcDataStore(null);
      setGeometryResult(null);
    }
    realignFederatedPointClouds(findReferenceSpatialModel()?.placement ?? null);
  }, [storeRemoveModel, setIfcDataStore, setGeometryResult]);

  /**
   * Get query instance for a specific model
   */
  const getQueryForModel = useCallback((modelId: string): IfcQuery | null => {
    const model = getModel(modelId);
    if (!model || !model.ifcDataStore) return null;
    return new IfcQuery(model.ifcDataStore);
  }, [getModel]);

  /**
   * Load multiple files sequentially (WASM parser isn't thread-safe)
   * Each file fully loads before the next one starts
   */
  const loadFilesSequentially = useCallback(async (
    files: File[],
    handles?: (FileSystemFileHandle | undefined)[],
  ): Promise<void> => {
    for (let i = 0; i < files.length; i++) {
      await addModel(files[i], { sourceHandle: handles?.[i] });
    }
  }, [addModel]);

  /** Later sources are stronger. The loader owns reads, reset, parse and publication. */
  const loadFederatedIfcx = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) {
      reportError('No files provided for federated loading', 'ifcx_federated_no_files', null);
      return;
    }
    await loadFile(files[0], { kind: 'primary', modelId: 'layer-1' }, { ifcxSources: files });
  }, [loadFile]);

  /** Recompose with new overlays last (strongest), resetting unstable synthetic ids. */
  const addIfcxOverlays = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    const state = useViewerStore.getState();
    const currentStore = state.ifcDataStore as IfcxDataStore | null;
    let existing = currentStore?._federatedBuffers;
    if (!existing && currentStore?.source && currentStore.schemaVersion === 'IFC5') {
      const model = [...state.models.values()].find(m => m.ifcDataStore === currentStore);
      existing = [{
        buffer: currentStore.source.withMaterialized(bytes => bytes.slice().buffer) as ArrayBuffer,
        name: model?.name ?? 'base.ifcx',
      }];
    }
    if (!existing?.length) {
      reportError('Cannot add overlays: no IFCX model loaded', 'ifcx_overlay_no_base',
        () => { void addIfcxOverlays(files); });
      return;
    }
    const base = existing[0];
    const sourceFile = [...state.models.values()].find(model => model.ifcDataStore === currentStore && model.sourceFile)?.sourceFile;
    await loadFile(sourceFile ?? new File([base.buffer], base.name), { kind: 'primary', modelId: 'layer-1' }, {
      ifcxSources: [...existing, ...files],
    });
  }, [loadFile]);

  // Both resolvers below go through the store's canonical
  // `resolveGlobalIdFromModels` first, falling back to the `federationRegistry`
  // singleton only for a model that has left `state.models` but is still
  // registered. Consulting the registry alone missed every model seeded
  // without `registerModelOffset` — the federated-IFCX composition just above
  // does exactly that (the collab room did too until #4444, when its models
  // started registering like any added file). See `useZoneSelection.ts` for
  // the same delegation, and PR #2697 for the clash path.

  /**
   * Find which model contains a given globalId.
   * Returns the modelId, or null if no loaded or registered model owns it.
   */
  const findModelForEntity = useCallback((globalId: number): string | null => {
    return resolveGlobalIdFromModels(globalId)?.modelId ?? findModelForGlobalId(globalId);
  }, [resolveGlobalIdFromModels, findModelForGlobalId]);

  /**
   * Convert a globalId back to the original (modelId, expressId) pair
   * Use this when you need to look up properties in the IfcDataStore
   */
  const resolveGlobalId = useCallback((globalId: number): { modelId: string; expressId: number } | null => {
    return resolveGlobalIdFromModels(globalId) ?? fromGlobalId(globalId);
  }, [resolveGlobalIdFromModels, fromGlobalId]);

  return {
    addModel,
    removeModel,
    getQueryForModel,
    loadFilesSequentially,
    loadFederatedIfcx,
    addIfcxOverlays,
    findModelForEntity,
    resolveGlobalId,
    realignFederation,
  };
}

export default useIfcFederation;
