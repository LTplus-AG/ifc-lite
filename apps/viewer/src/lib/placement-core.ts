/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Core placement-chain reader + generic IfcProduct edits.
 *
 * Walks the standard product placement chain
 *
 *   IfcProduct → ObjectPlacement → IfcLocalPlacement
 *              → RelativePlacement → IfcAxis2Placement3D
 *              → Location → IfcCartesianPoint → Coordinates [x, y, z]
 *
 * Reads honour the `StoreEditor` overlay (overlay-only entities,
 * positional-mutation overrides on top of source-buffer entities).
 * Writes go through `setPositionalAttribute` so they stack with
 * other overlay edits and participate in the standard undo path.
 *
 * Wall-specific edits live in `wall-edit.ts`; this module stays
 * generic so file size + cognitive scope stay manageable.
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
export function readAttributes(
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

/**
 * References take two forms in our attribute graph:
 *   - number (the parser normalises `#123` → 123 when reading source)
 *   - string `#123` (overlay entities created via `editor.addEntity`
 *     carry the raw `#X` form straight through)
 * Treat both as valid so the chain walker works for source-buffer
 * AND overlay-only entities — it's the same conceptual reference.
 */
export function asExpressIdRef(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.startsWith('#')) {
    const id = parseInt(value.slice(1), 10);
    return Number.isFinite(id) ? id : null;
  }
  return null;
}

export function asCoordinateTriple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 2) return null;
  const x = typeof value[0] === 'number' ? value[0] : NaN;
  const y = typeof value[1] === 'number' ? value[1] : NaN;
  // Coordinates may be 2D ([x, y]) — treat the missing Z as 0.
  const z = value.length >= 3 && typeof value[2] === 'number' ? value[2] : 0;
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return [x, y, z];
}

export function asDirectionRatios(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 2) return null;
  const x = typeof value[0] === 'number' ? value[0] : NaN;
  const y = typeof value[1] === 'number' ? value[1] : NaN;
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
 * Snapshot of the placement's IfcAxis2Placement3D rotation.
 * `refDirectionId === null` means the slot is implicit (STEP `$`) —
 * the default direction `[1, 0, 0]` is reported, but callers that
 * want to rotate must refuse this case (no IfcDirection to write to
 * without orphaning one on undo).
 */
export interface RotationState {
  axisPlacementId: number;
  refDirectionId: number | null;
  refDirection: [number, number, number];
  /** Current yaw about Z (rad). */
  yawZ: number;
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
 * radians. Updates RefDirection on the IfcAxis2Placement3D in place
 * when one already exists.
 *
 * Refuses to operate when the placement has no explicit RefDirection
 * (the implicit `[1, 0, 0]` STEP default). Materialising a fresh
 * IfcDirection there would require a multi-mutation atomic undo
 * entry to avoid orphans on undo, which the store doesn't have yet.
 * Every entity emitted by `@ifc-lite/create`'s in-store builders
 * carries an explicit RefDirection, so the implicit branch only
 * trips on hand-rolled source-buffer entities — surfacing a clear
 * refusal beats silently leaking entities.
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
  if (state.refDirectionId === null) {
    return {
      ok: false,
      reason:
        'Entity has an implicit reference direction; rotation requires an explicit IfcDirection on its axis placement.',
    };
  }
  const newYaw = state.yawZ + deltaYaw;
  const newRatios: [number, number, number] = [
    Math.cos(newYaw),
    Math.sin(newYaw),
    state.refDirection[2],
  ];
  editor.setPositionalAttribute(state.refDirectionId, 0, newRatios);
  return { ok: true, oldYawZ: state.yawZ, newYawZ: newYaw, newRefDirection: newRatios };
}
