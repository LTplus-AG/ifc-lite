/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Footprint reader + cut helpers for slab-like elements (IfcSlab,
 * IfcRoof, IfcPlate, IfcSpace) shaped by the in-store builders in
 * `@ifc-lite/create`. The shared shape is:
 *
 *   IfcExtrudedAreaSolid
 *     ├── SweptArea : IfcRectangleProfileDef (W × D) — rectangle mode
 *     │              OR IfcArbitraryClosedProfileDef → IfcPolyline — polygon mode
 *     └── Depth     : thickness along +Z (storey-local)
 *
 * The "footprint" is the profile polygon in storey-local 2D (XY).
 * For rectangle mode we derive it from (placementOrigin, W, D); for
 * polygon mode we read the polyline's vertex list.
 *
 * The split workflow:
 *
 *   1. user clicks twice on the slab (in storey-local 2D)
 *   2. polygon-clip cuts the footprint into two halves
 *   3. caller builds two fresh slabs via `addSlab` polygon-mode
 *      (cleaner than trying to detect "rectangle still fits" — most
 *       cuts produce non-rectangular halves)
 *   4. source is tombstoned + its mesh hidden
 *
 * Source-buffer slabs with unusual representations (mapped shapes,
 * tessellated faces, …) refuse with a clear reason and the caller's
 * Split tool stays armed.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import {
  asExpressIdRef,
  asCoordinateTriple,
  asDirectionRatios,
  readAttributes,
  resolvePlacementChain,
} from './placement-core.js';
import { clipPolygonByLine, type Point2D, type PolygonClipResult } from './polygon-clip.js';

/**
 * Slab-like element types this module handles. Matches the STEP
 * storage form (`IFCSLAB`, …) so the slice's split action can
 * dispatch to the right `addSlab` / `addRoof` / `addPlate` /
 * `addSpace` follow-up. (Roof/plate/space are added in subsequent
 * commits but their representation is identical, so this resolver
 * already accepts them.)
 */
export type SlabLikeType = 'IfcSlab' | 'IfcRoof' | 'IfcPlate' | 'IfcSpace';

const SLAB_LIKE_STEP_TYPES: Record<string, SlabLikeType> = {
  IFCSLAB: 'IfcSlab',
  IFCROOF: 'IfcRoof',
  IFCPLATE: 'IfcPlate',
  IFCSPACE: 'IfcSpace',
};

function stepTypeToSlabLike(stepType: string): SlabLikeType | null {
  return SLAB_LIKE_STEP_TYPES[stepType.toUpperCase()] ?? null;
}

/**
 * A 2D rigid transform mapping a profile-coordinate point into the
 * solid's local plan (XY). Built from the `IfcExtrudedAreaSolid`'s
 * `Position` (an `IfcAxis2Placement3D`), it folds in the in-place
 * translation + rotation that real-world authoring tools bake there.
 * In-store-built slabs carry an identity Position, so the resolver
 * defaults to the identity transform for them.
 */
type Xform2D = (p: [number, number]) => [number, number];

const IDENTITY_XFORM2D: Xform2D = (p) => [p[0], p[1]];

function readDirection(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  id: number | null,
): [number, number, number] | null {
  if (id === null) return null;
  const attrs = readAttributes(dataStore, view, editor, id);
  return attrs ? asDirectionRatios(attrs[0]) : null;
}

/**
 * Build the plan-space transform for an `IfcExtrudedAreaSolid.Position`.
 * The profile lives in the placement's local XY plane; we map a profile
 * point `(px, py)` to `origin + px·X + py·Y` and keep the XY components
 * (the footprint is the plan). X comes from RefDirection (orthonormalised
 * against the Axis/Z), Y = Z × X — matching the IFC placement convention,
 * including axis flips (e.g. Axis `(0,0,-1)`, RefDirection `(-1,0,0)`).
 * Returns identity when the placement is absent or degenerate.
 */
function resolveSolidPositionXform(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  placementId: number | null,
): Xform2D {
  if (placementId === null) return IDENTITY_XFORM2D;
  const attrs = readAttributes(dataStore, view, editor, placementId);
  if (!attrs) return IDENTITY_XFORM2D;

  // IfcAxis2Placement3D: [0] Location · [1] Axis (Z) · [2] RefDirection (X).
  const locId = asExpressIdRef(attrs[0]);
  let ox = 0;
  let oy = 0;
  if (locId !== null) {
    const locAttrs = readAttributes(dataStore, view, editor, locId);
    const c = locAttrs ? asCoordinateTriple(locAttrs[0]) : null;
    if (c) {
      ox = c[0];
      oy = c[1];
    }
  }

  // IfcDirection ratios are NOT guaranteed unit length, so normalise Z
  // before using it as a basis vector — otherwise the Gram-Schmidt
  // projection (which assumes |Z|=1) and Y = Z × X both pick up |Z| as a
  // stray scale factor, skewing the footprint away from the rendered mesh
  // for files with e.g. Axis=(0,0,2). The Rust profile extractor
  // normalises the same placement.
  const rawZ = readDirection(dataStore, view, editor, asExpressIdRef(attrs[1])) ?? [0, 0, 1];
  const zlen = Math.hypot(rawZ[0], rawZ[1], rawZ[2]);
  if (zlen < 1e-9) return IDENTITY_XFORM2D;
  const z: [number, number, number] = [rawZ[0] / zlen, rawZ[1] / zlen, rawZ[2] / zlen];
  const refX = readDirection(dataStore, view, editor, asExpressIdRef(attrs[2])) ?? [1, 0, 0];

  // Orthonormalise X against the unit Z (Gram-Schmidt), then Y = Z × X.
  const dot = refX[0] * z[0] + refX[1] * z[1] + refX[2] * z[2];
  let xv: [number, number, number] = [
    refX[0] - dot * z[0],
    refX[1] - dot * z[1],
    refX[2] - dot * z[2],
  ];
  const xlen = Math.hypot(xv[0], xv[1], xv[2]);
  if (xlen < 1e-9) return IDENTITY_XFORM2D;
  xv = [xv[0] / xlen, xv[1] / xlen, xv[2] / xlen];
  // Z and X are now orthonormal, so Y = Z × X is already unit length.
  const yv: [number, number, number] = [
    z[1] * xv[2] - z[2] * xv[1],
    z[2] * xv[0] - z[0] * xv[2],
    z[0] * xv[1] - z[1] * xv[0],
  ];

  return (p) => [ox + p[0] * xv[0] + p[1] * yv[0], oy + p[0] * xv[1] + p[1] * yv[1]];
}

export interface SlabEditChain {
  /** STEP type name, for the slice's dispatch. */
  elementType: SlabLikeType;
  /** Placement origin (storey-local). The footprint polygon is in
   * world-XY space, with the origin already added. */
  placementOrigin: [number, number, number];
  /** Footprint polygon as an ordered list of 2D vertices (storey-
   * local world XY). First vertex does NOT repeat at the end. */
  footprint: Point2D[];
  /** IfcExtrudedAreaSolid id — holds the thickness on attr 3. */
  extrudedSolidId: number;
  /** Current extrusion thickness (metres along +Z). */
  thickness: number;
  /**
   * Whether the source profile was a rectangle (XDim/YDim) or an
   * arbitrary polygon (IfcArbitraryClosedProfileDef → IfcPolyline).
   * Surface for telemetry; not required by the split flow.
   */
  profileKind: 'rectangle' | 'polygon';
}

function readEntityType(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
): string | null {
  void view;
  const overlay = editor.getNewEntity(expressId);
  if (overlay) return overlay.type;
  const ref = dataStore.entityIndex.byId.get(expressId);
  return ref?.type ?? null;
}

/**
 * Derive a rectangle profile's outline from its centred placement.
 * `IfcRectangleProfileDef` extends from `-XDim/2` to `+XDim/2`
 * along the profile's local X (and same for YDim along local Y),
 * centred at the IfcAxis2Placement2D's Location point.
 */
function rectangleFootprint(
  placementOrigin: [number, number, number],
  profileOrigin2D: [number, number],
  xdim: number,
  ydim: number,
  solidXform: Xform2D,
): Point2D[] {
  // Rectangle corners in the profile coordinate system (centred on the
  // profile origin), mapped through the solid Position into plan space,
  // then offset by the slab's placement origin.
  const [px, py] = placementOrigin;
  const [cx, cy] = profileOrigin2D;
  const corners: Point2D[] = [
    [cx - xdim / 2, cy - ydim / 2],
    [cx + xdim / 2, cy - ydim / 2],
    [cx + xdim / 2, cy + ydim / 2],
    [cx - xdim / 2, cy + ydim / 2],
  ];
  return corners.map((c) => {
    const [wx, wy] = solidXform(c);
    return [px + wx, py + wy] as Point2D;
  });
}

/**
 * Read an IfcPolyline's vertex list and return them as 2D storey-
 * local points (adding the placement origin so the result is in
 * the same frame as a rectangle footprint).
 */
function polylineFootprint(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  polylineId: number,
  placementOrigin: [number, number, number],
  profileOrigin2D: [number, number],
  solidXform: Xform2D,
): Point2D[] | null {
  const attrs = readAttributes(dataStore, view, editor, polylineId);
  if (!attrs) return null;
  // IfcPolyline.Points is a list of IfcCartesianPoint refs at attr 0.
  const refList = attrs[0];
  if (!Array.isArray(refList) || refList.length < 3) return null;
  const [px, py] = placementOrigin;
  const [cx, cy] = profileOrigin2D;
  const out: Point2D[] = [];
  for (const ref of refList) {
    const ptId = asExpressIdRef(ref);
    if (ptId === null) return null;
    const ptAttrs = readAttributes(dataStore, view, editor, ptId);
    if (!ptAttrs) return null;
    // IfcCartesianPoint.Coordinates is a list of doubles at attr 0.
    // Polyline points are 2D here (slab profiles), but treat 3D
    // tolerantly — IFC files in the wild sometimes pad with Z=0.
    const coords = asCoordinateTriple(ptAttrs[0]);
    if (!coords) return null;
    // Point in profile CS → solid plan (Position translation + rotation)
    // → slab placement origin.
    const [wx, wy] = solidXform([cx + coords[0], cy + coords[1]]);
    out.push([px + wx, py + wy]);
  }
  // IfcPolyline for a closed profile may or may not repeat the
  // first vertex at the end — strip if present, our clip API
  // wants the implicit-close form.
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) {
      out.pop();
    }
  }
  return out.length >= 3 ? out : null;
}

/**
 * Scale a chain's coordinate-bearing fields (footprint, placement
 * origin, thickness) by `scale`. Identity when `scale === 1`. Used to
 * lift a native-unit (e.g. millimetre) STEP read into the viewer's
 * metre working space — see `resolveSlabEditChain`'s `lengthUnitScale`.
 */
function scaleSlabChain(chain: SlabEditChain, scale: number): SlabEditChain {
  if (scale === 1) return chain;
  return {
    ...chain,
    placementOrigin: [
      chain.placementOrigin[0] * scale,
      chain.placementOrigin[1] * scale,
      chain.placementOrigin[2] * scale,
    ],
    footprint: chain.footprint.map(([x, y]) => [x * scale, y * scale] as Point2D),
    thickness: chain.thickness * scale,
  };
}

/**
 * Resolve the slab chain (placement + footprint + extrusion). Works
 * for IfcSlab / IfcRoof / IfcPlate / IfcSpace whose representation
 * matches the in-store builder shape; null otherwise.
 *
 * `lengthUnitScale` is the model's native-unit → metre factor (e.g.
 * `0.001` for a millimetre file). Raw STEP coordinate reads are in
 * native units, but the rest of the split flow — raycast cut points,
 * preview meshes, selection hit-tests — lives in metres, so the
 * resolved footprint/thickness are scaled to match. Authored overlay
 * entities are skipped: the in-store builders already emit metres, so
 * scaling them would double-apply (re-splitting a freshly-cut half).
 */
export function resolveSlabEditChain(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  lengthUnitScale = 1,
): SlabEditChain | null {
  const rawType = readEntityType(dataStore, view, editor, expressId);
  if (!rawType) return null;
  const elementType = stepTypeToSlabLike(rawType);
  if (!elementType) return null;

  // Overlay (authored) entities are stored in metres by the in-store
  // builders; only native STEP reads need the unit scale applied.
  // `getNewEntity` returns null (not undefined) for source entities.
  const isAuthored = editor.getNewEntity(expressId) != null;
  const scale = isAuthored ? 1 : lengthUnitScale;

  const chain = resolvePlacementChain(dataStore, view, editor, expressId);
  if (!chain) return null;
  const placementOrigin = chain.coordinates;

  const elementAttrs = readAttributes(dataStore, view, editor, expressId);
  if (!elementAttrs) return null;
  const productShapeId = asExpressIdRef(elementAttrs[6]);
  if (productShapeId === null) return null;
  const productShapeAttrs = readAttributes(dataStore, view, editor, productShapeId);
  if (!productShapeAttrs) return null;
  const reps = productShapeAttrs[2];
  if (!Array.isArray(reps) || reps.length === 0) return null;
  const shapeRepId = asExpressIdRef(reps[0]);
  if (shapeRepId === null) return null;
  const shapeRepAttrs = readAttributes(dataStore, view, editor, shapeRepId);
  if (!shapeRepAttrs) return null;
  const items = shapeRepAttrs[3];
  if (!Array.isArray(items) || items.length === 0) return null;
  const solidId = asExpressIdRef(items[0]);
  if (solidId === null) return null;
  const solidAttrs = readAttributes(dataStore, view, editor, solidId);
  if (!solidAttrs) return null;
  const profileId = asExpressIdRef(solidAttrs[0]);
  const thicknessRaw = solidAttrs[3];
  if (profileId === null || typeof thicknessRaw !== 'number') return null;

  // IfcExtrudedAreaSolid.Position (attr 1) is an IfcAxis2Placement3D that
  // places the profile in the solid's frame — real authoring tools bake
  // the slab's plan offset + rotation here (in-store-built slabs leave it
  // identity). Fold it into the footprint so the preview, cut line, and
  // resulting halves land where the rendered mesh actually is.
  const solidXform = resolveSolidPositionXform(
    dataStore,
    view,
    editor,
    asExpressIdRef(solidAttrs[1]),
  );

  // Profile dispatch — rectangle vs polygon, both produced by
  // addSlabToStore. Source-buffer slabs with mapped representations,
  // I-shape profiles, etc. land in `null` here and the slice
  // surfaces a "not supported" toast.
  const profileAttrs = readAttributes(dataStore, view, editor, profileId);
  if (!profileAttrs) return null;
  const overlay = editor.getNewEntity(profileId);
  const profileType = overlay?.type ?? dataStore.entityIndex.byId.get(profileId)?.type ?? null;

  // Profile-local origin (IfcAxis2Placement2D.Location) — both
  // profile kinds share this. May be null for the slot, in which
  // case the spec defaults to origin = (0, 0).
  const profilePosId = asExpressIdRef(profileAttrs[2]);
  let profileOrigin2D: [number, number] = [0, 0];
  if (profilePosId !== null) {
    const profilePosAttrs = readAttributes(dataStore, view, editor, profilePosId);
    if (profilePosAttrs) {
      const profileOriginPtId = asExpressIdRef(profilePosAttrs[0]);
      if (profileOriginPtId !== null) {
        const profileOriginAttrs = readAttributes(dataStore, view, editor, profileOriginPtId);
        if (profileOriginAttrs) {
          const c = asCoordinateTriple(profileOriginAttrs[0]);
          if (c) profileOrigin2D = [c[0], c[1]];
        }
      }
    }
  }

  if (profileType && profileType.toUpperCase() === 'IFCRECTANGLEPROFILEDEF') {
    const xdim = profileAttrs[3];
    const ydim = profileAttrs[4];
    if (typeof xdim !== 'number' || typeof ydim !== 'number') return null;
    return scaleSlabChain({
      elementType,
      placementOrigin,
      footprint: rectangleFootprint(placementOrigin, profileOrigin2D, xdim, ydim, solidXform),
      extrudedSolidId: solidId,
      thickness: thicknessRaw,
      profileKind: 'rectangle',
    }, scale);
  }
  if (profileType && profileType.toUpperCase() === 'IFCARBITRARYCLOSEDPROFILEDEF') {
    // OuterCurve at attr 2.
    const polylineId = asExpressIdRef(profileAttrs[2]);
    if (polylineId === null) return null;
    const fp = polylineFootprint(dataStore, view, editor, polylineId, placementOrigin, profileOrigin2D, solidXform);
    if (!fp) return null;
    return scaleSlabChain({
      elementType,
      placementOrigin,
      footprint: fp,
      extrudedSolidId: solidId,
      thickness: thicknessRaw,
      profileKind: 'polygon',
    }, scale);
  }
  return null;
}

export interface SlabSplitResult {
  ok: true;
  leftFootprint: Point2D[];
  rightFootprint: Point2D[];
  thickness: number;
  placementOrigin: [number, number, number];
  elementType: SlabLikeType;
}

export type SlabSplitOutcome = SlabSplitResult | { ok: false; reason: string };

/**
 * Pure split-geometry helper. Clips the slab's footprint by a cut
 * line (defined by two storey-local 2D points) and returns the two
 * halves so the caller can build new slabs with `addSlab`. Both
 * halves carry the source's thickness + storey placement; only the
 * outer-curve polygon changes.
 *
 * Returns the underlying polygon-clip reason on failure so the UI
 * can surface "Cut line does not cross the slab" verbatim.
 */
export function computeSlabSplitGeometry(
  chain: SlabEditChain,
  cutA: Point2D,
  cutB: Point2D,
): SlabSplitOutcome {
  const clipped: PolygonClipResult = clipPolygonByLine(chain.footprint, cutA, cutB);
  if (!clipped.ok) {
    return { ok: false, reason: clipped.reason };
  }
  return {
    ok: true,
    leftFootprint: clipped.left,
    rightFootprint: clipped.right,
    thickness: chain.thickness,
    placementOrigin: chain.placementOrigin,
    elementType: chain.elementType,
  };
}
