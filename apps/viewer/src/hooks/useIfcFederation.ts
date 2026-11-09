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
import { detectFormat } from '@ifc-lite/parser';
import { chooseSharedRtcOffset } from '@ifc-lite/geometry/world-frame';
import { IfcQuery } from '@ifc-lite/query';
import { publishFederatedIfcxComposition, type IfcxDataStore } from './ingest/federatedIfcxComposition.js';
import { extractModelSpatialPlacement, findReferenceSpatialModel } from './ingest/federationAlign.js';
import { realignFederationModels } from './ingest/federationRealign.js';
import { withModelRotationsUnbaked } from '../components/viewer/useModelRotationSync.js';
import { convergeFederationRtcFrame } from './ingest/federationRtcRebase.js';
import { toast } from '../components/ui/toast.js';
import { acquireFederationLoadSlot, releaseFederationLoadSlot } from './federationLoadGate.js';
import { createModelLoadActivity, installModelLoadCanceller, LOAD_COMPLETE, settleOwnedLoadUi, watchLoadSupersession } from './modelLoadCanceller.js';
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
    setGeometryResult,
    // Multi-model state and actions
    removeModel: storeRemoveModel,
    clearAllModels,
    getModel,
    // Federation Registry helpers
    fromGlobalId,
    findModelForGlobalId,
    resolveGlobalIdFromModels,
  } = useViewerStore(useShallow((s) => ({
    setLoading: s.setLoading,
    setError: s.setError,
    setProgress: s.setProgress,
    setGeometryResult: s.setGeometryResult,
    removeModel: s.removeModel,
    clearAllModels: s.clearAllModels,
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
   *
   * Resolves to the model id exactly when THIS add's model is registered,
   * whether or not a newer add overlapped it; `null` when it is not (failed,
   * cancelled, or dropped since, e.g. by a primary load clearing the
   * federation). `options.onError` receives this add's own failure reason.
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
    // before mutating shared loading/error/progress state. It guards shared
    // state only; the result below reports this add's own outcome.
    const currentSession = ++loadSessionRef.current;
    const thisAdd = { registered: false }; // set by loadFile when THIS load registers the model
    // Memory-aware load gate: if a previous federation load is still in
    // flight on this tab and admitting this one would exceed the device
    // memory budget, wait until headroom frees. Single-file loads never
    // wait. See `federationLoadGate.ts` for the budget formula. (#600)
    const fileSizeForGateMB = (typeof (file as File).size === 'number' ? (file as File).size : 0) / (1024 * 1024);
    // A primary that starts while this add waits replaces the scene it was
    // asked for: the add leaves the queue and touches nothing (L6).
    const supersession = watchLoadSupersession('primary');
    let gateSlot: number;
    try {
      gateSlot = await acquireFederationLoadSlot(fileSizeForGateMB, supersession.signal);
    } catch (error) {
      if (supersession.signal.aborted) return null;
      throw error;
    } finally {
      supersession.stop(); // from here this add's own load is what a primary supersedes
    }
    // Admitted, but a primary may have started before this add resumed.
    if (supersession.signal.aborted) {
      releaseFederationLoadSlot(gateSlot);
      return null;
    }
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
      }, { sourceHandle: options?.sourceHandle, retryOperation: options?.retryOperation, workflowOwner: options?.workflowOwner, gaussianPlacement: options?.gaussianPlacement, gaussianUpAxis: options?.gaussianUpAxis, gaussianAttribution: options?.gaussianAttribution, gaussianReplacingModelId: options?.gaussianReplacingModelId, onGaussianBudgetReserved: options?.onGaussianBudgetReserved, onGaussianLoadSettled: options?.onGaussianLoadSettled, onLoadError: options?.onError, onModelRegistered: () => { thisAdd.registered = true; } });

      // Registration is the outcome, also when a newer add overlapped this one:
      // a superseded load still settled a model (#4897, `federationRtcRebase.ts`).
      // THIS load must have registered it (overlapping reloads can share an
      // explicit id), and it must still be there (a primary load clears it).
      if (!thisAdd.registered || !useViewerStore.getState().models.has(modelId)) return null;
      convergeFederationRtcFrame();
      if (options?.failIfSuperseded && loadSessionRef.current !== currentSession) return null; // its caller cleans up (#8566)
      console.log(`[ifc-lite] Added model ${file.name} (${fileSizeForGateMB.toFixed(1)}MB) in ${(performance.now() - addStart).toFixed(0)}ms`);
      return modelId;

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
      const message = err instanceof Error ? err.message : 'Unknown error';
      // The caller learns why THIS add failed even when a newer add owns the shared error state.
      options?.onError?.(message);
      if (isCurrent) {
        reportError(message, 'federated_add_failed',
          options?.retryOperation ?? (() => { void addModel(file, options); }));
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
      assumeIfcSharedVerticalDatum: state.ifcSharedVerticalDatum,
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
    // The store selects the successor and updates both active-data mirrors
    // atomically. Re-copying the first survivor here overwrites a different
    // active model's source and geometry under its existing ID range (#7890).
    storeRemoveModel(modelId);
    realignFederatedPointClouds(findReferenceSpatialModel()?.placement ?? null);
  }, [storeRemoveModel]);

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

  /**
   * Load multiple IFCX files as federated layers
   * Uses IFC5's layer composition system where later files override earlier ones.
   * Properties from overlay files are merged with the base file(s).
   *
   * @param files - Array of IFCX files (first = base/weakest, last = strongest overlay)
   *
   * @example
   * ```typescript
   * // Load base model with property overlay
   * await loadFederatedIfcx([
   *   baseFile,           // hello-wall.ifcx
   *   fireRatingFile,     // add-fire-rating.ifcx (adds FireRating property)
   * ]);
   * ```
   */
  /**
   * Internal: Load federated IFCX from buffers (used by both initial load and add overlay)
   */
  const loadFederatedIfcxFromBuffers = useCallback(async (
    buffers: Array<{ buffer: ArrayBuffer; name: string }>,
  ): Promise<void> => {
    const { resetViewerState, clearAllModels } = useViewerStore.getState();
    // The composition replaces the scene, so it holds a primary load's
    // contract (L7): a Cancel and activity row, superseded by any newer
    // primary, and the shared load UI settled as its owner.
    let superseded = false;
    const activity = createModelLoadActivity(buffers.map((b) => b.name).join(', '));
    const release = installModelLoadCanceller('primary', () => { superseded = true; }, () => null, activity);

    try {
      // Reset viewer state on EVERY federated (re-)composition, including
      // overlay-add. This used to be gated by a boolean "preserve state"
      // option that was declared but never read (dead since #193) -
      // `addIfcxOverlays` opted out believing it preserved selection,
      // but the reset always ran anyway. Investigation confirmed the
      // reset is correct, not just accidentally-always-on: expressIds in
      // the composed IFCX entity table are synthetic and reassigned by
      // iteration order over the composed node map, which shifts when a
      // new overlay becomes the strongest layer - even a pure
      // property-only overlay that adds no entities can reshuffle which
      // expressId belongs to which entity. Since federated models share
      // idOffset 0 (globalId === expressId), a selection/hidden/isolated
      // set captured before recomposition can silently point at a
      // DIFFERENT entity afterwards if left un-reset. So this reset is
      // unconditional and there is no "preserve state" option to honour.
      resetViewerState();

      // Clear legacy geometry BEFORE clearing models to prevent stale fallback
      // This avoids a race condition where mergedGeometryResult uses old geometry
      // during the brief moment when storeModels.size === 0
      setGeometryResult(null);
      clearAllModels();

      setLoading(true);
      useViewerStore.getState().setLoadingFileName(buffers[0]?.name ?? null);
      setError(null);
      setProgress({ phase: 'Parsing federated IFCX', percent: 0 });

      // Parse federated IFCX files
      // Dynamic: keeps the IFCX parser and its imported-geometry kernel out of the eager chunks.
      const { parseFederatedIfcx } = await import('@ifc-lite/ifcx');
      const result = await parseFederatedIfcx(buffers, {
        onProgress: (prog: { phase: string; percent: number }) => {
          if (!superseded) setProgress({ phase: `IFCX ${prog.phase}`, percent: prog.percent });
        },
      });
      if (superseded) return;

      publishFederatedIfcxComposition(result, buffers);
      activity.published = true;
      settleOwnedLoadUi(release, LOAD_COMPLETE);
    } catch (err: unknown) {
      console.error('[useIfc] Federated IFCX loading failed:', err);
      if (superseded) return; // the newer load or the Cancel owns the viewer now
      const message = err instanceof Error ? err.message : String(err);
      reportError(activity.fail(`Federated IFCX loading failed: ${message}`), 'ifcx_federated_load_failed',
        () => { void loadFederatedIfcxFromBuffers(buffers); }); // retry re-composes the same buffers
      settleOwnedLoadUi(release);
    } finally {
      release();
    }
  }, [setLoading, setProgress, setGeometryResult, clearAllModels]);

  const loadFederatedIfcx = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) {
      reportError('No files provided for federated loading', 'ifcx_federated_no_files', null); // no retry: empty list
      return;
    }

    // Check that all files are IFCX format and read buffers.
    // IFCX is JSON; SAB streaming would force a SAB→scratch copy in
    // safeUtf8Decode on top of the JSON string (net worse peak than
    // ArrayBuffer). Keep on file.arrayBuffer(). The copy is no longer
    // *retained* since #2183 capped the scratch, but it is still a
    // full-file transient the ArrayBuffer path does not pay.
    const buffers: Array<{ buffer: ArrayBuffer; name: string }> = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const format = detectFormat(buffer);
      if (format !== 'ifcx') {
        reportError(`File "${file.name}" is not an IFCX file. Federated loading only supports IFCX files.`, 'ifcx_federated_not_ifcx', null); // no retry: still not IFCX
        return;
      }
      buffers.push({ buffer, name: file.name });
    }

    await loadFederatedIfcxFromBuffers(buffers);
  }, [loadFederatedIfcxFromBuffers]);

  /**
   * Add IFCX overlay files to existing federated model
   * Re-composes all layers including new overlays
   * Also handles adding overlays to a single IFCX file that wasn't loaded via federated loading
   */
  const addIfcxOverlays = useCallback(async (files: File[]): Promise<void> => {
    const currentStore = useViewerStore.getState().ifcDataStore as IfcxDataStore | null;
    const currentModels = useViewerStore.getState().models;

    // Get existing buffers - either from federated loading or from single file load
    let existingBuffers: Array<{ buffer: ArrayBuffer; name: string }> = [];

    if (currentStore?._federatedBuffers) {
      // Already federated - use stored buffers
      existingBuffers = currentStore._federatedBuffers as Array<{ buffer: ArrayBuffer; name: string }>;
    } else if (currentStore?.source && currentStore.schemaVersion === 'IFC5') {
      // Single IFCX file loaded via loadFile() - reconstruct buffer from source
      // Get the model name from the models map
      let modelName = 'base.ifcx';
      for (const [, model] of currentModels) {
        // Compare object identity (cast needed due to IFC5 schema extension)
        if ((model.ifcDataStore as unknown) === currentStore || model.schemaVersion === 'IFC5') {
          modelName = model.name;
          break;
        }
      }

      // Whole-file consumer: the IFCX re-composition needs its own
      // ArrayBuffer, so copy out of the source rather than aliasing it.
      const sourceBuffer = currentStore.source
        .withMaterialized((bytes) => bytes.slice().buffer) as ArrayBuffer;

      existingBuffers = [{ buffer: sourceBuffer, name: modelName }];
    } else {
      reportError('Cannot add overlays: no IFCX model loaded', 'ifcx_overlay_no_base',
        () => { void addIfcxOverlays(files); }); // a base model may load before a retry
      return;
    }

    // Read new overlay buffers.
    // IFCX is JSON; SAB streaming would force a SAB→scratch copy in
    // safeUtf8Decode on top of the JSON string (net worse peak than
    // ArrayBuffer). Keep on file.arrayBuffer(). The copy is no longer
    // *retained* since #2183 capped the scratch, but it is still a
    // full-file transient the ArrayBuffer path does not pay.
    const newBuffers: Array<{ buffer: ArrayBuffer; name: string }> = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const format = detectFormat(buffer);
      if (format !== 'ifcx') {
        reportError(`File "${file.name}" is not an IFCX file.`, 'ifcx_overlay_not_ifcx', null); // no retry: still not IFCX
        return;
      }
      newBuffers.push({ buffer, name: file.name });
    }

    // Combine: existing layers first, new overlays LAST. parseFederatedIfcx
    // treats the first file as weakest and the last as strongest, so a new
    // overlay must trail the existing stack — leading it made every added
    // overlay the WEAKEST layer, silently shadowed by the model it was
    // meant to override (#1717 V2).
    const allBuffers = [...existingBuffers, ...newBuffers];

    // Re-composing (including this overlay add) always resets viewer
    // state - see loadFederatedIfcxFromBuffers for why: expressIds are
    // not stable across recomposition, so stale selection/hidden ids
    // could point at the wrong entity afterwards.
    await loadFederatedIfcxFromBuffers(allBuffers);
  }, [loadFederatedIfcxFromBuffers]);

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
