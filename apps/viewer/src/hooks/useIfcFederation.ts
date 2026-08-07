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

import { useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore, type FederatedModel, type SchemaVersion } from '../store/index.js';
import { layerStackEntry } from '../lib/layers/stack.js';
import {
  detectFormat,
  parseFederatedIfcx,
  type IfcDataStore,
  type FederatedIfcxParseResult,
} from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { IfcQuery } from '@ifc-lite/query';
import { buildSpatialIndexGuarded, buildSpatialIndexForModel } from '../utils/loadingUtils.js';
import { getDynamicBatchConfig } from '../utils/ifcConfig.js';
import { calculateMeshBounds, createCoordinateInfo } from '../utils/localParsingUtils.js';
import {
  buildIfcxDataStore,
  convertIfcxMeshes,
} from './ingest/viewerModelIngest.js';
import { extractModelGeoref, findReferenceGeorefModel } from './ingest/federationAlign.js';
import { realignFederationModels } from './ingest/federationRealign.js';
import { toast } from '../components/ui/toast.js';
import { acquireFederationLoadSlot, releaseFederationLoadSlot } from './federationLoadGate.js';

/**
 * Extended data store type for IFCX (IFC5) files.
 * IFCX uses schemaVersion 'IFC5' and may include federated composition metadata.
 */
export interface IfcxDataStore extends IfcDataStore {
  schemaVersion: 'IFC5';
  /** Federated layer info for re-composition */
  _federatedLayers?: Array<{ id: string; name: string; enabled: boolean }>;
  /** Original buffers for re-composition when adding overlays */
  _federatedBuffers?: Array<{ buffer: ArrayBuffer; name: string }>;
  /** Composition statistics */
  _compositionStats?: { layersUsed: number; inheritanceResolutions: number; crossLayerReferences: number };
  /** Layer info for display */
  _layerInfo?: Array<{ id: string; name: string; meshCount: number }>;
}

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
    options?: { sourceHandle?: FileSystemFileHandle },
  ) => Promise<void>,
) {
  const {
    setLoading,
    setError,
    setProgress,
    setIfcDataStore,
    setGeometryResult,
    // Multi-model state and actions
    addModel: storeAddModel,
    removeModel: storeRemoveModel,
    clearAllModels,
    getModel,
    hasModels,
    // Federation Registry helpers
    registerModelOffset,
    fromGlobalId,
    findModelForGlobalId,
  } = useViewerStore(useShallow((s) => ({
    setLoading: s.setLoading,
    setError: s.setError,
    setProgress: s.setProgress,
    setIfcDataStore: s.setIfcDataStore,
    setGeometryResult: s.setGeometryResult,
    addModel: s.addModel,
    removeModel: s.removeModel,
    clearAllModels: s.clearAllModels,
    getModel: s.getModel,
    hasModels: s.hasModels,
    registerModelOffset: s.registerModelOffset,
    fromGlobalId: s.fromGlobalId,
    findModelForGlobalId: s.findModelForGlobalId,
  })));

  // Per-call ownership token. Each addModel() bumps this; state writes
  // (loading/error/progress) in the catch block must compare back to
  // their captured value before mutating, so a cancelled load A doesn't
  // overwrite progress for a newer load B that started after A's abort.
  // Mirrors the same pattern in useIfcLoader.ts.
  const loadSessionRef = useRef(0);

  /**
   * Add a model to the federation (multi-model support)
   * Uses FederationRegistry to assign unique ID offsets - BULLETPROOF against ID collisions
   * Returns the model ID on success, null on failure
   */
  const addModel = useCallback(async (
    file: File,
    options?: {
      name?: string;
      modelId?: string;
      loadedAt?: number;
      visible?: boolean;
      collapsed?: boolean;
      /** Live FS Access handle so this federated model stays refreshable. */
      sourceHandle?: FileSystemFileHandle;
    }
  ): Promise<string | null> => {
    const modelId = options?.modelId ?? crypto.randomUUID();
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

      // Pick the shared RTC origin from the earliest existing model so every
      // federated model lands in one coordinate space (pixel-perfect alignment,
      // no post-shift). Threaded into the canonical loader below.
      let sharedRtcOffset: { x: number; y: number; z: number } | undefined;
      const existingModelsForRtc = Array.from(useViewerStore.getState().models.values()) as FederatedModel[];
      if (existingModelsForRtc.length > 0) {
        const sorted = [...existingModelsForRtc].sort((a, b) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
        sharedRtcOffset = sorted.find(
          (model) => model.geometryResult?.coordinateInfo?.wasmRtcOffset != null,
        )?.geometryResult?.coordinateInfo?.wasmRtcOffset;
      }

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
        loadedAt: options?.loadedAt,
        sharedRtcOffset,
      }, { sourceHandle: options?.sourceHandle });

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
        setError(err instanceof Error ? err.message : 'Unknown error');
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
    const state = useViewerStore.getState();
    const allModels = Array.from(state.models.entries()) as Array<[string, FederatedModel]>;
    if (allModels.length === 0) {
      toast.info('No models loaded — nothing to re-align.');
      return;
    }

    const referenceSelection = findReferenceGeorefModel();
    if (!referenceSelection) {
      toast.error('Cannot re-align: no model with valid georeferencing.');
      return;
    }

    // ONE snapshot of the user's georef edits for the whole pass, on purpose.
    // `findReferenceGeorefModel()` just read them to build the anchor's georef
    // and every `resolveGeoref` below reads the same Map, with no await in
    // between, so every model in the federation is placed from one consistent
    // set of inputs.
    //
    // The cross-CRS path awaits `resolveProjection`, which can load a precision
    // grid or fetch a definition — a real window in which the georeferencing
    // panel (the Re-align button's `busy` flag disables only itself) can commit
    // an edit. Re-reading the store per callback would then place the models
    // handled after that edit from different inputs than the ones before it AND
    // than the anchor, whose georef is necessarily resolved up front — the
    // anchor's frame has to be read before the restores run (#2007), so it
    // cannot be refreshed mid-pass without reintroducing that bug. The result
    // would be a federation aligned half to one frame and half to another, with
    // nothing in the UI saying so. A uniformly one-edit-stale result is the
    // better failure: it is what the user asked for when they clicked, and the
    // next Re-align picks the edit up.
    const georefMutations = state.georefMutations;

    const { counts, anchorGeoref, movedModelIds } = await realignFederationModels({
      models: allModels,
      anchorModelId: referenceSelection.modelId,
      anchorGeoref: referenceSelection.georef,
      resolveGeoref: (modelId, model) => (
        model.ifcDataStore && model.geometryResult
          ? extractModelGeoref(
            model.ifcDataStore,
            model.geometryResult.coordinateInfo,
            georefMutations.get(modelId),
          )
          : null
      ),
      updateModel: state.updateModel,
    });

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

      // Re-index. `IfcDataStore.spatialIndex` is a BVH of WORLD-space mesh
      // bounds backing queryByBounds/raycast/queryFrustum; the loader builds it
      // once, after load-time alignment, and re-aligning has never rebuilt it
      // (#2013). Measured on the real Building-Architecture + Infra-Bridge
      // federation, one re-align left the index finding 7 of 78 meshes inside
      // the model's own bounds. Runs after the whole pass so no build races the
      // geometry it is measuring, and `buildSpatialIndexForModel` drops its
      // result if the model or its store went away meanwhile.
      const models = useViewerStore.getState().models;
      for (const modelId of movedModelIds) {
        const moved = models.get(modelId) as FederatedModel | undefined;
        if (moved?.ifcDataStore && moved.geometryResult) {
          buildSpatialIndexForModel(moved.geometryResult.meshes, modelId, moved.ifcDataStore);
        }
      }
    }

    const messageParts: string[] = [];
    if (counts.aligned > 0) messageParts.push(`${counts.aligned} aligned`);
    if (counts.reprojected > 0) messageParts.push(`${counts.reprojected} reprojected`);
    if (counts.skipped > 0) messageParts.push(`${counts.skipped} skipped`);
    if (counts.failed > 0) messageParts.push(`${counts.failed} failed`);
    const summary = messageParts.length > 0 ? messageParts.join(', ') : 'no changes needed';
    if (counts.failed > 0) {
      toast.error(`Federation re-aligned against "${anchorGeoref.projectedCRS.name}": ${summary}.`);
    } else {
      toast.success(`Federation re-aligned against "${anchorGeoref.projectedCRS.name}": ${summary}.`);
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
    options: { resetState?: boolean } = {}
  ): Promise<void> => {
    const { resetViewerState, clearAllModels } = useViewerStore.getState();

    try {
      // Always reset viewer state when geometry changes (selection, hidden entities, etc.)
      // This ensures 3D highlighting works correctly after re-composition
      resetViewerState();

      // Clear legacy geometry BEFORE clearing models to prevent stale fallback
      // This avoids a race condition where mergedGeometryResult uses old geometry
      // during the brief moment when storeModels.size === 0
      setGeometryResult(null);
      clearAllModels();

      setLoading(true);
      setError(null);
      setProgress({ phase: 'Parsing federated IFCX', percent: 0 });

      // Parse federated IFCX files
      const result = await parseFederatedIfcx(buffers, {
        onProgress: (prog: { phase: string; percent: number }) => {
          setProgress({ phase: `IFCX ${prog.phase}`, percent: prog.percent });
        },
      });

      // Convert IFCX meshes to viewer format
      const meshes: MeshData[] = convertIfcxMeshes(result.meshes);

      // Calculate bounds
      const { bounds, stats } = calculateMeshBounds(meshes);
      const coordinateInfo = createCoordinateInfo(bounds);

      const geometryResult = {
        meshes,
        totalVertices: stats.totalVertices,
        totalTriangles: stats.totalTriangles,
        coordinateInfo,
      };

      // NOTE: Do NOT call setGeometryResult() here!
      // For federated loading, geometry comes from the models Map via mergedGeometryResult.
      // Calling setGeometryResult() before models are added causes a race condition where
      // meshes are added to the scene WITHOUT modelIndex, breaking selection highlighting.

      // Get layer info with mesh counts
      const layers = result.layerStack.getLayers();

      // Layers panel (#1717): expose the stack behind this composition.
      // getLayers() is strongest-first; the panel slice keeps composition
      // order (weakest first). The parser retains each parsed IfcxFile, so
      // entries reference them without re-parsing.
      useViewerStore.getState().setLayerStack(
        [...layers].reverse().map((layer) => layerStackEntry(layer)),
        result.pathToId ?? null,
      );
      // First composed stack this browser has seen: open the Layers panel
      // once so the feature introduces itself (#1717 exposure). Never
      // repeats — after that the rail icon, badge, and menus carry it.
      if (layers.length >= 2 && typeof window !== 'undefined') {
        const INTRO_KEY = 'ifc-lite:layers:intro-shown';
        try {
          if (!window.localStorage.getItem(INTRO_KEY)) {
            window.localStorage.setItem(INTRO_KEY, '1');
            useViewerStore.getState().openWorkspacePanel('layers');
            toast.info(
              `Composed ${layers.length} layers - inspect, diff, publish, and merge them in the Layers panel.`,
            );
          }
        } catch {
          /* private-mode storage failures must never break loading */
        }
      }

      // Create data store from federated result. Route through the shared
      // IFCX store factory so the lazy accessors (getEntity/getProperties/
      // getQuantities) the query + mutation paths call exist — without
      // them, selecting or editing an entity in a federated model threw
      // "this.store.getProperties is not a function" (#1717 V2).
      const accessorStore = buildIfcxDataStore(result, buffers[0].buffer);
      const dataStore = Object.assign(accessorStore, {
        // Federated-specific: store layer info and ORIGINAL BUFFERS for re-composition
        _federatedLayers: layers.map((l: { id: string; name: string; enabled: boolean }) => ({
          id: l.id,
          name: l.name,
          enabled: l.enabled,
        })),
        _federatedBuffers: buffers.map(b => ({
          buffer: b.buffer.slice(0), // Clone buffer
          name: b.name,
        })),
        _compositionStats: result.compositionStats,
      }) as unknown as IfcxDataStore;

      // IfcxDataStore extends IfcDataStore (with schemaVersion: 'IFC5'), so this is safe
      setIfcDataStore(dataStore);

      // Clear existing models and add each layer as a "model" in the Models panel
      // This shows users all the files that contributed to the composition
      clearAllModels();

      // Find max expressId for proper ID range tracking
      // This is needed for resolveGlobalIdFromModels to work correctly
      let maxExpressId = 0;
      if (result.entities?.expressId) {
        for (let i = 0; i < result.entities.count; i++) {
          const id = result.entities.expressId[i];
          if (id > maxExpressId) maxExpressId = id;
        }
      }

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const layerBuffer = buffers.find(b => b.name === layer.name);

        // Count how many meshes came from this layer
        // For base layers: count meshes, for overlays: show as data-only
        const isBaseLayer = i === layers.length - 1; // Last layer (weakest) is typically base

        const layerModel: FederatedModel = {
          id: layer.id,
          name: layer.name,
          ifcDataStore: dataStore, // Share the composed data store
          geometryResult: isBaseLayer ? geometryResult : {
            meshes: [],
            totalVertices: 0,
            totalTriangles: 0,
            coordinateInfo,
          },
          visible: true,
          collapsed: i > 0, // Collapse overlays by default
          schemaVersion: 'IFC5',
          loadedAt: Date.now() - (layers.length - i) * 100, // Stagger timestamps
          fileSize: layerBuffer?.buffer.byteLength || 0,
          // For base layer: set proper ID range for resolveGlobalIdFromModels
          // Overlays share the same data store so they don't need their own range
          idOffset: 0,
          maxExpressId: isBaseLayer ? maxExpressId : 0,
          // Mark overlay-only layers
          _isOverlay: !isBaseLayer,
          _layerIndex: i,
        } as FederatedModel & { _isOverlay?: boolean; _layerIndex?: number };

        storeAddModel(layerModel);
      }

      setProgress({ phase: 'Complete', percent: 100 });
      setLoading(false);
    } catch (err: unknown) {
      console.error('[useIfc] Federated IFCX loading failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(`Federated IFCX loading failed: ${message}`);
      setLoading(false);
    }
  }, [setLoading, setError, setProgress, setGeometryResult, setIfcDataStore, storeAddModel, clearAllModels]);

  const loadFederatedIfcx = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) {
      setError('No files provided for federated loading');
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
        setError(`File "${file.name}" is not an IFCX file. Federated loading only supports IFCX files.`);
        return;
      }
      buffers.push({ buffer, name: file.name });
    }

    await loadFederatedIfcxFromBuffers(buffers);
  }, [setError, loadFederatedIfcxFromBuffers]);

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
      setError('Cannot add overlays: no IFCX model loaded');
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
        setError(`File "${file.name}" is not an IFCX file.`);
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

    await loadFederatedIfcxFromBuffers(allBuffers, { resetState: false });
  }, [setError, loadFederatedIfcxFromBuffers]);

  /**
   * Find which model contains a given globalId
   * Uses FederationRegistry for O(log N) lookup - BULLETPROOF
   * Returns the modelId or null if not found
   */
  const findModelForEntity = useCallback((globalId: number): string | null => {
    return findModelForGlobalId(globalId);
  }, [findModelForGlobalId]);

  /**
   * Convert a globalId back to the original (modelId, expressId) pair
   * Use this when you need to look up properties in the IfcDataStore
   */
  const resolveGlobalId = useCallback((globalId: number): { modelId: string; expressId: number } | null => {
    return fromGlobalId(globalId);
  }, [fromGlobalId]);

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
