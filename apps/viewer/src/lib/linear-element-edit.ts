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
import { fromNativeLength } from '@ifc-lite/create';
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
  /** IfcRectangleProfileDef id: XDim (attr 3) is the width, YDim (attr 4) the other side. */
  profileId: number;
  /** Current extrusion length (metres). */
  depth: number;
  /** Profile cross-section width (X dimension, metres). */
  profileWidth: number;
  /** Profile cross-section height (Y dimension, metres). */
  profileHeight: number;
  /**
   * The native-unit → metre factor every length above was scaled by. Raw
   * STEP reads are native (e.g. millimetres) for imported AND in-store
   * authored elements alike; a writer divides by this to go back (#6233).
   */
  lengthUnitScale: number;
}

type AttributeReader = (id: number | null) => unknown[] | null;

const EPS = 1e-9;

function isPoint(value: unknown, expected: readonly number[]): boolean {
  const p = asCoordinateTriple(value);
  return p !== null && p.every((v, i) => Math.abs(v - expected[i]) < EPS);
}

function isDirection(value: unknown, expected: readonly number[]): boolean {
  const d = asDirectionRatios(value);
  const len = d ? Math.hypot(d[0], d[1], d[2]) : 0;
  return d !== null && len > EPS && d.every((v, i) => Math.abs(v / len - expected[i]) < 1e-6);
}

/** An `IfcAxis2Placement3D` (or none) that neither moves nor rotates. */
function isIdentitySolidPosition(read: AttributeReader, positionId: number | null): boolean {
  if (positionId === null) return true;
  const position = read(positionId);
  if (!position || !isPoint(read(asExpressIdRef(position[0]))?.[0], [0, 0, 0])) return false;
  if (position[1] != null && !isDirection(read(asExpressIdRef(position[1]))?.[0], [0, 0, 1])) return false;
  return position[2] == null || isDirection(read(asExpressIdRef(position[2]))?.[0], [1, 0, 0]);
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
  lengthUnitScale = 1,
): LinearElementEditChain | null {
  const rawType = editor.getEntityType(expressId);
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
  // The length runs along the PLACEMENT's axis only when the solid adds no
  // rotation or offset of its own and extrudes along local +Z — the layout
  // the in-store builders write. An imported beam that extrudes along a
  // rotated solid position (AC20's `Unterzug-1`: solid Axis = +Y) must be
  // refused, not cut along the wrong axis (#6233).
  const read = (id: number | null) => (id === null ? null : readAttributes(dataStore, view, editor, id));
  if (!isIdentitySolidPosition(read, asExpressIdRef(solidAttrs[1]))) return null;
  if (solidAttrs[2] != null && !isDirection(read(asExpressIdRef(solidAttrs[2]))?.[0], [0, 0, 1])) return null;
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
  // Centred, unrotated cross-section, as the builders write (the split
  // re-authors a piece with a centred profile).
  const profilePosition = read(asExpressIdRef(profileAttrs[2]));
  if (profileAttrs[2] != null) {
    if (!profilePosition || !isPoint(read(asExpressIdRef(profilePosition[0]))?.[0], [0, 0, 0])) return null;
    if (profilePosition[1] != null && !isDirection(read(asExpressIdRef(profilePosition[1]))?.[0], [1, 0, 0])) return null;
  }
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

  const m = (native: number) => fromNativeLength({ lengthUnitScale }, native);
  const [sx, sy, sz] = chain.coordinates;
  return {
    elementType,
    startPointId: chain.cartesianPointId,
    startCoordinates: [m(sx), m(sy), m(sz)],
    axisDirection,
    extrudedSolidId: solidId,
    profileId,
    depth: m(depthRaw),
    profileWidth: m(profileWidth),
    profileHeight: m(profileHeight),
    lengthUnitScale,
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
  // `newDepth` is metres like the chain; the slot is native units.
  editor.setPositionalAttribute(chain.extrudedSolidId, 3, newDepth / chain.lengthUnitScale);
}

// Re-export the asCoordinateTriple helper so callers that import
// linear-element-edit don't have to reach into placement-core too.
// Keeps the import surface tight for the slice action.
export { asCoordinateTriple };
