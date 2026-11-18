/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Input guards and the `IfcAnnotation` emitter shared by every drawing-markup
 * builder (`drawing-markup.ts`, `drawing-markup-dimension.ts`). Package
 * internal: not re-exported from the in-store index.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { ownerHistoryRef } from './_emit-helpers.js';
import type { MarkupAnchor, MarkupPoint2D } from './drawing-markup.js';

/**
 * A drawing-space coordinate may legitimately be negative or zero — the
 * caller's own drawing origin, not this module's to constrain — so this only
 * rejects NaN/Infinity, never a sign check. Same split `spatial-zone.ts`'s
 * `validateZone` uses for its Footprint points, the closest analog: without
 * it, a NaN/Infinity coordinate reaches `IfcCartesianPoint` as the literal
 * `$` inside a mandatory-REAL attribute list — schema-invalid STEP written
 * with no error.
 */
export function assertFinitePoint(functionName: string, label: string, p: MarkupPoint2D): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new Error(`${functionName}: ${label} needs a finite point`);
  }
}

/**
 * Distance/area/perimeter/extent are derived measurements: never negative,
 * but legitimately zero (a degenerate measurement, e.g. a zero-length
 * measure). So this rejects NaN/Infinity and negative values, not `<= 0`
 * like `_emit-helpers.ts`'s `assertPositiveFinite` (which guards true
 * dimensions — Width, Height — that can never be zero). Without this, a NaN
 * silently becomes a zeroed quantity value on write (`toNativeLength(NaN)`
 * multiplies through to `NaN`, which the STEP writer would still need to
 * catch) rather than failing loudly here.
 */
export function assertFiniteNonNegative(functionName: string, label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${functionName}: ${label} must be finite and non-negative`);
  }
}

/** IfcAnnotation attribute order: GlobalId, OwnerHistory, Name, Description,
 *  ObjectType, ObjectPlacement, Representation — same 7-slot shape across
 *  IFC2X3/IFC4/IFC4X3 (schema-registry.ts `IfcAnnotation.allAttributes`). */
export function emitAnnotation(
  editor: StoreEditor,
  anchor: MarkupAnchor,
  name: string,
  objectType: string,
  placementId: number,
  productShapeId: number,
): number {
  return editor.addEntity('IfcAnnotation', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    name,
    null,
    objectType,
    `#${placementId}`,
    `#${productShapeId}`,
  ]).expressId;
}
