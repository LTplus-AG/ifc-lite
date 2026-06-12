/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Georeferencing / federation alignment helpers.
 *
 * Extracted verbatim from useIfcFederation.ts so the unified model-load path
 * (useIfcLoader's finalizeModel) can reuse them without a circular dependency.
 * Behaviour-preserving move — do not change the georef maths or the issue-#595 /
 * issue-#658 comments, which encode subtle alignment behaviour.
 */

import {
  type IfcDataStore,
  type MapConversion,
  type ProjectedCRS,
} from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import { getEffectiveGeoreference, getEffectiveHorizontalScale, hasStandardGeoreferencing, type GeorefMutationDataLike } from '../../lib/geo/effective-georef.js';
import { resolveMapUnitToMetreScale } from '../../lib/geo/geo-scale.js';
import { resolveProjection } from '../../lib/geo/reproject.js';
import proj4 from 'proj4';

type FederatedGeometryResult = NonNullable<FederatedModel['geometryResult']>;

export interface ModelGeoref {
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

export function extractModelGeoref(
  dataStore: IfcDataStore,
  coordinateInfo?: CoordinateInfo,
  mutations?: GeorefMutationDataLike,
): ModelGeoref | null {
  const georef = getEffectiveGeoreference(dataStore, coordinateInfo, mutations);
  // Only TRUE georeferencing (real IfcMapConversion + IfcProjectedCRS) may drive
  // federation alignment. A file with no IfcMapConversion gets a synthesised
  // `source: 'siteLocation'` georef (EPSG:4326 from IfcSite RefLatitude/Longitude/
  // Elevation) so it can still be pinned on the location map — but those are
  // geographic degrees plus a raw, un-unit-scaled site elevation, not a projected
  // metric frame. buildGeorefAlignmentTransform assumes projected eastings/
  // northings/height in metres, so feeding it site data places the second model
  // kilometres away: the BIMcollab ARC/STR pair share a site GUID but carry
  // RefElevation 0 vs 20000 mm, and the height term lands ARC ~20 km below STR.
  // Such models have no real georef relationship, so leave them in their own local
  // frames where they overlay correctly. hasStandardGeoreferencing() excludes
  // 'siteLocation' (see effective-georef.test.ts). (Regression from #658.)
  if (!hasStandardGeoreferencing(georef) || !georef?.mapConversion || !georef.projectedCRS?.name) {
    return null;
  }
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
  // NOTE: the refOffset handling is intentionally asymmetric between X and Z and
  // must NOT be "symmetrised". refOffset is subtracted from the FINAL viewer
  // coordinate on every axis. X maps positively (`tx = +xC`), so its offset is
  // folded into xC above. Z maps to the NEGATED north axis (`tz = -yC`), so its
  // offset is applied after the negation, leaving yC offset-free here. This
  // matches alignGeometryAcrossCrs: alignedZ = refWorldZ - refOffset.z with
  // refWorldZ = -ifcYr. Folding -refOffset.z into yC would flip its sign.
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
export async function alignGeometryToReference(
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
export function findReferenceGeorefModel(): { modelId: string; georef: ModelGeoref } | null {
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
