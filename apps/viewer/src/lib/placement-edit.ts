/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read & write the storey-local position of an IfcProduct by walking
 * the placement chain to its terminal `IfcCartesianPoint`.
 *
 * IFC pattern:
 *
 *   IfcProduct
 *     └── ObjectPlacement       ─► IfcLocalPlacement
 *                                      └── RelativePlacement ─► IfcAxis2Placement3D
 *                                                                    └── Location ─► IfcCartesianPoint
 *                                                                                       └── Coordinates [x, y, z]
 *
 * Reads honour the `StoreEditor` overlay (so a freshly-added entity or
 * an entity whose `Coordinates` has already been mutated returns the
 * updated value). Writes go through `setPositionalAttribute` so they
 * stack with other overlay edits and participate in undo via
 * `mutationSlice`'s `setPositionalAttribute` wrapper.
 *
 * Translation is in storey-local IFC space (Z-up), matching the
 * convention of `addColumn` / `addWall` builders. The viewer's Y-up
 * renderer frame conversion lives elsewhere — callers translating from
 * a viewer-frame delta should convert first.
 *
 * Returns `null` from the read helpers (and `{ error }` from the
 * translate helper) when the chain doesn't match the expected shape —
 * entities with mapped representations, 2D-only placements, or non-
 * `IfcLocalPlacement` ObjectPlacements all fall into that bucket. The
 * caller surfaces a "move not supported" toast and leaves the model
 * untouched.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

/**
 * Decode an entity's raw attributes from the source buffer.
 *
 * Injected from the call site rather than imported here directly —
 * `@ifc-lite/parser` transitively pulls in `@ifc-lite/ifcx` /
 * `@ifc-lite/pointcloud`, which aren't always buildable in the
 * test environment. The viewer wires this once at module load
 * (`placement-edit.boot.ts`); tests using only overlay entities
 * never need to provide it.
 */
export type SourceAttrsReader = (
  dataStore: IfcDataStore,
  expressId: number,
) => unknown[] | null;

let configuredSourceReader: SourceAttrsReader | null = null;

/**
 * Register the parser-backed source reader. Called once during app
 * boot. Pass `null` to clear (used by tests).
 */
export function setSourceAttrsReader(reader: SourceAttrsReader | null): void {
  configuredSourceReader = reader;
}

type EntityAttrs = unknown[];

/**
 * Read the effective attribute list for an express id. Overlay-only
 * entities come from the StoreEditor; source entities come from the
 * original buffer. Positional-mutation overrides are layered on top so
 * a previously-translated point reads back its mutated coords.
 */
function readAttributes(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
): EntityAttrs | null {
  const overlay = editor.getNewEntity(expressId);
  let attrs: EntityAttrs | null = null;
  if (overlay) {
    attrs = overlay.attributes.slice();
  } else if (configuredSourceReader) {
    attrs = configuredSourceReader(dataStore, expressId);
    if (!attrs) return null;
    attrs = attrs.slice();
  } else {
    // No source reader configured and no overlay entry — typical in
    // unit tests that don't wire `setSourceAttrsReader`. Treat as
    // "unknown entity" so callers fall back gracefully.
    return null;
  }
  // Apply positional mutations so a partially-edited entity reflects
  // its current state (relevant when the user translates the same
  // entity twice — the second read must see the first delta).
  const mutated = view.getPositionalMutationsForEntity(expressId);
  if (mutated) {
    for (const [index, value] of mutated.entries()) {
      attrs[index] = value;
    }
  }
  return attrs;
}

function asExpressIdRef(value: unknown): number | null {
  // References take two forms in our attribute graph:
  //   - number (the parser normalises `#123` → 123 when reading source)
  //   - string `#123` (overlay entities created via `editor.addEntity`
  //     carry the raw `#X` form straight through)
  // Treat both as valid so the chain walker works for source-buffer
  // AND overlay-only entities — it's the same conceptual reference.
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.startsWith('#')) {
    const id = parseInt(value.slice(1), 10);
    return Number.isFinite(id) ? id : null;
  }
  return null;
}

function asCoordinateTriple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 2) return null;
  const x = typeof value[0] === 'number' ? value[0] : NaN;
  const y = typeof value[1] === 'number' ? value[1] : NaN;
  // Coordinates may be 2D ([x, y]) — treat the missing Z as 0.
  const z = value.length >= 3 && typeof value[2] === 'number' ? value[2] : 0;
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return [x, y, z];
}

export interface PlacementChain {
  /** IfcProduct.ObjectPlacement target (IfcLocalPlacement express id). */
  localPlacementId: number;
  /** IfcLocalPlacement.RelativePlacement target (IfcAxis2Placement3D express id). */
  axisPlacementId: number;
  /** IfcAxis2Placement3D.Location target (IfcCartesianPoint express id). */
  cartesianPointId: number;
  /** Current coordinates on the IfcCartesianPoint (storey-local, IFC Z-up). */
  coordinates: [number, number, number];
}

/**
 * Resolve the full placement chain for an IfcProduct. Returns `null`
 * if any link is missing or has the wrong shape — callers should treat
 * this as "this entity's placement isn't directly translatable" and
 * surface a clear message rather than crashing.
 *
 * Indices follow the IfcProduct attribute order:
 *   [0] GlobalId · [1] OwnerHistory · [2] Name · [3] Description
 *   [4] ObjectType · [5] ObjectPlacement · [6] Representation · ...
 *
 * For non-product entities (e.g. profiles, points themselves) attrs[5]
 * either doesn't exist or isn't a placement reference, so we bail.
 */
export function resolvePlacementChain(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
): PlacementChain | null {
  const productAttrs = readAttributes(dataStore, view, editor, expressId);
  if (!productAttrs) return null;

  const localPlacementId = asExpressIdRef(productAttrs[5]);
  if (localPlacementId === null) return null;

  const localPlacementAttrs = readAttributes(dataStore, view, editor, localPlacementId);
  if (!localPlacementAttrs) return null;

  // IfcLocalPlacement.RelativePlacement is at index 1
  // ([0] = PlacementRelTo (parent placement)).
  const axisPlacementId = asExpressIdRef(localPlacementAttrs[1]);
  if (axisPlacementId === null) return null;

  const axisAttrs = readAttributes(dataStore, view, editor, axisPlacementId);
  if (!axisAttrs) return null;

  // IfcAxis2Placement3D.Location at index 0.
  const cartesianPointId = asExpressIdRef(axisAttrs[0]);
  if (cartesianPointId === null) return null;

  const pointAttrs = readAttributes(dataStore, view, editor, cartesianPointId);
  if (!pointAttrs) return null;

  const coordinates = asCoordinateTriple(pointAttrs[0]);
  if (!coordinates) return null;

  return { localPlacementId, axisPlacementId, cartesianPointId, coordinates };
}

export type TranslateResult =
  | { ok: true; oldCoordinates: [number, number, number]; newCoordinates: [number, number, number] }
  | { ok: false; reason: string };

/**
 * Translate an IfcProduct by `delta` (storey-local IFC Z-up). Reads
 * the current coordinates from the chain, adds the delta, writes back
 * via `setPositionalAttribute`. Caller is responsible for batching
 * undo (the upstream `setPositionalAttribute` action already pushes a
 * single mutation onto the model's undo stack).
 */
export function translateProduct(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  delta: [number, number, number],
): TranslateResult {
  const chain = resolvePlacementChain(dataStore, view, editor, expressId);
  if (!chain) {
    return {
      ok: false,
      reason:
        'Entity placement is not a simple IfcLocalPlacement → IfcAxis2Placement3D → IfcCartesianPoint chain',
    };
  }
  const [x, y, z] = chain.coordinates;
  const next: [number, number, number] = [x + delta[0], y + delta[1], z + delta[2]];
  editor.setPositionalAttribute(chain.cartesianPointId, 0, next);
  return { ok: true, oldCoordinates: chain.coordinates, newCoordinates: next };
}

/**
 * Set the entity's position to an absolute storey-local coordinate.
 * Convenience over `translateProduct` when the caller has a target
 * (e.g. a numeric form bound to current coordinates).
 */
export function setProductPosition(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  position: [number, number, number],
): TranslateResult {
  const chain = resolvePlacementChain(dataStore, view, editor, expressId);
  if (!chain) {
    return {
      ok: false,
      reason:
        'Entity placement is not a simple IfcLocalPlacement → IfcAxis2Placement3D → IfcCartesianPoint chain',
    };
  }
  editor.setPositionalAttribute(chain.cartesianPointId, 0, position);
  return { ok: true, oldCoordinates: chain.coordinates, newCoordinates: position };
}

/**
 * Read the IfcAxis2Placement3D's RefDirection — the in-plane X axis
 * of the placement. Returns `null` when the chain is malformed; the
 * default RefDirection (when the slot is `$`) is `[1, 0, 0]`.
 */
export interface RotationState {
  axisPlacementId: number;
  /** Express id of the explicit IfcDirection, or `null` if implicit (default [1,0,0]). */
  refDirectionId: number | null;
  /** Current in-plane direction ratios [x, y, z]. */
  refDirection: [number, number, number];
  /** Current yaw about Z (rad). */
  yawZ: number;
}

function asDirectionRatios(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 2) return null;
  const x = typeof value[0] === 'number' ? value[0] : NaN;
  const y = typeof value[1] === 'number' ? value[1] : NaN;
  const z = value.length >= 3 && typeof value[2] === 'number' ? value[2] : 0;
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return [x, y, z];
}

export function resolveRotationState(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
): RotationState | null {
  const chain = resolvePlacementChain(dataStore, view, editor, expressId);
  if (!chain) return null;
  const axisAttrs = readAttributes(dataStore, view, editor, chain.axisPlacementId);
  if (!axisAttrs) return null;
  // IfcAxis2Placement3D index 2 = RefDirection (an optional IfcDirection ref).
  const refDirectionId = asExpressIdRef(axisAttrs[2]);
  if (refDirectionId === null) {
    return {
      axisPlacementId: chain.axisPlacementId,
      refDirectionId: null,
      refDirection: [1, 0, 0],
      yawZ: 0,
    };
  }
  const dirAttrs = readAttributes(dataStore, view, editor, refDirectionId);
  if (!dirAttrs) return null;
  // IfcDirection index 0 = DirectionRatios (list of doubles).
  const ratios = asDirectionRatios(dirAttrs[0]);
  if (!ratios) return null;
  // Yaw about Z derived from the in-plane direction. Numerically
  // stable for any unit-length input; for non-unit inputs we still
  // recover the angle from atan2.
  const yawZ = Math.atan2(ratios[1], ratios[0]);
  return { axisPlacementId: chain.axisPlacementId, refDirectionId, refDirection: ratios, yawZ };
}

export type RotateResult =
  | { ok: true; oldYawZ: number; newYawZ: number; newRefDirection: [number, number, number] }
  | { ok: false; reason: string };

/**
 * Rotate an IfcProduct about the storey-up Z axis by `deltaYaw`
 * radians. Updates RefDirection on the IfcAxis2Placement3D in place.
 * When the placement has no explicit RefDirection (the implicit
 * `[1, 0, 0]` default), we materialise a fresh IfcDirection so we
 * have something to write to.
 */
export function rotateProductYaw(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  deltaYaw: number,
): RotateResult {
  const state = resolveRotationState(dataStore, view, editor, expressId);
  if (!state) {
    return {
      ok: false,
      reason:
        'Entity placement is not a simple IfcLocalPlacement → IfcAxis2Placement3D chain',
    };
  }
  const newYaw = state.yawZ + deltaYaw;
  const newRatios: [number, number, number] = [
    Math.cos(newYaw),
    Math.sin(newYaw),
    state.refDirection[2],
  ];
  if (state.refDirectionId === null) {
    // No explicit RefDirection — create one and point the axis
    // placement at it.
    const newDirId = editor.addEntity('IfcDirection', [newRatios]).expressId;
    editor.setPositionalAttribute(state.axisPlacementId, 2, `#${newDirId}`);
  } else {
    editor.setPositionalAttribute(state.refDirectionId, 0, newRatios);
  }
  return { ok: true, oldYawZ: state.yawZ, newYawZ: newYaw, newRefDirection: newRatios };
}

/**
 * Resolve the wall-edit chain for a wall created by
 * `@ifc-lite/create#addWallToStore`. Walls store their start/end as
 * (placement origin + RefDirection + profile XDim), so resizing
 * means touching four entities atomically. This helper resolves all
 * four; the caller computes new geometry and writes via
 * `setPositionalAttribute` per id.
 *
 * Returns null when the entity isn't a wall or its representation
 * isn't the expected `IfcRectangleProfileDef → IfcExtrudedAreaSolid`
 * shape (which most source-buffer walls don't follow).
 */
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
 * points. Updates four entities atomically:
 *
 *   - wall placement origin (IfcCartesianPoint)
 *   - RefDirection (IfcDirection)  → new normalised (end-start)
 *   - profile XDim (IfcRectangleProfileDef)  → new length
 *   - profile origin (IfcCartesianPoint)  → [newLength/2, 0]
 *
 * `end` is the absolute new end position; the helper computes the
 * length + direction internally.
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
