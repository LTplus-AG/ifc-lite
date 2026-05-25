/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Linear-element split helpers for IfcBeam, IfcColumn, and
 * IfcMember — entities built by `@ifc-lite/create`'s in-store
 * builders that share the shape:
 *
 *   IfcExtrudedAreaSolid
 *     ├── SweptArea         : IfcRectangleProfileDef (Width × Height)
 *     └── Depth             : extrusion length along the placement's
 *                             local Z (= world axis direction for
 *                             beams/members; world +Z for columns
 *                             because their placement's Axis is `$`)
 *
 * The split logic is meaningfully different from walls: a wall's
 * "length" is its profile XDim, so splitting requires rewriting
 * four entities. A beam / column / member's "length" is the
 * extrusion `Depth`, so we can shrink the source in place (one
 * positional write) and add a fresh element at the cut point.
 * Source identity (GlobalId, Pset rels) is preserved for the
 * "left" half — cleaner downstream than the wall's two-new-walls
 * approach, but the choice is dictated by the IFC representation,
 * not preference.
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

export const MIN_LINEAR_SEGMENT_LENGTH = 0.05; // metres

/**
 * Element types this module handles. Maps to the STEP storage form
 * (`IFCBEAM`, …) — the slice's `splitLinearElementAtDistance` action
 * picks the right `addBeam` / `addColumn` / `addMember` follow-up
 * based on this value.
 */
export type LinearElementType = 'IfcBeam' | 'IfcColumn' | 'IfcMember';

const LINEAR_ELEMENT_STEP_TYPES = new Set(['IFCBEAM', 'IFCCOLUMN', 'IFCMEMBER']);

function stepTypeToLinearType(stepType: string): LinearElementType | null {
  switch (stepType.toUpperCase()) {
    case 'IFCBEAM':
      return 'IfcBeam';
    case 'IFCCOLUMN':
      return 'IfcColumn';
    case 'IFCMEMBER':
      return 'IfcMember';
    default:
      return null;
  }
}

export interface LinearElementEditChain {
  /** STEP type name, for the slice's dispatch (`IfcBeam` / `IfcColumn` / `IfcMember`). */
  elementType: LinearElementType;
  /** Placement origin point id (storey-local). */
  startPointId: number;
  /** Current start coordinates in storey-local space. */
  startCoordinates: [number, number, number];
  /**
   * World-axis direction of the extrusion in storey-local space.
   * For beams / members this is the explicit
   * `IfcAxis2Placement3D.Axis` IfcDirection. For columns it's the
   * implicit default `[0, 0, 1]` (placement Axis = `$`).
   */
  axisDirection: [number, number, number];
  /** IfcExtrudedAreaSolid id; holds the length on attribute 3 (`Depth`). */
  extrudedSolidId: number;
  /** Current extrusion length (metres). */
  depth: number;
  /** Profile cross-section width (X dimension, metres). */
  profileWidth: number;
  /** Profile cross-section height (Y dimension, metres). */
  profileHeight: number;
}

function readEntityType(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
): string | null {
  const overlay = editor.getNewEntity(expressId);
  if (overlay) return overlay.type;
  // Source-buffer entities: the parser's entityIndex.byId stores
  // type per ref. Pull it through `byType` reverse-walk only if we
  // can't avoid it. Simpler path: read the attributes via the
  // source reader; if the reader path returns nothing the entity
  // either doesn't exist or isn't reachable from where we stand.
  const ref = dataStore.entityIndex.byId.get(expressId);
  return ref?.type ?? null;
}

/**
 * Resolve the chain for an IfcBeam / IfcColumn / IfcMember whose
 * representation matches what `addBeamToStore` / `addColumnToStore`
 * / `addMemberToStore` produce. Returns null when the chain doesn't
 * match (mapped representation, non-rectangle profile, missing
 * placement, etc.) so the caller can hide the split affordance.
 */
export function resolveLinearElementChain(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
): LinearElementEditChain | null {
  const rawType = readEntityType(dataStore, view, editor, expressId);
  if (!rawType || !LINEAR_ELEMENT_STEP_TYPES.has(rawType.toUpperCase())) return null;
  const elementType = stepTypeToLinearType(rawType);
  if (!elementType) return null;

  // ObjectPlacement chain — gives us the start point AND the
  // IfcAxis2Placement3D id for axis lookup.
  const chain = resolvePlacementChain(dataStore, view, editor, expressId);
  if (!chain) return null;

  // Pull the axis direction. IfcAxis2Placement3D.Axis (index 1) may
  // be null → implicit world +Z (matches the column builder).
  const axisAttrs = readAttributes(dataStore, view, editor, chain.axisPlacementId);
  if (!axisAttrs) return null;
  const axisDirId = asExpressIdRef(axisAttrs[1]);
  let axisDirection: [number, number, number] = [0, 0, 1];
  if (axisDirId !== null) {
    const dirAttrs = readAttributes(dataStore, view, editor, axisDirId);
    if (!dirAttrs) return null;
    const ratios = asDirectionRatios(dirAttrs[0]);
    if (!ratios) return null;
    // Reject NaN / Infinity components — those would propagate into
    // every downstream split / projection call. The builder writes
    // unit vectors but source-buffer entities can be malformed.
    if (!Number.isFinite(ratios[0]) || !Number.isFinite(ratios[1]) || !Number.isFinite(ratios[2])) {
      return null;
    }
    const len = Math.hypot(ratios[0], ratios[1], ratios[2]);
    // Zero-length axis isn't translatable; refuse rather than fall
    // back silently to world +Z (which would silently mis-orient
    // every downstream operation).
    if (len < 1e-9) return null;
    axisDirection = [ratios[0] / len, ratios[1] / len, ratios[2] / len];
  }

  // Representation chain: same shape as walls but the length lives
  // on the extrusion depth, not the profile XDim.
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
  const depthRaw = solidAttrs[3];
  if (
    profileId === null ||
    typeof depthRaw !== 'number' ||
    !Number.isFinite(depthRaw) ||
    depthRaw <= 0
  ) {
    return null;
  }

  // Cross-section dimensions from the IfcRectangleProfileDef
  // (Width = XDim attr 3, Height = YDim attr 4). Not strictly
  // needed for the split math, but exposed so callers building the
  // new element can carry the same cross-section forward. Reject
  // non-finite / non-positive — would silently produce zero-area
  // or NaN-area profiles downstream.
  const profileAttrs = readAttributes(dataStore, view, editor, profileId);
  if (!profileAttrs) return null;
  const profileWidth = profileAttrs[3];
  const profileHeight = profileAttrs[4];
  if (
    typeof profileWidth !== 'number' ||
    typeof profileHeight !== 'number' ||
    !Number.isFinite(profileWidth) ||
    !Number.isFinite(profileHeight) ||
    profileWidth <= 0 ||
    profileHeight <= 0
  ) {
    return null;
  }

  return {
    elementType,
    startPointId: chain.cartesianPointId,
    startCoordinates: chain.coordinates,
    axisDirection,
    extrudedSolidId: solidId,
    depth: depthRaw,
    profileWidth,
    profileHeight,
  };
}

export interface LinearSplitGeometry {
  /** Length the source's extrusion shrinks to (= split distance from start). */
  leftDepth: number;
  /** Cut point in storey-local space. */
  cutPoint: [number, number, number];
  /** End of the source (storey-local) — also the end of the new right half. */
  endPoint: [number, number, number];
  /** Length the new right-half element takes. */
  rightDepth: number;
  /** Cross-section dimensions to copy onto the new element. */
  width: number;
  height: number;
}

export type LinearSplitResult =
  | { ok: true; geometry: LinearSplitGeometry }
  | { ok: false; reason: string };

/**
 * Pure split-geometry math. Splits the linear element at
 * `distance` metres from start. Returns the cut point + remaining
 * lengths so the caller can shrink the source and add the right
 * half via the matching `addBeam` / `addColumn` / `addMember`
 * action.
 *
 * Same min-segment guard as walls (`MIN_LINEAR_SEGMENT_LENGTH`)
 * so dragging the cursor to the very end of a column doesn't
 * produce a sliver.
 */
export function computeLinearElementSplitGeometry(
  chain: LinearElementEditChain,
  distance: number,
): LinearSplitResult {
  if (!Number.isFinite(distance)) {
    return { ok: false, reason: 'Split distance must be a finite number' };
  }
  if (
    distance <= MIN_LINEAR_SEGMENT_LENGTH ||
    distance >= chain.depth - MIN_LINEAR_SEGMENT_LENGTH
  ) {
    return {
      ok: false,
      reason: `Split must be at least ${MIN_LINEAR_SEGMENT_LENGTH} m from each end (element is ${chain.depth.toFixed(2)} m)`,
    };
  }
  const [sx, sy, sz] = chain.startCoordinates;
  const [dx, dy, dz] = chain.axisDirection;
  const cut: [number, number, number] = [sx + dx * distance, sy + dy * distance, sz + dz * distance];
  const end: [number, number, number] = [
    sx + dx * chain.depth,
    sy + dy * chain.depth,
    sz + dz * chain.depth,
  ];
  return {
    ok: true,
    geometry: {
      leftDepth: distance,
      cutPoint: cut,
      endPoint: end,
      rightDepth: chain.depth - distance,
      width: chain.profileWidth,
      height: chain.profileHeight,
    },
  };
}

/**
 * Project an arbitrary storey-local 3D cursor onto the element's
 * axis and return how far along the element (in metres from start)
 * it lands. Clamps to `[0, depth]`.
 */
export function projectOntoLinearAxis(
  chain: LinearElementEditChain,
  pointStoreyLocal: [number, number, number],
): number {
  const [px, py, pz] = pointStoreyLocal;
  const [sx, sy, sz] = chain.startCoordinates;
  const [dx, dy, dz] = chain.axisDirection;
  const ux = px - sx;
  const uy = py - sy;
  const uz = pz - sz;
  // Axis is unit-length by resolveLinearElementChain's contract; we
  // still divide through for robustness.
  const denom = dx * dx + dy * dy + dz * dz;
  if (denom < 1e-9) return 0;
  const t = (ux * dx + uy * dy + uz * dz) / denom;
  return Math.max(0, Math.min(chain.depth, t));
}

/**
 * Shrink the source linear element's extrusion to `newDepth`. Used
 * by the split action's "left half" branch — the source's
 * placement, axis, profile, and Pset relationships all stay; only
 * the IfcExtrudedAreaSolid.Depth changes.
 *
 * Coerce-only: this is the equivalent of `setPositionalAttribute`
 * for a known slot; we expose it via the helper module for
 * symmetry with the other split helpers.
 */
export function shrinkLinearElementDepth(
  editor: StoreEditor,
  chain: LinearElementEditChain,
  newDepth: number,
): void {
  editor.setPositionalAttribute(chain.extrudedSolidId, 3, newDepth);
}

// Re-export the asCoordinateTriple helper so callers that import
// linear-element-edit don't have to reach into placement-core too.
// Keeps the import surface tight for the slice action.
export { asCoordinateTriple };
