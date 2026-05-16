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

  return {
    startPointId: chain.cartesianPointId,
    startCoordinates: chain.coordinates,
    refDirectionId: rot.refDirectionId,
    refDirection: rot.refDirection,
    profileId,
    wallLength: xdim,
    thickness: ydim,
    profileOriginPointId,
  };
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
