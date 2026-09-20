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
  resolveSpatialPlacement,
  type CoordinateInfo,
  type ModelSpatialReference,
} from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import { getEffectiveGeoreference, hasStandardGeoreferencing, type GeorefMutationDataLike } from '../../lib/geo/effective-georef.js';
import { resolveProjectionId } from '../../lib/geo/reproject.js';
import { totalYupOffset } from '../../lib/geo/coordinate-frame.js';
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

function buildSpatialAlignmentTransform(
  source: ModelSpatialPlacement,
  reference: ModelSpatialPlacement,
): AffineTransform3D | null {
  const resolved = resolveSpatialPlacement(source.spatialReference, reference.spatialReference, {
    sourceFrameOffset: totalYupOffset(source.coordinateInfo),
    targetFrameOffset: totalYupOffset(reference.coordinateInfo),
    // IFC commonly lacks a VerticalDatum.  The policy is explicit at this
    // adapter boundary; a declared conflict is still refused by the resolver.
    unknownVertical: 'assume-compatible',
  });
  return resolved.ok ? resolved.placement.sourceToFederation : null;
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
  sourceInfo?: CoordinateInfo,
  referenceInfo?: CoordinateInfo,
): void {
  const bounds = emptyBounds();
  let found = false;
  // Per-entity running bounds of the ALIGNED vertices — the re-measured world
  // box each meshed entity ends up with (see federationAlignAabb.ts for why
  // it is measured rather than corner-transformed). Only entities that
  // arrived with a box are accumulated; the rest are not given one.
  const entityBounds = new Map<number, EntityBoundsAccumulator>();

  for (const mesh of geometry.meshes) {
    const positions = mesh.positions;
    // Positions may be in the element's local frame (world = origin + position)
    // on the wasm path. Fold the per-mesh origin into the world coord BEFORE the
    // alignment affine; the result is written as absolute reference-frame coords
    // and the stale origin is cleared below (else the renderer's model-matrix
    // translate would double-count it). No-op when origin is absent/[0,0,0].
    const o = mesh.origin;
    const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
    const entityBox = mesh.geometryAabb ? entityBoundsFor(entityBounds, mesh.expressId) : null;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] + ox;
      const y = positions[i + 1] + oy;
      const z = positions[i + 2] + oz;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }

      // Inlined `applyAffineTransform` — this runs per vertex and must not
      // allocate a tuple each time. Keep the two in step; the aligned-box
      // tests in federationAlign.test.ts assert against these very positions.
      const alignedX = transform.m00 * x + transform.m01 * y + transform.m02 * z + transform.tx;
      const alignedY = transform.m10 * x + transform.m11 * y + transform.m12 * z + transform.ty;
      const alignedZ = transform.m20 * x + transform.m21 * y + transform.m22 * z + transform.tz;
      positions[i] = alignedX;
      positions[i + 1] = alignedY;
      positions[i + 2] = alignedZ;
      found = updateBounds(bounds, alignedX, alignedY, alignedZ) || found;
      // Read back the STORED f32, not the f64 above, so the entity's box bounds
      // the mesh as it now exists rather than the arithmetic that produced it.
      if (entityBox) extendEntityBounds(entityBox, positions[i], positions[i + 1], positions[i + 2]);
    }
    // Positions are now absolute in the reference viewer frame; drop the stale
    // local-frame origin so downstream consumers don't re-add it.
    if (o) mesh.origin = [0, 0, 0];

    const normals = mesh.normals;
    if (normals && normals.length >= 3) {
      alignNormals(normals, transform);
    }
  }

  // The per-entity world boxes (#1891) describe the vertices just rewritten, so
  // they take the same trip: meshed entities are re-measured from those very
  // vertices, and the instanced-only channel is corner-transformed. Both land
  // ABSOLUTE in the reference frame — the loop above works in viewer-local
  // coords, hence the offset strip/re-apply, and the reference offset is the
  // one the model now carries (set on `coordinateInfo` below).
  const referenceOffset = totalYupOffset(referenceInfo);
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
  source: ModelSpatialPlacement,
  reference: ModelSpatialPlacement,
): Promise<boolean> {
  // Reprojection is all-or-nothing.  Publishing a mesh with even one source
  // vertex left in its old CRS creates geometry that no later re-alignment can
  // repair: its pre-alignment snapshot contains one object in two frames.
  // Keep the originals until every vertex has a target coordinate.
  const originalPositions = geometry.meshes.map((mesh) => new Float32Array(mesh.positions));
  const originalOrigins = geometry.meshes.map((mesh) => mesh.origin ? [...mesh.origin] as [number, number, number] : undefined);
  const restoreSourceFrame = () => {
    for (let index = 0; index < geometry.meshes.length; index++) {
      geometry.meshes[index].positions = originalPositions[index];
      geometry.meshes[index].origin = originalOrigins[index];
    }
  };
  const sourceCrs = source.spatialReference.horizontal?.id;
  const referenceCrs = reference.spatialReference.horizontal?.id;
  if (!sourceCrs || !referenceCrs) return false;
  if (source.spatialReference.vertical && reference.spatialReference.vertical
    && source.spatialReference.vertical.id !== reference.spatialReference.vertical.id) return false;
  const sourceProjDef = await resolveProjectionId(sourceCrs);
  const refProjDef = await resolveProjectionId(referenceCrs);
  if (!sourceProjDef || !refProjDef) return false;

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
  // Entities where at least one vertex would not reproject. proj4 answers
  // `Infinity` for a point outside the target projection's domain, and that is
  // per POINT: an outlying vertex can stay in the source frame while the rest
  // of its element moves. The element's mesh then spans two coordinate frames,
  // so its measurement is withdrawn and it loses its box entirely rather than
  // publishing one that covers only the half that moved.
  const partiallyReprojected = new Set<number>();

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
      const projected = proj4(sourceProjDef, refProjDef, [eS, nS]);
      eR = projected[0];
      nR = projected[1];
    } catch (error) {
      if (firstProjError == null) firstProjError = error;
      return null;
    }
    if (!Number.isFinite(eR) || !Number.isFinite(nR)) return null;
    // Height transformed under identity (no vertical datum hop in browser).
    const hR = hS;

    // Reference projected frame → reference viewer frame through the same
    // neutral inverse used by same-CRS and point-cloud placement.
    return projectedToLocalViewer(reference.spatialReference, [eR, nR, hR], refOffset);
  };

  for (const mesh of geometry.meshes) {
    const positions = mesh.positions;
    // Fold the per-element local-frame origin into the world coord before the
    // reprojection (proj4 is nonlinear, so it must run on the absolute world
    // vertex). Output is absolute reference-frame coords; the stale origin is
    // cleared below. No-op when origin is absent/[0,0,0].
    const o = mesh.origin;
    const oox = o ? o[0] : 0, ooy = o ? o[1] : 0, ooz = o ? o[2] : 0;
    const entityBox = mesh.geometryAabb ? entityBoundsFor(entityBounds, mesh.expressId) : null;
    let meshPartiallyReprojected = false;
    for (let i = 0; i < positions.length; i += 3) {
      const vx = positions[i] + oox;
      const vy = positions[i + 1] + ooy;
      const vz = positions[i + 2] + ooz;
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) continue;

      attempts += 1;
      const aligned = toReferenceFrame(vx, vy, vz);
      if (!aligned) {
        projFailures += 1;
        meshPartiallyReprojected = true;
        continue;
      }
      const [alignedX, alignedY, alignedZ] = aligned;

      positions[i] = alignedX;
      positions[i + 1] = alignedY;
      positions[i + 2] = alignedZ;
      found = updateBounds(bounds, alignedX, alignedY, alignedZ) || found;
      // The STORED f32, so the box bounds the mesh as it now exists.
      if (entityBox) extendEntityBounds(entityBox, positions[i], positions[i + 1], positions[i + 2]);
    }
    if (meshPartiallyReprojected) partiallyReprojected.add(mesh.expressId);
    // Positions are now absolute in the reference viewer frame; drop the stale
    // local-frame origin so downstream consumers don't re-add it.
    if (o) mesh.origin = [0, 0, 0];
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

  // Same trip for the per-entity world boxes (#1891): meshed entities re-measured
  // from the reprojected vertices, the instanced-only channel corner-transformed
  // (proj4 is nonlinear, so those eight corners are reprojected individually and
  // the AABB re-derived from the results) — see federationAlignAabb.ts.
  for (const expressId of partiallyReprojected) entityBounds.delete(expressId);
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
    if (isIdentityTransform(transform)) return 'identity';
    applyAlignmentTransformAndUpdateBounds(
      geometry,
      transform,
      source.coordinateInfo,
      reference.coordinateInfo,
    );
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
export function findReferenceSpatialModel(): { modelId: string; placement: ModelSpatialPlacement } | null {
  const state = useViewerStore.getState();
  const override = state.anchorModelIdOverride;
  if (override) {
    const model = state.models.get(override) as FederatedModel | undefined;
    if (model?.ifcDataStore && model.geometryResult) {
      const placement = extractModelSpatialPlacement(
        model.ifcDataStore,
        model.geometryResult.coordinateInfo,
        state.georefMutations.get(override),
      );
      if (placement) return { modelId: override, placement };
    }
    // Fall through if the override no longer resolves — keeps loads
    // recoverable even if the user removed the anchor they had pinned.
  }

  const modelEntries = Array.from(state.models.entries()) as Array<[string, FederatedModel]>;
  const sorted = [...modelEntries].sort(([, a], [, b]) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
  for (const [modelId, model] of sorted) {
    if (!model.ifcDataStore || !model.geometryResult) continue;
    const placement = extractModelSpatialPlacement(
      model.ifcDataStore,
      model.geometryResult.coordinateInfo,
      state.georefMutations.get(modelId),
    );
    if (placement) return { modelId, placement };
  }
  return null;
}
