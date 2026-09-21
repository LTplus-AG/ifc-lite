/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Georeferencing / federation alignment helpers.
 *
 * Extracted verbatim from useIfcFederation.ts so the unified model-load path
 * (useIfcLoader's finalizeModel) can reuse them without a circular dependency.
 * The extraction was behaviour-preserving; keep the issue-#595 / issue-#658
 * comments, which encode subtle alignment behaviour. Since then, #2526 routed
 * every read of a model's MapConversion through `effectiveConv` (the
 * map-absolute guard); that is the only deliberate change to the maths.
 */

import {
  type IfcDataStore,
} from '@ifc-lite/parser';
import {
  localViewerToProjected,
  projectedToLocalViewer,
  type CoordinateInfo,
  type ModelSpatialReference,
} from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import { getEffectiveGeoreference, hasStandardGeoreferencing, type GeorefMutationDataLike } from '../../lib/geo/effective-georef.js';
import { resolveProjectionId } from '../../lib/geo/reproject.js';
import { totalYupOffset } from '../../lib/geo/coordinate-frame.js';
import { buildSpatialAlignmentTransform, isIdentitySpatialTransform } from './federationSpatialTransform.js';
import { spatialReferenceFromIfc } from '../../lib/geo/ifc-spatial-reference.js';
import {
  alignEntityWorldAabbs,
  applyAffineTransform,
  entityBoundsFor,
  extendEntityBounds,
  finishEntityBounds,
  toAbsoluteFrameMap,
  type AffineTransform3D,
  type EntityBoundsAccumulator,
} from './federationAlignAabb.js';
import { alignNormals } from './alignment-normals.js';
import { projectedUnitToMetres } from './projected-units.js';
import { canonicalRendererPlacement } from './federationCanonicalReference.js';
import proj4 from 'proj4';

type FederatedGeometryResult = NonNullable<FederatedModel['geometryResult']>;

/** One format-neutral model placement record used by every federation path. */
export interface ModelSpatialPlacement {
  spatialReference: ModelSpatialReference;
  coordinateInfo?: CoordinateInfo;
}

export function extractModelSpatialPlacement(
  dataStore: IfcDataStore,
  coordinateInfo?: CoordinateInfo,
  mutations?: GeorefMutationDataLike,
): ModelSpatialPlacement | null {
  const georef = getEffectiveGeoreference(dataStore, coordinateInfo, mutations);
  // Only TRUE georeferencing (real IfcMapConversion + IfcProjectedCRS) may drive
  // federation alignment. A file with no IfcMapConversion gets a synthesised
  // `source: 'siteLocation'` georef (EPSG:4326 from IfcSite RefLatitude/Longitude/
  // Elevation) so it can still be pinned on the location map — but those are
  // geographic degrees plus a raw, un-unit-scaled site elevation, not a projected
  // metric frame. The neutral placement resolver assumes projected eastings/
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
    coordinateInfo,
    spatialReference: spatialReferenceFromIfc({
      mapConversion: georef.mapConversion,
      projectedCRS: georef.projectedCRS,
      lengthUnitScale: georef.lengthUnitScale,
      coordinateInfo,
    }),
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

function applyAlignmentTransformAndUpdateBounds(
  geometry: FederatedGeometryResult,
  transform: AffineTransform3D,
  sourceInfo?: CoordinateInfo,
  referenceInfo?: CoordinateInfo,
): boolean {
  // Same-CRS alignment is just as destructive as a proj4 hop.  Stage the
  // entire result before publishing it: a NaN, f32 overflow, or an exception
  // while updating dependent bounds must never leave half a model aligned.
  const originalPositions = geometry.meshes.map((mesh) => new Float32Array(mesh.positions));
  const originalOrigins = geometry.meshes.map((mesh) => mesh.origin ? [...mesh.origin] as [number, number, number] : undefined);
  const originalNormals: Array<Float32Array<ArrayBufferLike>> = geometry.meshes
    .map((mesh) => new Float32Array(mesh.normals));
  const originalAabbs = geometry.meshes.map((mesh) => mesh.geometryAabb ? structuredClone(mesh.geometryAabb) : undefined);
  const originalCoordinateInfo = structuredClone(geometry.coordinateInfo);
  const originalInstancedAabbs = geometry.instancedGeometryAabbs
    ? new Map(geometry.instancedGeometryAabbs)
    : undefined;
  const restoreSourceFrame = () => {
    for (let index = 0; index < geometry.meshes.length; index++) {
      const mesh = geometry.meshes[index];
      mesh.positions = originalPositions[index];
      mesh.origin = originalOrigins[index];
      mesh.normals = originalNormals[index]!;
      if (originalAabbs[index]) mesh.geometryAabb = structuredClone(originalAabbs[index]);
      else delete mesh.geometryAabb;
    }
    geometry.coordinateInfo = structuredClone(originalCoordinateInfo);
    geometry.instancedGeometryAabbs = originalInstancedAabbs
      ? new Map(originalInstancedAabbs)
      : undefined;
  };
  const bounds = emptyBounds();
  let found = false;
  // Per-entity running bounds of the ALIGNED vertices — the re-measured world
  // box each meshed entity ends up with (see federationAlignAabb.ts for why
  // it is measured rather than corner-transformed). Only entities that
  // arrived with a box are accumulated; the rest are not given one.
  const entityBounds = new Map<number, EntityBoundsAccumulator>();

  const stagedMeshes: Array<{
    positions: Float32Array;
    origin: [number, number, number];
    normals: Float32Array<ArrayBufferLike>;
  }> = [];
  for (const mesh of geometry.meshes) {
    const positions = mesh.positions;
    // Keep each mesh's local frame local.  Folding a million-metre origin into
    // f32 positions destroys centimetre detail; affine linear terms apply to
    // residual positions while the translated origin stays a f64 tuple.
    const o = mesh.origin;
    const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
    const transformedOrigin = applyAffineTransform(transform, ox, oy, oz);
    if (!transformedOrigin.every(Number.isFinite)) {
      restoreSourceFrame();
      console.warn('[ifc-lite] Same-CRS alignment refused: mesh origin is non-finite.');
      return false;
    }
    const staged = new Float32Array(positions.length);
    const entityBox = mesh.geometryAabb ? entityBoundsFor(entityBounds, mesh.expressId) : null;
    for (let i = 0; i < positions.length; i += 3) {
      const localX = positions[i];
      const localY = positions[i + 1];
      const localZ = positions[i + 2];
      if (!Number.isFinite(localX) || !Number.isFinite(localY) || !Number.isFinite(localZ)) {
        restoreSourceFrame();
        console.warn('[ifc-lite] Same-CRS alignment refused: source contains a non-finite vertex.');
        return false;
      }

      // Transform the WORLD vertex, then subtract a separately transformed
      // local origin. Applying the affine to `position` alone cancels the
      // source origin (and loses the exact 2.6Mm+centimetre scan case).
      const x = localX + ox, y = localY + oy, z = localZ + oz;
      const alignedX = transform.m00 * x + transform.m01 * y + transform.m02 * z + transform.tx;
      const alignedY = transform.m10 * x + transform.m11 * y + transform.m12 * z + transform.ty;
      const alignedZ = transform.m20 * x + transform.m21 * y + transform.m22 * z + transform.tz;
      const residualX = Math.fround(alignedX - transformedOrigin[0]);
      const residualY = Math.fround(alignedY - transformedOrigin[1]);
      const residualZ = Math.fround(alignedZ - transformedOrigin[2]);
      if (!Number.isFinite(residualX) || !Number.isFinite(residualY) || !Number.isFinite(residualZ)) {
        restoreSourceFrame();
        console.warn('[ifc-lite] Same-CRS alignment refused: f32 output would overflow.');
        return false;
      }
      staged[i] = residualX;
      staged[i + 1] = residualY;
      staged[i + 2] = residualZ;
      found = updateBounds(
        bounds,
        transformedOrigin[0] + staged[i],
        transformedOrigin[1] + staged[i + 1],
        transformedOrigin[2] + staged[i + 2],
      ) || found;
      // Read the staged f32 residual back with its f64 origin, so bounds match
      // the actual mesh representation rather than ideal arithmetic.
      if (entityBox) extendEntityBounds(entityBox,
        transformedOrigin[0] + staged[i],
        transformedOrigin[1] + staged[i + 1],
        transformedOrigin[2] + staged[i + 2]);
    }

    const normals = mesh.normals;
    const stagedNormals: Float32Array<ArrayBufferLike> = new Float32Array(normals);
    if (normals.length >= 3) {
      alignNormals(stagedNormals, transform);
      if (![...stagedNormals].every(Number.isFinite)) {
        restoreSourceFrame();
        console.warn('[ifc-lite] Same-CRS alignment refused: normal transform produced a non-finite value.');
        return false;
      }
    }
    stagedMeshes.push({ positions: staged, origin: [transformedOrigin[0], transformedOrigin[1], transformedOrigin[2]], normals: stagedNormals });
  }

  // The per-entity world boxes (#1891) describe the vertices just rewritten, so
  // they take the same trip: meshed entities are re-measured from those very
  // vertices, and the instanced-only channel is corner-transformed. Both land
  // ABSOLUTE in the reference frame — the loop above works in viewer-local
  // coords, hence the offset strip/re-apply, and the reference offset is the
  // one the model now carries (set on `coordinateInfo` below).
  const referenceOffset = totalYupOffset(referenceInfo);
  try {
    for (const [index, mesh] of geometry.meshes.entries()) {
      const staged = stagedMeshes[index];
      mesh.positions = staged.positions;
      mesh.origin = staged.origin;
      mesh.normals = staged.normals;
    }
    alignEntityWorldAabbs(
      geometry,
      toAbsoluteFrameMap(
        (x, y, z) => applyAffineTransform(transform, x, y, z),
        totalYupOffset(sourceInfo),
        referenceOffset,
      ),
      finishEntityBounds(entityBounds, referenceOffset),
    );

    // These vertices have been re-baked into a new affine frame. Preserve the
    // legacy offsets needed to interpret them, but deliberately drop
    // `wasmRtcFrame`: it describes the source bytes' mesh-parse frame and would
    // be false provenance for overlays parsed after this mutation.
    geometry.coordinateInfo = {
      originShift: referenceInfo?.originShift ?? { x: 0, y: 0, z: 0 },
      originalBounds: found ? bounds : zeroBounds(),
      shiftedBounds: found ? bounds : zeroBounds(),
      hasLargeCoordinates: referenceInfo?.hasLargeCoordinates ?? false,
      wasmRtcOffset: referenceInfo?.wasmRtcOffset,
      buildingRotation: referenceInfo?.buildingRotation,
    };
    return true;
  } catch (error) {
    restoreSourceFrame();
    console.warn('[ifc-lite] Same-CRS alignment aborted; restored the complete source frame.', error);
    return false;
  }
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
 * Vertical: height passes through unchanged only after the caller proves both
 * references declare the same vertical CRS. Browser-side proj4 has no vertical
 * datum transforms (no NTv2/gtx grids), so unknown or mismatched vertical
 * references are refused for explicit manual placement instead.
 *
 * Normals are NOT rotated. Cross-CRS rotations between projected systems in the
 * same locality are sub-degree, and recomputing per-vertex would require a
 * Jacobian per mesh — acceptable trade-off for now, document if it bites.
 */
async function alignGeometryAcrossCrs(
  geometry: FederatedGeometryResult,
  source: ModelSpatialPlacement,
  reference: ModelSpatialPlacement,
): Promise<boolean> {
  // Reprojection is all-or-nothing.  Publishing a mesh with even one source
  // vertex left in its old CRS creates geometry that no later re-alignment can
  // repair: its pre-alignment snapshot contains one object in two frames.
  // Keep the originals until every vertex has a target coordinate.
  const originalPositions = geometry.meshes.map((mesh) => new Float32Array(mesh.positions));
  const originalOrigins = geometry.meshes.map((mesh) => mesh.origin ? [...mesh.origin] as [number, number, number] : undefined);
  const originalAabbs = geometry.meshes.map((mesh) => mesh.geometryAabb ? structuredClone(mesh.geometryAabb) : undefined);
  const originalCoordinateInfo = structuredClone(geometry.coordinateInfo);
  const originalInstancedAabbs = geometry.instancedGeometryAabbs
    ? new Map(geometry.instancedGeometryAabbs)
    : undefined;
  const restoreSourceFrame = () => {
    for (let index = 0; index < geometry.meshes.length; index++) {
      geometry.meshes[index].positions = originalPositions[index];
      geometry.meshes[index].origin = originalOrigins[index];
      const aabb = originalAabbs[index];
      if (aabb) geometry.meshes[index].geometryAabb = structuredClone(aabb);
      else delete geometry.meshes[index].geometryAabb;
    }
    geometry.coordinateInfo = structuredClone(originalCoordinateInfo);
    geometry.instancedGeometryAabbs = originalInstancedAabbs
      ? new Map(originalInstancedAabbs)
      : undefined;
  };
  const sourceCrs = source.spatialReference.horizontal?.id;
  const referenceCrs = reference.spatialReference.horizontal?.id;
  if (!sourceCrs || !referenceCrs) return false;
  // Browser proj4 only supplies a horizontal operation. An absent or different
  // vertical datum is not safe to carry through unchanged; leave the model in
  // its own frame for the explicit manual-placement workflow instead.
  if (!source.spatialReference.vertical || !reference.spatialReference.vertical
    || source.spatialReference.vertical.id !== reference.spatialReference.vertical.id) return false;
  const sourceProjDef = await resolveProjectionId(sourceCrs);
  const refProjDef = await resolveProjectionId(referenceCrs);
  if (!sourceProjDef || !refProjDef) return false;
  const sourceProjectedUnit = projectedUnitToMetres(sourceProjDef);
  const referenceProjectedUnit = projectedUnitToMetres(refProjDef);
  if (!sourceProjectedUnit || !referenceProjectedUnit) return false;

  const sourceOffset = totalYupOffset(source.coordinateInfo);
  const refOffset = totalYupOffset(reference.coordinateInfo);

  const bounds = emptyBounds();
  let found = false;
  let projFailures = 0;
  let attempts = 0;
  let firstProjError: unknown = null;
  // Per-entity running bounds of the reprojected vertices — see the same-CRS
  // path above and federationAlignAabb.ts.
  const entityBounds = new Map<number, EntityBoundsAccumulator>();
  /**
   * One point from the source model's viewer frame into the reference model's,
   * via both MapConversions and a proj4 hop. Returns null when the hop failed
   * or produced non-finite output; `firstProjError` records the first cause.
   *
   * The vertex loop and the world-box corners share this so the box and the
   * geometry it describes cannot be reprojected by two different chains — a
   * second copy of the pipeline is a second place for them to drift apart.
   */
  const toReferenceFrame = (
    vx: number,
    vy: number,
    vz: number,
  ): [number, number, number] | null => {
    // Source viewer frame → source projected frame.  The adapter owns all
    // format-specific units, axes and map-operation semantics.
    const projectedSource = localViewerToProjected(source.spatialReference, [vx, vy, vz], sourceOffset);
    if (!projectedSource) return null;
    const [eS, nS, hS] = projectedSource;

    // source projected → reference projected via proj4
    let eR: number;
    let nR: number;
    try {
      const projected = proj4(sourceProjDef, refProjDef, [
        eS / sourceProjectedUnit,
        nS / sourceProjectedUnit,
      ]);
      eR = projected[0] * referenceProjectedUnit;
      nR = projected[1] * referenceProjectedUnit;
    } catch (error) {
      if (firstProjError == null) firstProjError = error;
      return null;
    }
    if (!Number.isFinite(eR) || !Number.isFinite(nR)) return null;
    // Height transformed under identity (no vertical datum hop in browser).
    const hR = hS;

    // Reference projected frame → reference viewer frame through the same
    // neutral inverse used by same-CRS and point-cloud placement.
    const target = projectedToLocalViewer(reference.spatialReference, [eR, nR, hR], refOffset);
    return target ? [target[0], target[1], target[2]] : null;
  };

  const stagedMeshes: Array<{ positions: Float32Array; origin: [number, number, number] } | undefined> = new Array(geometry.meshes.length);
  for (const [meshIndex, mesh] of geometry.meshes.entries()) {
    const positions = mesh.positions;
    // Fold the per-element local-frame origin into the world coord before the
    // reprojection (proj4 is nonlinear, so it must run on the absolute world
    // vertex). Output is absolute reference-frame coords; the stale origin is
    // cleared below. No-op when origin is absent/[0,0,0].
    const o = mesh.origin;
    const oox = o ? o[0] : 0, ooy = o ? o[1] : 0, ooz = o ? o[2] : 0;
    const entityBox = mesh.geometryAabb ? entityBoundsFor(entityBounds, mesh.expressId) : null;
    const alignedVertices: Array<readonly [number, number, number]> = [];
    for (let i = 0; i < positions.length; i += 3) {
      const vx = positions[i] + oox;
      const vy = positions[i + 1] + ooy;
      const vz = positions[i + 2] + ooz;
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
        restoreSourceFrame();
        console.warn('[ifc-lite] Cross-CRS alignment refused: source contains a non-finite vertex.');
        return false;
      }

      attempts += 1;
      const aligned = toReferenceFrame(vx, vy, vz);
      if (!aligned) {
        projFailures += 1;
        restoreSourceFrame();
        console.warn(
          `[ifc-lite] Cross-CRS alignment refused: ${projFailures}/${attempts} vertex transforms failed; `
          + 'the model remains wholly in its source frame.',
          firstProjError,
        );
        return false;
      }
      const [alignedX, alignedY, alignedZ] = aligned;
      found = updateBounds(bounds, alignedX, alignedY, alignedZ) || found;
      alignedVertices.push(aligned);
      if (entityBox) extendEntityBounds(entityBox, alignedX, alignedY, alignedZ);
    }
    if (alignedVertices.length === 0) continue;

    // Keep the derived frame local: writing absolute ~million-metre positions
    // to f32 loses centimetres. Transform the source origin when it exists;
    // otherwise seed the local frame at the first transformed vertex.
    const transformedOrigin = o
      ? toReferenceFrame(oox, ooy, ooz)
      : alignedVertices[0];
    if (!transformedOrigin) {
      restoreSourceFrame();
      console.warn('[ifc-lite] Cross-CRS alignment refused: mesh origin could not be transformed.');
      return false;
    }
    const staged = new Float32Array(positions.length);
    for (let index = 0; index < alignedVertices.length; index += 1) {
      const vertex = alignedVertices[index];
      const x = vertex[0] - transformedOrigin[0];
      const y = vertex[1] - transformedOrigin[1];
      const z = vertex[2] - transformedOrigin[2];
      const nx = Math.fround(x), ny = Math.fround(y), nz = Math.fround(z);
      if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
        restoreSourceFrame();
        console.warn('[ifc-lite] Cross-CRS alignment refused: f32 output would overflow.');
        return false;
      }
      const base = index * 3;
      staged[base] = nx; staged[base + 1] = ny; staged[base + 2] = nz;
    }
    stagedMeshes[meshIndex] = { positions: staged, origin: [transformedOrigin[0], transformedOrigin[1], transformedOrigin[2]] };
  }

  if (!found) {
    restoreSourceFrame();
    console.warn(
      `[ifc-lite] Cross-CRS alignment failed: ${projFailures}/${attempts} `
      + `vertex transforms failed for ${sourceCrs} → ${referenceCrs}; `
      + 'no vertices were successfully reprojected. Leaving geometry untouched.',
      firstProjError,
    );
    return false;
  }

  if (projFailures > 0) {
    restoreSourceFrame();
    console.warn(
      `[ifc-lite] Cross-CRS alignment refused: ${projFailures}/${attempts} vertex transforms failed; `
      + 'the model remains wholly in its source frame.',
      firstProjError,
    );
    return false;
  }

  // Nothing has been published yet. Commit the complete staged vertex result
  // before updating dependent boxes/frame metadata; any exception below rolls
  // every touched field back through `restoreSourceFrame`.
  try {
    for (const [index, mesh] of geometry.meshes.entries()) {
      const staged = stagedMeshes[index];
      if (!staged) continue;
      mesh.positions = staged.positions;
      mesh.origin = staged.origin;
    }

  // Same trip for the per-entity world boxes (#1891): meshed entities re-measured
  // from the reprojected vertices, the instanced-only channel corner-transformed
  // (proj4 is nonlinear, so those eight corners are reprojected individually and
  // the AABB re-derived from the results) — see federationAlignAabb.ts.
  alignEntityWorldAabbs(
    geometry,
    toAbsoluteFrameMap(toReferenceFrame, sourceOffset, refOffset),
    finishEntityBounds(entityBounds, refOffset),
  );

  // A CRS reprojection also creates a derived vertex frame, so it must not
  // manufacture source-byte `wasmRtcFrame` provenance. Identity alignment
  // returns before this assignment and therefore preserves the exact frame.
  geometry.coordinateInfo = {
    originShift: reference.coordinateInfo?.originShift ?? { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: reference.coordinateInfo?.hasLargeCoordinates ?? false,
    wasmRtcOffset: reference.coordinateInfo?.wasmRtcOffset,
    buildingRotation: reference.coordinateInfo?.buildingRotation,
  };

    return true;
  } catch (error) {
    restoreSourceFrame();
    console.warn('[ifc-lite] Cross-CRS alignment aborted; restored the complete source frame.', error);
    return false;
  }
}

export type FederationAlignmentStatus = 'same-crs' | 'reprojected' | 'identity' | 'failed';

/**
 * Route alignment to the right strategy based on whether the source and
 * reference share a projected CRS. Returns a status describing how the model
 * was placed in the federation, suitable for surfacing in the UI.
 */
export async function alignGeometryToReference(
  geometry: FederatedGeometryResult,
  source: ModelSpatialPlacement,
  reference: ModelSpatialPlacement,
): Promise<FederationAlignmentStatus> {
  if (source.spatialReference.horizontal?.id === reference.spatialReference.horizontal?.id) {
    const transform = buildSpatialAlignmentTransform(source, reference);
    if (!transform) return 'failed';
    if (isIdentitySpatialTransform(transform)) return 'identity';
    const applied = applyAlignmentTransformAndUpdateBounds(
      geometry,
      transform,
      source.coordinateInfo,
      reference.coordinateInfo,
    );
    return applied ? 'same-crs' : 'failed';
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
export function findReferenceSpatialModel(): { modelId: string; placement: ModelSpatialPlacement } | null {
  const state = useViewerStore.getState();
  const override = state.anchorModelIdOverride;
  if (override) {
    const model = state.models.get(override) as FederatedModel | undefined;
    if (model?.spatialReference && model.geometryResult
      && model.spatialReference.horizontal && model.spatialReference.vertical) {
      return { modelId: override, placement: canonicalRendererPlacement({ spatialReference: model.spatialReference, coordinateInfo: model.geometryResult.coordinateInfo }) };
    }
    if (model?.ifcDataStore && model.geometryResult) {
      const placement = extractModelSpatialPlacement(
        model.ifcDataStore,
        model.geometryResult.coordinateInfo,
        state.georefMutations.get(override),
      );
      if (placement) return { modelId: override, placement: canonicalRendererPlacement(placement) };
    }
    // Fall through if the override no longer resolves — keeps loads
    // recoverable even if the user removed the anchor they had pinned.
  }

  const modelEntries = Array.from(state.models.entries()) as Array<[string, FederatedModel]>;
  const sorted = [...modelEntries].sort(([, a], [, b]) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
  for (const [modelId, model] of sorted) {
    if (model.spatialReference && model.geometryResult
      && model.spatialReference.horizontal && model.spatialReference.vertical) {
      return { modelId, placement: canonicalRendererPlacement({ spatialReference: model.spatialReference, coordinateInfo: model.geometryResult.coordinateInfo }) };
    }
    if (!model.ifcDataStore || !model.geometryResult) continue;
    const placement = extractModelSpatialPlacement(
      model.ifcDataStore,
      model.geometryResult.coordinateInfo,
      state.georefMutations.get(modelId),
    );
    if (placement) return { modelId, placement: canonicalRendererPlacement(placement) };
  }
  return null;
}
