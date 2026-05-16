/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall-specific placement + representation edits.
 *
 * A rectangular-profile wall created by `addWallToStore` encodes its
 * start/end as four coupled entities — the placement origin, the
 * RefDirection (start→end), the profile XDim, and the profile
 * origin (centred at XDim/2). Resizing means touching all four
 * coherently, so this module owns that ensemble.
 *
 * Generic placement reads / writes live in `placement-core.ts`.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import {
  asExpressIdRef,
  readAttributes,
  resolvePlacementChain,
  resolveRotationState,
} from './placement-core.js';

export interface WallEditChain {
  /** IfcLocalPlacement.RelativePlacement.Location — the wall's start point. */
  startPointId: number;
  /** Current start coordinates (storey-local). */
  startCoordinates: [number, number, number];
  /** IfcAxis2Placement3D.RefDirection — wall direction (start→end). */
  refDirectionId: number;
  /** Current RefDirection ratios. */
  refDirection: [number, number, number];
  /** IfcRectangleProfileDef.XDim — wall length along its local X. */
  profileId: number;
  /** Current wall length. */
  wallLength: number;
  /** IfcRectangleProfileDef.YDim — wall thickness. */
  thickness: number;
  /** Profile origin IfcCartesianPoint with `[length/2, 0]`. */
  profileOriginPointId: number;
  /** IfcExtrudedAreaSolid id — exposed so split readers don't re-walk. */
  extrudedSolidId: number;
  /** Extrusion depth ( = wall height in metres ); `NaN` when the slot wasn't a number. */
  height: number;
}

/**
 * Resolve the wall-edit chain for a wall created by
 * `@ifc-lite/create#addWallToStore` (or any source-buffer wall that
 * happens to follow the same `IfcRectangleProfileDef →
 * IfcExtrudedAreaSolid` shape).
 *
 * Returns null when the entity isn't a wall, doesn't have an explicit
 * RefDirection, or its representation isn't the expected rectangle-
 * profile / extruded-solid pair. Callers should treat null as
 * "endpoints not editable" and hide their drag handles rather than
 * crashing.
 */
export function resolveWallEditChain(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
): WallEditChain | null {
  const wallAttrs = readAttributes(dataStore, view, editor, expressId);
  if (!wallAttrs) return null;

  // ObjectPlacement chain — reuse the standard walker to get the
  // start point. The "Position" attribute index varies by schema
  // (IfcRoot+) but ObjectPlacement is always #5 for an IfcProduct.
  const chain = resolvePlacementChain(dataStore, view, editor, expressId);
  if (!chain) return null;

  // RefDirection MUST be explicit for an addWallToStore-built wall —
  // the builder always emits it. Reject implicit defaults so we
  // don't have to materialise one mid-drag.
  const rot = resolveRotationState(dataStore, view, editor, expressId);
  if (!rot || rot.refDirectionId === null) return null;

  // Representation chain: wall.Representation (attrs[6]) → IfcProductDefinitionShape
  //   → Representations[0] → IfcShapeRepresentation → Items[0] → IfcExtrudedAreaSolid
  //   → SweptArea → IfcRectangleProfileDef → Position → Location (profile origin)
  const productShapeId = asExpressIdRef(wallAttrs[6]);
  if (productShapeId === null) return null;

  const productShapeAttrs = readAttributes(dataStore, view, editor, productShapeId);
  if (!productShapeAttrs) return null;
  // IfcProductDefinitionShape.Representations is index 2.
  const reps = productShapeAttrs[2];
  if (!Array.isArray(reps) || reps.length === 0) return null;
  const shapeRepId = asExpressIdRef(reps[0]);
  if (shapeRepId === null) return null;

  const shapeRepAttrs = readAttributes(dataStore, view, editor, shapeRepId);
  if (!shapeRepAttrs) return null;
  // IfcShapeRepresentation.Items is index 3.
  const items = shapeRepAttrs[3];
  if (!Array.isArray(items) || items.length === 0) return null;
  const solidId = asExpressIdRef(items[0]);
  if (solidId === null) return null;

  const solidAttrs = readAttributes(dataStore, view, editor, solidId);
  if (!solidAttrs) return null;
  // IfcExtrudedAreaSolid.SweptArea is index 0.
  const profileId = asExpressIdRef(solidAttrs[0]);
  if (profileId === null) return null;

  const profileAttrs = readAttributes(dataStore, view, editor, profileId);
  if (!profileAttrs) return null;
  // IfcRectangleProfileDef:
  //   [0] ProfileType · [1] ProfileName · [2] Position · [3] XDim · [4] YDim
  const profilePosId = asExpressIdRef(profileAttrs[2]);
  const xdim = profileAttrs[3];
  const ydim = profileAttrs[4];
  if (profilePosId === null || typeof xdim !== 'number' || typeof ydim !== 'number') {
    // Non-rectangle profile — wall wasn't built by addWallToStore.
    return null;
  }

  const profilePosAttrs = readAttributes(dataStore, view, editor, profilePosId);
  if (!profilePosAttrs) return null;
  // IfcAxis2Placement2D.Location at index 0.
  const profileOriginPointId = asExpressIdRef(profilePosAttrs[0]);
  if (profileOriginPointId === null) return null;

  // Extrusion depth (= wall height) lives on the
  // IfcExtrudedAreaSolid (attribute index 3). Pull it now so split
  // / clone helpers don't need to re-walk the chain.
  const depth = solidAttrs[3];
  const height = typeof depth === 'number' ? depth : NaN;

  return {
    startPointId: chain.cartesianPointId,
    startCoordinates: chain.coordinates,
    refDirectionId: rot.refDirectionId,
    refDirection: rot.refDirection,
    profileId,
    wallLength: xdim,
    thickness: ydim,
    profileOriginPointId,
    extrudedSolidId: solidId,
    height,
  };
}

/**
 * Pure geometry math for splitting a rectangle-profile wall at
 * `distance` along its axis (measured from the start). Returns the
 * geometry of the two resulting walls in storey-local IFC space.
 *
 * The split is a straight perpendicular cut — both halves keep the
 * source wall's direction vector and thickness. The "left" half
 * starts at the source's start and runs `distance`; the "right"
 * half starts at the cut point and runs the remaining length.
 *
 * Returns `null` (with a reason) when:
 *   - the wall chain doesn't resolve
 *   - `distance` is outside `(MIN_SEGMENT_LENGTH, length - MIN_SEGMENT_LENGTH)`
 *   - input is otherwise inconsistent
 *
 * Caller is responsible for actually building the two new walls and
 * tombstoning the source — this helper is pure and easy to unit-test
 * without a store editor.
 */
export const MIN_WALL_SEGMENT_LENGTH = 0.05; // metres

export interface WallSplitGeometry {
  /** Geometry that `addWallToStore` would consume for the "before-cut" half. */
  left: {
    Start: [number, number, number];
    End: [number, number, number];
    Thickness: number;
    /** Carried over from the source — caller may override. */
    Height: number;
  };
  right: {
    Start: [number, number, number];
    End: [number, number, number];
    Thickness: number;
    Height: number;
  };
  /** Cut point in storey-local space (Start + dir·distance, Z = source Z). */
  cutPoint: [number, number, number];
  /** Source's length, so the caller can validate UX feedback. */
  sourceLength: number;
}

export type WallSplitResult =
  | { ok: true; geometry: WallSplitGeometry }
  | { ok: false; reason: string };

/**
 * Compute the geometry for a split without mutating the store. Used
 * by the mutationSlice action to drive `addWallToStore` twice and by
 * tests that exercise the math in isolation.
 *
 * `sourceHeight` is passed in rather than re-read here because the
 * extrusion `Depth` lives on the `IfcExtrudedAreaSolid` (attribute 3),
 * not in the WallEditChain. The slice action reads it once and
 * forwards the value.
 */
export function computeWallSplitGeometry(
  chain: WallEditChain,
  distance: number,
  sourceHeight: number,
): WallSplitResult {
  if (!Number.isFinite(distance)) {
    return { ok: false, reason: 'Split distance must be a finite number' };
  }
  const len = chain.wallLength;
  if (
    distance <= MIN_WALL_SEGMENT_LENGTH ||
    distance >= len - MIN_WALL_SEGMENT_LENGTH
  ) {
    return {
      ok: false,
      reason: `Split must be at least ${MIN_WALL_SEGMENT_LENGTH} m from each end (wall is ${len.toFixed(2)} m)`,
    };
  }
  const [dx, dy, dz] = chain.refDirection;
  const [sx, sy, sz] = chain.startCoordinates;
  const cut: [number, number, number] = [
    sx + dx * distance,
    sy + dy * distance,
    sz + dz * distance,
  ];
  const end: [number, number, number] = [
    sx + dx * len,
    sy + dy * len,
    sz + dz * len,
  ];
  return {
    ok: true,
    geometry: {
      left: {
        Start: [sx, sy, sz],
        End: cut,
        Thickness: chain.thickness,
        Height: sourceHeight,
      },
      right: {
        Start: cut,
        End: end,
        Thickness: chain.thickness,
        Height: sourceHeight,
      },
      cutPoint: cut,
      sourceLength: len,
    },
  };
}

/**
 * Project an arbitrary 3D point onto the wall's axis and return the
 * signed distance from the wall's start (storey-local). Useful for
 * the Split tool's hover preview: cursor lands anywhere near the
 * wall, we report where the cut would land.
 *
 * Clamps to `[0, length]` — callers decide whether to enforce the
 * min-segment guard.
 */
export function projectOntoWallAxis(
  chain: WallEditChain,
  pointStoreyLocal: [number, number, number],
): number {
  const [px, py] = pointStoreyLocal;
  const [sx, sy] = chain.startCoordinates;
  const [dx, dy] = chain.refDirection;
  // Project (p - start) onto unit-direction. RefDirection is unit-
  // length by IFC convention, but we don't trust it 100% — accept
  // tiny norm drift by dividing through.
  const ux = px - sx;
  const uy = py - sy;
  const denom = dx * dx + dy * dy;
  if (denom < 1e-9) return 0;
  const t = (ux * dx + uy * dy) / denom;
  return Math.max(0, Math.min(chain.wallLength, t));
}

export type WallResizeResult =
  | {
      ok: true;
      newStart: [number, number, number];
      newEnd: [number, number, number];
      newLength: number;
    }
  | { ok: false; reason: string };

/**
 * Resize a rectangular-profile wall by setting new start AND end
 * points. Updates four entities atomically (from the caller's
 * perspective — the four writes still land as four mutations on
 * the undo stack today; a batched-mutation primitive is a planned
 * follow-up so a drag interaction collapses to one undo step).
 *
 *   - wall placement origin (IfcCartesianPoint)
 *   - RefDirection (IfcDirection)  → new normalised (end-start)
 *   - profile XDim (IfcRectangleProfileDef)  → new length
 *   - profile origin (IfcCartesianPoint)  → [newLength/2, 0]
 */
export function resizeRectangleWall(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  newStart: [number, number, number],
  newEnd: [number, number, number],
): WallResizeResult {
  const chain = resolveWallEditChain(dataStore, view, editor, expressId);
  if (!chain) {
    return {
      ok: false,
      reason:
        'Wall does not have a simple IfcRectangleProfileDef → IfcExtrudedAreaSolid representation',
    };
  }
  const dx = newEnd[0] - newStart[0];
  const dy = newEnd[1] - newStart[1];
  const dz = newEnd[2] - newStart[2];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return { ok: false, reason: 'Wall length must be greater than zero' };
  }
  // Z mismatch would slope the wall — the builder rejects this, and
  // so do we to keep the geometry consistent with the rest of the IFC.
  if (Math.abs(dz) > Math.max(1e-6 * length, 1e-9)) {
    return { ok: false, reason: 'Start and end must lie on the same storey plane' };
  }
  const dir: [number, number, number] = [dx / length, dy / length, 0];

  editor.setPositionalAttribute(chain.startPointId, 0, newStart);
  editor.setPositionalAttribute(chain.refDirectionId, 0, dir);
  editor.setPositionalAttribute(chain.profileId, 3, length);
  editor.setPositionalAttribute(chain.profileOriginPointId, 0, [length / 2, 0]);

  return { ok: true, newStart, newEnd, newLength: length };
}
