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

import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore, type FederatedModel, type SchemaVersion } from '../store.js';
import {
  detectFormat,
  parseFederatedIfcx,
  type IfcDataStore,
  type FederatedIfcxParseResult,
  type MapConversion,
  type ProjectedCRS,
} from '@ifc-lite/parser';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { IfcQuery } from '@ifc-lite/query';
import { buildSpatialIndexGuarded } from '../utils/loadingUtils.js';
import { getDynamicBatchConfig } from '../utils/ifcConfig.js';
import { calculateMeshBounds, createCoordinateInfo } from '../utils/localParsingUtils.js';
import {
  convertIfcxMeshes,
  getMaxExpressId,
  parseGlbViewerModel,
  parseIfcxViewerModel,
  parseStepBufferViewerModel,
} from './ingest/viewerModelIngest.js';
import { readNativeFile, type NativeFileHandle } from '../services/file-dialog.js';
import { getEffectiveGeoreference, type GeorefMutationDataLike } from '../lib/geo/effective-georef.js';

function isNativeFileHandle(file: File | NativeFileHandle): file is NativeFileHandle {
  return typeof (file as NativeFileHandle).path === 'string';
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

type FederatedGeometryResult = NonNullable<FederatedModel['geometryResult']>;

interface ModelGeoref {
  mapConversion: MapConversion;
  projectedCRS: ProjectedCRS;
  lengthUnitScale: number;
  coordinateInfo?: CoordinateInfo;
}

interface AffineTransform3D {
  m00: number;
  m01: number;
  m02: number;
  tx: number;
  m10: number;
  m11: number;
  m12: number;
  ty: number;
  m20: number;
  m21: number;
  m22: number;
  tz: number;
}

function getMapUnitScale(georef: ModelGeoref): number {
  return georef.projectedCRS.mapUnitScale ?? georef.lengthUnitScale ?? 1;
}

function getAxis(conversion: MapConversion): { a: number; o: number; scale: number; denom: number } {
  const a = conversion.xAxisAbscissa ?? 1;
  const o = conversion.xAxisOrdinate ?? 0;
  const scale = conversion.scale ?? 1;
  const denom = Math.max(a * a + o * o, 1e-12);
  return { a, o, scale, denom };
}

function extractModelGeoref(
  dataStore: IfcDataStore,
  coordinateInfo?: CoordinateInfo,
  mutations?: GeorefMutationDataLike,
): ModelGeoref | null {
  const georef = getEffectiveGeoreference(dataStore, coordinateInfo, mutations);
  if (!georef?.mapConversion || !georef.projectedCRS?.name) return null;
  return {
    mapConversion: georef.mapConversion,
    projectedCRS: georef.projectedCRS,
    lengthUnitScale: georef.lengthUnitScale,
    coordinateInfo,
  };
}

function crsKey(crs: ProjectedCRS): string {
  return `${crs.name ?? ''}|${crs.geodeticDatum ?? ''}|${crs.mapProjection ?? ''}|${crs.mapZone ?? ''}`.toUpperCase();
}

function canAlignInSameProjectedCrs(a: ModelGeoref, b: ModelGeoref): boolean {
  return crsKey(a.projectedCRS) === crsKey(b.projectedCRS);
}

function totalYupOffset(coordinateInfo?: CoordinateInfo): { x: number; y: number; z: number } {
  const shift = coordinateInfo?.originShift ?? { x: 0, y: 0, z: 0 };
  const rtc = coordinateInfo?.wasmRtcOffset;
  const rtcYup = rtc ? { x: rtc.x, y: rtc.z, z: -rtc.y } : { x: 0, y: 0, z: 0 };
  return {
    x: shift.x + rtcYup.x,
    y: shift.y + rtcYup.y,
    z: shift.z + rtcYup.z,
  };
}

function emptyBounds() {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
}

function zeroBounds() {
  return {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
  };
}

function updateBounds(bounds: ReturnType<typeof emptyBounds>, x: number, y: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  bounds.min.x = Math.min(bounds.min.x, x);
  bounds.min.y = Math.min(bounds.min.y, y);
  bounds.min.z = Math.min(bounds.min.z, z);
  bounds.max.x = Math.max(bounds.max.x, x);
  bounds.max.y = Math.max(bounds.max.y, y);
  bounds.max.z = Math.max(bounds.max.z, z);
  return true;
}

function buildGeorefAlignmentTransform(source: ModelGeoref, reference: ModelGeoref): AffineTransform3D | null {
  const sourceConv = source.mapConversion;
  const refConv = reference.mapConversion;
  const sourceAxis = getAxis(sourceConv);
  const refAxis = getAxis(refConv);
  const refDenom = refAxis.scale * refAxis.denom;
  if (Math.abs(refDenom) < 1e-12) return null;

  const sourceMapUnitScale = getMapUnitScale(source);
  const refMapUnitScale = getMapUnitScale(reference);
  const sourceOffset = totalYupOffset(source.coordinateInfo);
  const refOffset = totalYupOffset(reference.coordinateInfo);

  const eVx = sourceAxis.scale * sourceAxis.a;
  const eVz = sourceAxis.scale * sourceAxis.o;
  const eC = sourceConv.eastings * sourceMapUnitScale
    + sourceAxis.scale * (sourceAxis.a * sourceOffset.x + sourceAxis.o * sourceOffset.z)
    - refConv.eastings * refMapUnitScale;

  const nVx = sourceAxis.scale * sourceAxis.o;
  const nVz = -sourceAxis.scale * sourceAxis.a;
  const nC = sourceConv.northings * sourceMapUnitScale
    + sourceAxis.scale * (sourceAxis.o * sourceOffset.x - sourceAxis.a * sourceOffset.z)
    - refConv.northings * refMapUnitScale;

  const hC = sourceConv.orthogonalHeight * sourceMapUnitScale
    + sourceOffset.y
    - refConv.orthogonalHeight * refMapUnitScale;

  const invRefDenom = 1 / refDenom;
  const xVx = (refAxis.a * eVx + refAxis.o * nVx) * invRefDenom;
  const xVz = (refAxis.a * eVz + refAxis.o * nVz) * invRefDenom;
  const xC = (refAxis.a * eC + refAxis.o * nC) * invRefDenom - refOffset.x;

  const yVx = (-refAxis.o * eVx + refAxis.a * nVx) * invRefDenom;
  const yVz = (-refAxis.o * eVz + refAxis.a * nVz) * invRefDenom;
  const yC = (-refAxis.o * eC + refAxis.a * nC) * invRefDenom;

  return {
    m00: xVx,
    m01: 0,
    m02: xVz,
    tx: xC,
    m10: 0,
    m11: 1,
    m12: 0,
    ty: hC - refOffset.y,
    m20: -yVx,
    m21: 0,
    m22: -yVz,
    tz: -yC - refOffset.z,
  };
}

function isIdentityTransform(transform: AffineTransform3D): boolean {
  const eps = 1e-7;
  return Math.abs(transform.m00 - 1) < eps
    && Math.abs(transform.m01) < eps
    && Math.abs(transform.m02) < eps
    && Math.abs(transform.tx) < eps
    && Math.abs(transform.m10) < eps
    && Math.abs(transform.m11 - 1) < eps
    && Math.abs(transform.m12) < eps
    && Math.abs(transform.ty) < eps
    && Math.abs(transform.m20) < eps
    && Math.abs(transform.m21) < eps
    && Math.abs(transform.m22 - 1) < eps
    && Math.abs(transform.tz) < eps;
}

function applyAlignmentTransformAndUpdateBounds(
  geometry: FederatedGeometryResult,
  transform: AffineTransform3D,
  referenceInfo?: CoordinateInfo,
): void {
  const bounds = emptyBounds();
  let found = false;

  for (const mesh of geometry.meshes) {
    const positions = mesh.positions;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }

      const alignedX = transform.m00 * x + transform.m01 * y + transform.m02 * z + transform.tx;
      const alignedY = transform.m10 * x + transform.m11 * y + transform.m12 * z + transform.ty;
      const alignedZ = transform.m20 * x + transform.m21 * y + transform.m22 * z + transform.tz;
      positions[i] = alignedX;
      positions[i + 1] = alignedY;
      positions[i + 2] = alignedZ;
      found = updateBounds(bounds, alignedX, alignedY, alignedZ) || found;
    }

    // Rotate normals by the transform's 3×3 linear part (translation omitted)
    // and renormalize. CRS alignment is a rigid rotation, so the linear part
    // itself is the correct transform for normals; degenerate results from
    // zero-length or non-finite inputs are left in place.
    const normals = mesh.normals;
    if (normals && normals.length >= 3) {
      for (let i = 0; i < normals.length; i += 3) {
        const nx = normals[i];
        const ny = normals[i + 1];
        const nz = normals[i + 2];
        if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
          continue;
        }
        const rx = transform.m00 * nx + transform.m01 * ny + transform.m02 * nz;
        const ry = transform.m10 * nx + transform.m11 * ny + transform.m12 * nz;
        const rz = transform.m20 * nx + transform.m21 * ny + transform.m22 * nz;
        const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (!Number.isFinite(len) || len < 1e-12) {
          continue;
        }
        normals[i] = rx / len;
        normals[i + 1] = ry / len;
        normals[i + 2] = rz / len;
      }
    }
  }

  geometry.coordinateInfo = {
    originShift: referenceInfo?.originShift ?? { x: 0, y: 0, z: 0 },
    originalBounds: found ? bounds : zeroBounds(),
    shiftedBounds: found ? bounds : zeroBounds(),
    hasLargeCoordinates: referenceInfo?.hasLargeCoordinates ?? false,
    wasmRtcOffset: referenceInfo?.wasmRtcOffset,
    buildingRotation: referenceInfo?.buildingRotation,
  };
}

function alignGeometryToReferenceGeoref(
  geometry: FederatedGeometryResult,
  source: ModelGeoref,
  reference: ModelGeoref,
): boolean {
  if (!canAlignInSameProjectedCrs(source, reference)) {
    return false;
  }

  const transform = buildGeorefAlignmentTransform(source, reference);
  if (!transform) {
    return false;
  }

  if (!isIdentityTransform(transform)) {
    applyAlignmentTransformAndUpdateBounds(geometry, transform, reference.coordinateInfo);
  }
  return true;
}

function findReferenceGeorefModel(): ModelGeoref | null {
  const state = useViewerStore.getState();
  const modelEntries = Array.from(state.models.entries()) as Array<[string, FederatedModel]>;
  const sorted = [...modelEntries].sort(([, a], [, b]) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
  for (const [modelId, model] of sorted) {
    if (!model.ifcDataStore || !model.geometryResult) continue;
    const georef = extractModelGeoref(
      model.ifcDataStore,
      model.geometryResult.coordinateInfo,
      state.georefMutations.get(modelId),
    );
    if (georef) return georef;
  }
  return null;
}

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
export function useIfcFederation() {
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

  /**
   * Add a model to the federation (multi-model support)
   * Uses FederationRegistry to assign unique ID offsets - BULLETPROOF against ID collisions
   * Returns the model ID on success, null on failure
   */
  const addModel = useCallback(async (
    file: File | NativeFileHandle,
    options?: {
      name?: string;
      modelId?: string;
      loadedAt?: number;
      visible?: boolean;
      collapsed?: boolean;
    }
  ): Promise<string | null> => {
    const modelId = options?.modelId ?? crypto.randomUUID();
    const addStart = performance.now();
    try {
      // IMPORTANT: Before adding a new model, check if there's a legacy model
      // (loaded via loadFile) that's not in the Map yet. If so, migrate it first.
      const currentModels = useViewerStore.getState().models;
      const currentIfcDataStore = useViewerStore.getState().ifcDataStore;
      const currentGeometryResult = useViewerStore.getState().geometryResult;

      if (currentModels.size === 0 && currentIfcDataStore && currentGeometryResult) {
        // Migrate the legacy model to the Map
        // Legacy model has offset 0 (IDs are unchanged)
        const legacyModelId = crypto.randomUUID();
        const legacyName = currentIfcDataStore.spatialHierarchy?.project?.name || 'Model 1';

        // Find max expressId in legacy model for registry
        // IMPORTANT: Include ALL entities, not just meshes, for proper globalId resolution
        const legacyMeshes = currentGeometryResult.meshes || [];
        const legacyMaxExpressIdFromMeshes = legacyMeshes.reduce((max: number, m: MeshData) => Math.max(max, m.expressId), 0);
        // FIXED: Use iteration instead of spread to avoid stack overflow with large Maps
        let legacyMaxExpressIdFromEntities = 0;
        if (currentIfcDataStore.entityIndex?.byId) {
          for (const key of currentIfcDataStore.entityIndex.byId.keys()) {
            if (key > legacyMaxExpressIdFromEntities) legacyMaxExpressIdFromEntities = key;
          }
        }
        const legacyMaxExpressId = Math.max(legacyMaxExpressIdFromMeshes, legacyMaxExpressIdFromEntities);

        // Register legacy model with offset 0 (IDs already in use as-is)
        const legacyOffset = registerModelOffset(legacyModelId, legacyMaxExpressId);

        const legacyModel: FederatedModel = {
          id: legacyModelId,
          name: legacyName,
          ifcDataStore: currentIfcDataStore,
          geometryResult: currentGeometryResult,
          visible: true,
          collapsed: false,
          schemaVersion: 'IFC4',
          loadedAt: Date.now() - 1000,
          fileSize: 0,
          sourceFile: undefined,
          idOffset: legacyOffset,
          maxExpressId: legacyMaxExpressId,
        };
        storeAddModel(legacyModel);
      }

      setLoading(true);
      setError(null);
      setProgress({ phase: 'Loading file', percent: 0 });

      // Read file from disk
      const buffer = isNativeFileHandle(file)
        ? toExactArrayBuffer(await readNativeFile(file.path))
        : await file.arrayBuffer();
      const fileSizeMB = buffer.byteLength / (1024 * 1024);

      // Detect file format
      const format = detectFormat(buffer);

      let parsedDataStore: IfcDataStore | null = null;
      let parsedGeometry: FederatedModel['geometryResult'] = null;
      let schemaVersion: SchemaVersion = 'IFC4';

      if (format === 'ifcx') {
        setProgress({ phase: 'Parsing IFCX (client-side)', percent: 10 });
        try {
          const result = await parseIfcxViewerModel(buffer, setProgress);
          parsedDataStore = result.dataStore;
          parsedGeometry = result.geometryResult;
          schemaVersion = result.schemaVersion;
        } catch (error) {
          if (error instanceof Error && error.message === 'overlay-only-ifcx') {
            console.warn(`[useIfc] IFCX file "${file.name}" has no geometry - this is an overlay file.`);
            setError(`"${file.name}" is an overlay file with no geometry. Please load it together with a base IFCX file (select all files at once for federated loading).`);
            setLoading(false);
            return null;
          }
          throw error;
        }
      } else if (format === 'glb') {
        setProgress({ phase: 'Parsing GLB', percent: 10 });
        const result = await parseGlbViewerModel(buffer);
        parsedDataStore = result.dataStore;
        parsedGeometry = result.geometryResult;
        schemaVersion = result.schemaVersion;
      } else {
        setProgress({ phase: 'Starting geometry streaming', percent: 10 });

        // For federated models: use the first model's RTC offset so all models
        // share the same coordinate origin. This ensures pixel-perfect alignment
        // without error-prone delta adjustments.
        let sharedRtcOffset: { x: number; y: number; z: number } | undefined;
        const existingModelsForRtc = Array.from(useViewerStore.getState().models.values()) as FederatedModel[];
        if (existingModelsForRtc.length > 0) {
          const sorted = [...existingModelsForRtc].sort((a, b) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
          sharedRtcOffset = sorted.find(
            (model) => model.geometryResult?.coordinateInfo?.wasmRtcOffset != null,
          )?.geometryResult?.coordinateInfo?.wasmRtcOffset;
        }

        const result = await parseStepBufferViewerModel({
          fileName: file.name,
          buffer,
          fileSizeMB,
          getDynamicBatchSize: getDynamicBatchConfig,
          onProgress: setProgress,
          sharedRtcOffset,
        });
        parsedDataStore = result.dataStore;
        parsedGeometry = result.geometryResult;
        schemaVersion = result.schemaVersion;
      }

      if (!parsedDataStore || !parsedGeometry) {
        throw new Error('Failed to parse file');
      }

      const referenceGeoref = findReferenceGeorefModel();
      // Include any georef edits the user has already saved for this model so
      // that a reload after editing reflects the new placement. Without this,
      // extractModelGeoref reads only the raw parsed metadata and mutations
      // are silently ignored.
      const parsedGeorefMutations = useViewerStore.getState().georefMutations.get(modelId);
      const parsedGeoref = extractModelGeoref(
        parsedDataStore,
        parsedGeometry.coordinateInfo,
        parsedGeorefMutations,
      );
      if (referenceGeoref && parsedGeoref) {
        setProgress({ phase: 'Aligning georeferenced model', percent: 90 });
        const aligned = alignGeometryToReferenceGeoref(parsedGeometry, parsedGeoref, referenceGeoref);
        if (!aligned) {
          console.warn(
            `[ifc-lite] Skipped georeferenced federation alignment for "${file.name}" because CRS differs from the reference model.`,
          );
        }
      }

      // =========================================================================
      // FEDERATION REGISTRY: Transform expressIds to globally unique IDs
      // This is the BULLETPROOF fix for multi-model ID collisions
      // =========================================================================

      // Step 1: Find max expressId in this model
      // IMPORTANT: Use ALL entities from data store, not just meshes
      // Spatial containers (IfcProject, IfcSite, etc.) don't have geometry but need valid globalId resolution
      const maxExpressId = getMaxExpressId(parsedDataStore, parsedGeometry.meshes);

      // Step 2: Register with federation registry to get unique offset
      const idOffset = registerModelOffset(modelId, maxExpressId);

      // Step 3: Transform ALL mesh expressIds to globalIds
      // globalId = originalExpressId + offset
      // This ensures no two models can have the same ID
      if (idOffset > 0) {
        for (const mesh of parsedGeometry.meshes) {
          mesh.expressId = mesh.expressId + idOffset;
        }
      }

      // =========================================================================
      // COORDINATE ALIGNMENT: All federated models use the same shared RTC offset
      // (passed to WASM during parsing above), so no post-processing vertex
      // adjustment is needed. All models are already in the same coordinate space.
      // =========================================================================

      // Build spatial index AFTER ID offset + RTC alignment so it stores
      // correct globalIds and final world-space positions.
      buildSpatialIndexGuarded(parsedGeometry.meshes, parsedDataStore, setIfcDataStore);

      // Create the federated model with offset info
      const federatedModel: FederatedModel = {
        id: modelId,
        name: options?.name ?? file.name,
        ifcDataStore: parsedDataStore,
        geometryResult: parsedGeometry,
        visible: options?.visible ?? true,
        collapsed: options?.collapsed ?? hasModels(), // Collapse if not first model
        schemaVersion,
        loadedAt: options?.loadedAt ?? Date.now(),
        fileSize: buffer.byteLength,
        sourceFile: file,
        idOffset,
        maxExpressId,
      };

      // Add to store
      storeAddModel(federatedModel);

      // Also set legacy single-model state for backward compatibility
      setIfcDataStore(parsedDataStore);
      setGeometryResult(parsedGeometry);

      setProgress({ phase: 'Complete', percent: 100 });
      setLoading(false);
      console.log(`[ifc-lite] Added model ${file.name} (${fileSizeMB.toFixed(1)}MB) in ${(performance.now() - addStart).toFixed(0)}ms`);

      return modelId;

    } catch (err) {
      console.error('[useIfc] addModel failed:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
      return null;
    }
  }, [setLoading, setError, setProgress, setIfcDataStore, setGeometryResult, storeAddModel, hasModels, registerModelOffset]);

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
  const loadFilesSequentially = useCallback(async (files: File[]): Promise<void> => {
    for (const file of files) {
      await addModel(file);
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

    // Check that all files are IFCX format and read buffers
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

    // Read new overlay buffers
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
  };
}

export default useIfcFederation;
