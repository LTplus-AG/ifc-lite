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
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
