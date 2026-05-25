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
import {
  detectPointCloudFormat,
  ingestPointCloud,
  type PointCloudFormat,
} from './ingest/pointCloudIngest.js';
import { getGlobalRenderer } from './useBCF.js';
import { readNativeFile, type NativeFileHandle } from '../services/file-dialog.js';
import { getEffectiveGeoreference, getEffectiveHorizontalScale, type GeorefMutationDataLike } from '../lib/geo/effective-georef.js';
import { resolveMapUnitToMetreScale } from '../lib/geo/geo-scale.js';
import { resolveProjection } from '../lib/geo/reproject.js';
import { toast } from '../components/ui/toast.js';
import proj4 from 'proj4';
import { acquireFederationLoadSlot, releaseFederationLoadSlot } from './federationLoadGate.js';
import { acquireFileBuffer } from '../utils/acquireFileBuffer.js';

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
  return resolveMapUnitToMetreScale(georef.projectedCRS.mapUnitScale, georef.lengthUnitScale ?? 1);
}

function getAxis(georef: ModelGeoref): { a: number; o: number; scale: number; denom: number } {
  const conversion = georef.mapConversion;
  const a = conversion.xAxisAbscissa ?? 1;
  const o = conversion.xAxisOrdinate ?? 0;
  // Use the effective horizontal scale: viewer geometry is already in metres,
  // so applying IfcMapConversion.Scale raw would double-scale — see issue #595.
  const mapUnitScale = resolveMapUnitToMetreScale(georef.projectedCRS.mapUnitScale, georef.lengthUnitScale ?? 1);
  const scale = getEffectiveHorizontalScale(conversion.scale, mapUnitScale, georef.lengthUnitScale ?? 1);
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
  const sourceAxis = getAxis(source);
  const refAxis = getAxis(reference);
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

/**
 * Reproject every vertex from a source model's georeference into the reference
 * model's viewer-space frame using proj4 between the two projected CRSs.
 *
 * Used for federated loads where models declare different IfcProjectedCRSs
 * (e.g. EPSG:28992 + EPSG:7415 mixed RD/NAP Dutch sets, or EPSG:25831 UTM +
 * EPSG:28992 mixed). The pipeline per vertex:
 *
 *   viewer(Yup)  ──(source RTC/shift, axis swap)──▶  IFC(Zup, source)
 *   IFC(source)  ──(source MapConversion)──────────▶  source projected (eS,nS,hS)
 *   projected    ──(proj4: srcDef → refDef)────────▶  reference projected (eR,nR)
 *   projected    ──(reference MapConversion inverse)▶  IFC(Zup, reference)
 *   IFC(ref)     ──(axis swap, reference RTC/shift)─▶  viewer(Yup, reference frame)
 *
 * Vertical: height passes through unchanged. Browser-side proj4 has no vertical
 * datum transforms (no NTv2/gtx grids), so cross-CRS vertical mismatches are
 * left for the user to resolve via the per-model orthogonalHeight editor.
 *
 * Normals are NOT rotated. Cross-CRS rotations between projected systems in the
 * same locality are sub-degree, and recomputing per-vertex would require a
 * Jacobian per mesh — acceptable trade-off for now, document if it bites.
 */
async function alignGeometryAcrossCrs(
  geometry: FederatedGeometryResult,
  source: ModelGeoref,
  reference: ModelGeoref,
): Promise<boolean> {
  const sourceProjDef = await resolveProjection(source.projectedCRS);
  const refProjDef = await resolveProjection(reference.projectedCRS);
  if (!sourceProjDef || !refProjDef) return false;

  const sourceMapUnitScale = getMapUnitScale(source);
  const refMapUnitScale = getMapUnitScale(reference);
  const sourceAxis = getAxis(source);
  const refAxis = getAxis(reference);
  const sourceOffset = totalYupOffset(source.coordinateInfo);
  const refOffset = totalYupOffset(reference.coordinateInfo);

  const refDenom = refAxis.scale * refAxis.denom;
  if (Math.abs(refDenom) < 1e-12) return false;
  const invRefDenom = 1 / refDenom;

  const sourceConv = source.mapConversion;
  const refConv = reference.mapConversion;

  const bounds = emptyBounds();
  let found = false;
  let projFailures = 0;
  let attempts = 0;
  let firstProjError: unknown = null;

  for (const mesh of geometry.meshes) {
    const positions = mesh.positions;
    for (let i = 0; i < positions.length; i += 3) {
      const vx = positions[i];
      const vy = positions[i + 1];
      const vz = positions[i + 2];
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) continue;

      // viewer(Y-up, source-local) → world(Y-up) → IFC(Z-up, source)
      const wx = vx + sourceOffset.x;
      const wy = vy + sourceOffset.y;
      const wz = vz + sourceOffset.z;
      const ifcXs = wx;
      const ifcYs = -wz;
      const ifcZs = wy;

      // IFC(source) → source projected (apply source MapConversion)
      const eS = sourceConv.eastings * sourceMapUnitScale
        + sourceAxis.scale * (sourceAxis.a * ifcXs - sourceAxis.o * ifcYs);
      const nS = sourceConv.northings * sourceMapUnitScale
        + sourceAxis.scale * (sourceAxis.o * ifcXs + sourceAxis.a * ifcYs);
      const hS = sourceConv.orthogonalHeight * sourceMapUnitScale + ifcZs;

      // source projected → reference projected via proj4
      attempts += 1;
      let eR: number;
      let nR: number;
      try {
        const projected = proj4(sourceProjDef, refProjDef, [eS, nS]);
        eR = projected[0];
        nR = projected[1];
      } catch (error) {
        projFailures += 1;
        if (firstProjError == null) firstProjError = error;
        continue;
      }
      if (!Number.isFinite(eR) || !Number.isFinite(nR)) {
        projFailures += 1;
        continue;
      }
      // Height transformed under identity (no vertical datum hop in browser).
      const hR = hS;

      // reference projected → IFC(reference): invert reference MapConversion
      const dE = eR - refConv.eastings * refMapUnitScale;
      const dN = nR - refConv.northings * refMapUnitScale;
      const ifcXr = invRefDenom * (refAxis.a * dE + refAxis.o * dN);
      const ifcYr = invRefDenom * (-refAxis.o * dE + refAxis.a * dN);
      const ifcZr = hR - refConv.orthogonalHeight * refMapUnitScale;

      // IFC(Z-up, reference) → world(Y-up) → viewer(Y-up, reference-local)
      const refWorldX = ifcXr;
      const refWorldY = ifcZr;
      const refWorldZ = -ifcYr;
      const alignedX = refWorldX - refOffset.x;
      const alignedY = refWorldY - refOffset.y;
      const alignedZ = refWorldZ - refOffset.z;

      positions[i] = alignedX;
      positions[i + 1] = alignedY;
      positions[i + 2] = alignedZ;
      found = updateBounds(bounds, alignedX, alignedY, alignedZ) || found;
    }
  }

  if (!found) {
    console.warn(
      `[ifc-lite] Cross-CRS alignment failed: ${projFailures}/${attempts} `
      + `vertex transforms failed for ${source.projectedCRS.name} → ${reference.projectedCRS.name}; `
      + 'no vertices were successfully reprojected. Leaving geometry untouched.',
      firstProjError,
    );
    return false;
  }

  geometry.coordinateInfo = {
    originShift: reference.coordinateInfo?.originShift ?? { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: reference.coordinateInfo?.hasLargeCoordinates ?? false,
    wasmRtcOffset: reference.coordinateInfo?.wasmRtcOffset,
    buildingRotation: reference.coordinateInfo?.buildingRotation,
  };

  if (projFailures > 0) {
    console.warn(
      `[ifc-lite] Cross-CRS alignment: ${projFailures}/${attempts} vertex transforms `
      + `failed from ${source.projectedCRS.name} to ${reference.projectedCRS.name}. `
      + 'Those vertices are left at their original positions.',
      firstProjError,
    );
  }
  return true;
}

export type FederationAlignmentStatus = 'same-crs' | 'reprojected' | 'identity' | 'failed';

/**
 * Route alignment to the right strategy based on whether the source and
 * reference share a projected CRS. Returns a status describing how the model
 * was placed in the federation, suitable for surfacing in the UI.
 */
async function alignGeometryToReference(
  geometry: FederatedGeometryResult,
  source: ModelGeoref,
  reference: ModelGeoref,
): Promise<FederationAlignmentStatus> {
  if (canAlignInSameProjectedCrs(source, reference)) {
    const transform = buildGeorefAlignmentTransform(source, reference);
    if (!transform) return 'failed';
    if (isIdentityTransform(transform)) return 'identity';
    applyAlignmentTransformAndUpdateBounds(geometry, transform, reference.coordinateInfo);
    return 'same-crs';
  }
  const ok = await alignGeometryAcrossCrs(geometry, source, reference);
  return ok ? 'reprojected' : 'failed';
}

/**
 * Select the federation anchor model.
 *
 * Resolution order:
 *   1. `anchorModelIdOverride` from the store, if it points to a loaded model
 *      with a valid georeference.
 *   2. Earliest `loadedAt` model with a valid georeference (the default — gives
 *      a stable anchor across loads while letting the user override when they
 *      want a different model to drive the world frame).
 */
function findReferenceGeorefModel(): { modelId: string; georef: ModelGeoref } | null {
  const state = useViewerStore.getState();
  const override = state.anchorModelIdOverride;
  if (override) {
    const model = state.models.get(override) as FederatedModel | undefined;
    if (model?.ifcDataStore && model.geometryResult) {
      const georef = extractModelGeoref(
        model.ifcDataStore,
        model.geometryResult.coordinateInfo,
        state.georefMutations.get(override),
      );
      if (georef) return { modelId: override, georef };
    }
    // Fall through if the override no longer resolves — keeps loads
    // recoverable even if the user removed the anchor they had pinned.
  }

  const modelEntries = Array.from(state.models.entries()) as Array<[string, FederatedModel]>;
  const sorted = [...modelEntries].sort(([, a], [, b]) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
  for (const [modelId, model] of sorted) {
    if (!model.ifcDataStore || !model.geometryResult) continue;
    const georef = extractModelGeoref(
      model.ifcDataStore,
      model.geometryResult.coordinateInfo,
      state.georefMutations.get(modelId),
    );
    if (georef) return { modelId, georef };
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

      // Read file from disk. The browser path streams files above
      // `STREAM_SAB_THRESHOLD` directly into a SharedArrayBuffer, eliminating
      // the doubled peak (ArrayBuffer + SAB) of `await file.arrayBuffer()`
      // when the geometry pipeline copies into its own SAB. The native path
      // still reads via Tauri's Rust IPC because it bounds memory differently.
      // (#600)
      let buffer: ArrayBuffer;
      if (isNativeFileHandle(file)) {
        buffer = toExactArrayBuffer(await readNativeFile(file.path));
      } else {
        // The cast preserves the previous ArrayBuffer-shaped contract for
        // every downstream consumer. When the underlying store is a SAB,
        // downstream code only ever reads bytes via `new Uint8Array(buffer)`
        // / `new DataView(buffer)`, both of which work on either backing
        // store. The cast is purely type-system; runtime is identical.
        const acquired = await acquireFileBuffer(file as File);
        buffer = acquired.buffer as ArrayBuffer;
      }
      const fileSizeMB = buffer.byteLength / (1024 * 1024);

      // Detect point cloud formats first — we never run them through
      // detectFormat() (which is IFC-shaped) because they have their own
      // streaming pipeline that bypasses geometryResult.meshes.
      const pointCloudFormat = detectPointCloudFormat(file.name, buffer);

      // Detect file format
      const format: ReturnType<typeof detectFormat> | PointCloudFormat =
        pointCloudFormat ?? detectFormat(buffer);

      let parsedDataStore: IfcDataStore | null = null;
      let parsedGeometry: FederatedModel['geometryResult'] = null;
      let schemaVersion: SchemaVersion = 'IFC4';
      // Renderer handle for streamed point clouds; surviving model lifecycle
      // depends on persisting it onto the FederatedModel record.
      let pointCloudHandleId: number | undefined;

      if (format === 'las' || format === 'laz' || format === 'ply' || format === 'pcd' || format === 'e57' || format === 'pts' || format === 'xyz') {
        const renderer = getGlobalRenderer();
        if (!renderer) {
          setError('Renderer not initialised — try again after the viewer mounts.');
          setLoading(false);
          return null;
        }
        setProgress({ phase: `Streaming ${format.toUpperCase()}`, percent: 5 });
        const blob = isNativeFileHandle(file)
          ? new Blob([buffer])
          : (file as File);
        const incCount = useViewerStore.getState().incrementPointCloudAssetCount;
        const ingest = ingestPointCloud({
          format,
          blob,
          fileName: file.name,
          buffer,
          renderer,
          onProgress: setProgress,
          onAssetCountDelta: incCount,
        });
        // Expose cancellation while the stream is in-flight. Capture
        // the canceller as a named ref so the cleanup can verify the
        // store still points at us before clearing — a second
        // addModel() that began before this one settles must not lose
        // its Cancel button to our finally block.
        const { setActiveStreamCanceller } = useViewerStore.getState();
        const cancelStream = () => ingest.streamHandle.cancel();
        setActiveStreamCanceller(cancelStream);
        // ingest.done rejects on stream errors; ingestPointCloud's onError
        // callback already calls removePointCloudAsset + incCount(-1), so
        // the outer catch must NOT repeat that cleanup or the count goes
        // negative when other point clouds are still loaded.
        try {
          await ingest.done;
        } finally {
          if (useViewerStore.getState().activeStreamCanceller === cancelStream) {
            setActiveStreamCanceller(null);
          }
        }
        parsedDataStore = ingest.dataStore;
        parsedGeometry = ingest.geometryResult;
        schemaVersion = ingest.schemaVersion;
        pointCloudHandleId = ingest.rendererHandle.id;
      } else if (format === 'ifcx') {
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

      const referenceSelection = findReferenceGeorefModel();
      const referenceGeoref = referenceSelection?.georef ?? null;
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
      // Cache of pre-alignment vertex positions/normals for realignFederation().
      // Only populated when alignment actually runs, so single-model loads pay
      // no memory cost. See FederatedModel.preAlignmentPositions for rationale.
      let preAlignmentPositions: Float32Array[] | undefined;
      let preAlignmentNormals: (Float32Array | undefined)[] | undefined;
      let preAlignmentCoordinateInfo: CoordinateInfo | undefined;
      let federationAlignmentStatus: FederatedModel['federationAlignmentStatus'] = 'none';

      if (referenceGeoref && parsedGeoref) {
        // referenceSelection.modelId !== modelId always holds — the anchor was
        // already in the store before this addModel call.
        setProgress({ phase: 'Aligning georeferenced model', percent: 90 });
        preAlignmentPositions = parsedGeometry.meshes.map((mesh) => new Float32Array(mesh.positions));
        preAlignmentNormals = parsedGeometry.meshes.map((mesh) =>
          mesh.normals && mesh.normals.length > 0 ? new Float32Array(mesh.normals) : undefined,
        );
        preAlignmentCoordinateInfo = parsedGeometry.coordinateInfo;
        const status = await alignGeometryToReference(parsedGeometry, parsedGeoref, referenceGeoref);
        federationAlignmentStatus = status;
        if (status === 'reprojected') {
          toast.info(
            `Reprojected "${file.name}" from ${parsedGeoref.projectedCRS.name} `
            + `to ${referenceGeoref.projectedCRS.name} for federation alignment.`,
          );
        } else if (status === 'failed') {
          toast.error(
            `Could not align "${file.name}" with the federation anchor — `
            + `${parsedGeoref.projectedCRS.name} → ${referenceGeoref.projectedCRS.name} `
            + 'reprojection failed. The model is shown in its own local frame and may '
            + 'appear at the wrong real-world position.',
          );
        }
      } else if (parsedGeoref) {
        // This load is itself the federation anchor (first georeferenced model
        // in the federation, or the only one). Surface that to the UI.
        federationAlignmentStatus = 'anchor';
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
        // Point clouds need the same offset so picking / isolation /
        // property lookup resolve through the FederationRegistry's
        // global ID space — otherwise two pointcloud models with the
        // same local expressId collide.
        for (const asset of parsedGeometry.pointClouds ?? []) {
          asset.expressId = asset.expressId + idOffset;
        }
      }
      // Streamed point cloud: the GPU asset was opened with a synthetic
      // local expressId. After registerModelOffset() hands us an
      // idOffset, the renderer needs to emit the post-offset globalId
      // in picking + selection outputs — otherwise picks resolve to
      // the local id and collide across federated models. The shader
      // reads expressId from a per-asset uniform (`flags.x`) so this
      // is just a metadata update; no GPU buffer rewrite.
      if (idOffset > 0 && pointCloudHandleId !== undefined) {
        const renderer = getGlobalRenderer();
        if (renderer && parsedGeometry.pointClouds && parsedGeometry.pointClouds.length > 0) {
          // Use the asset that's already had idOffset folded in above
          // as the source of truth for the global id.
          const asset = parsedGeometry.pointClouds[0];
          renderer.relabelPointCloudAsset({ id: pointCloudHandleId }, asset.expressId);
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
        pointCloudHandleId,
        preAlignmentPositions,
        preAlignmentNormals,
        preAlignmentCoordinateInfo,
        federationAlignmentStatus,
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
  }, [setLoading, setError, setProgress, setIfcDataStore, setGeometryResult, storeAddModel, hasModels, registerModelOffset]);

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
