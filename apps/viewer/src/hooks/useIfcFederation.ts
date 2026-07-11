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
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { IfcQuery } from '@ifc-lite/query';
import { buildSpatialIndexGuarded } from '../utils/loadingUtils.js';
import { getDynamicBatchConfig } from '../utils/ifcConfig.js';
import { calculateMeshBounds, createCoordinateInfo } from '../utils/localParsingUtils.js';
import {
  convertIfcxMeshes,
} from './ingest/viewerModelIngest.js';
import { extractModelGeoref, alignGeometryToReference, findReferenceGeorefModel } from './ingest/federationAlign.js';
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
   * Restores each non-anchor model's geometry from its `preAlignmentPositions`
   * snapshot, then re-runs alignment against the new anchor. Skips models that
   * have no snapshot — those were loaded standalone and would need a reload to
   * participate in re-alignment. Updates `federationAlignmentStatus` on every
   * touched model so the UI badges reflect the new state.
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
    const { modelId: anchorModelId, georef: anchorGeoref } = referenceSelection;

    let aligned = 0;
    let reprojected = 0;
    let skipped = 0;
    let failed = 0;

    const updateModel = state.updateModel;

    for (const [modelId, model] of allModels) {
      if (modelId === anchorModelId) {
        if (model.federationAlignmentStatus !== 'anchor') {
          updateModel(modelId, { federationAlignmentStatus: 'anchor' });
        }
        continue;
      }
      if (!model.geometryResult || !model.ifcDataStore) {
        skipped += 1;
        continue;
      }

      // Lazy-snapshot: a model that joined before federation existed (or as
      // the original anchor of a previous federation) was never re-baked, so
      // its current vertices ARE its pre-alignment positions. Take a snapshot
      // before we mutate them so subsequent re-aligns can restore.
      let snapshots = model.preAlignmentPositions;
      let normalSnapshots = model.preAlignmentNormals;
      let snapshotInfo = model.preAlignmentCoordinateInfo;
      if (!snapshots || !snapshotInfo) {
        snapshots = model.geometryResult.meshes.map((m) => new Float32Array(m.positions));
        normalSnapshots = model.geometryResult.meshes.map((m) =>
          m.normals && m.normals.length > 0 ? new Float32Array(m.normals) : undefined,
        );
        snapshotInfo = model.geometryResult.coordinateInfo;
      }

      // Restore vertices and normals to pre-alignment state. Normals must be
      // restored too because applyAlignmentTransformAndUpdateBounds rotates
      // them in place — without restoring, repeated re-aligns would compound
      // rotations and drift lighting/shading.
      const meshes = model.geometryResult.meshes;
      const restoreCount = Math.min(meshes.length, snapshots.length);
      for (let i = 0; i < restoreCount; i += 1) {
        meshes[i].positions = new Float32Array(snapshots[i]);
        if (normalSnapshots) {
          const snap = normalSnapshots[i];
          if (snap) {
            meshes[i].normals = new Float32Array(snap);
          }
        }
      }
      model.geometryResult.coordinateInfo = {
        ...snapshotInfo,
        originalBounds: { ...snapshotInfo.originalBounds },
        shiftedBounds: { ...snapshotInfo.shiftedBounds },
      };

      const parsedGeoref = extractModelGeoref(
        model.ifcDataStore,
        model.geometryResult.coordinateInfo,
        state.georefMutations.get(modelId),
      );
      if (!parsedGeoref) {
        updateModel(modelId, {
          preAlignmentPositions: snapshots,
          preAlignmentNormals: normalSnapshots,
          preAlignmentCoordinateInfo: snapshotInfo,
          federationAlignmentStatus: 'none',
        });
        skipped += 1;
        continue;
      }

      const status = await alignGeometryToReference(model.geometryResult, parsedGeoref, anchorGeoref);
      updateModel(modelId, {
        preAlignmentPositions: snapshots,
        preAlignmentNormals: normalSnapshots,
        preAlignmentCoordinateInfo: snapshotInfo,
        federationAlignmentStatus: status,
      });
      if (status === 'reprojected') reprojected += 1;
      else if (status === 'failed') failed += 1;
      else aligned += 1;
    }

    // Signal that mesh content was mutated in place — forces the merged-mesh
    // cache in ViewportContainer to rebuild AND the streaming hook to clear
    // the WebGPU scene and re-upload buffers. Without this, the success toast
    // fires but the visible model doesn't move because the GPU still has the
    // old vertex positions cached.
    if (aligned + reprojected > 0) {
      useViewerStore.getState().bumpGeometryContentVersion();
    }

    const messageParts: string[] = [];
    if (aligned > 0) messageParts.push(`${aligned} aligned`);
    if (reprojected > 0) messageParts.push(`${reprojected} reprojected`);
    if (skipped > 0) messageParts.push(`${skipped} skipped`);
    if (failed > 0) messageParts.push(`${failed} failed`);
    const summary = messageParts.length > 0 ? messageParts.join(', ') : 'no changes needed';
    if (failed > 0) {
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

      // Create data store from federated result
      const dataStore = {
        fileSize: result.fileSize,
        schemaVersion: 'IFC5' as const,
        entityCount: result.entityCount,
        parseTime: result.parseTime,
        source: new Uint8Array(buffers[0].buffer),
        entityIndex: {
          byId: new Map(),
          byType: new Map(),
        },
        strings: result.strings,
        entities: result.entities,
        properties: result.properties,
        quantities: result.quantities,
        relationships: result.relationships,
        spatialHierarchy: result.spatialHierarchy,
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
      } as unknown as IfcxDataStore;

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
    // safeUtf8Decode + retain the scratch (net worse peak than ArrayBuffer).
    // Keep on file.arrayBuffer().
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

      // Convert Uint8Array source back to ArrayBuffer
      const sourceBuffer = currentStore.source.buffer.slice(
        currentStore.source.byteOffset,
        currentStore.source.byteOffset + currentStore.source.byteLength
      ) as ArrayBuffer;

      existingBuffers = [{ buffer: sourceBuffer, name: modelName }];
    } else {
      setError('Cannot add overlays: no IFCX model loaded');
      return;
    }

    // Read new overlay buffers.
    // IFCX is JSON; SAB streaming would force a SAB→scratch copy in
    // safeUtf8Decode + retain the scratch (net worse peak than ArrayBuffer).
    // Keep on file.arrayBuffer().
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

    // Combine: existing layers + new overlays (new overlays are strongest = first in array)
    const allBuffers = [...newBuffers, ...existingBuffers];

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
