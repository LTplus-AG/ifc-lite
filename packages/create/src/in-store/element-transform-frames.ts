/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plan frames of product placements, expressed in their storey's frame
 * (charter #6232, C2 move / rotate).
 *
 * `translateEntity` adds a delta in the placement's PARENT frame and
 * `rotateEntity` turns its RefDirection there. A move or turn is picked in the
 * storey's frame (the workplane), so each moved element needs its parent
 * placement's frame in the storey frame — the identity for the common
 * element-under-storey shape, the host's frame for an opening, a composed
 * chain for an assembly part — and its own origin there, to turn it about a
 * pivot. Reads honour the session's overlay (created entities, positional
 * edits), through the canonical current `readPlacementAttributes`.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { asCoordinateTriple, asDirectionRatios, asExpressIdRef, readPlacementAttributes } from './edit/placement-core.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';

type Vec2 = [number, number];

/** A planar rigid frame in the storey frame: `p ↦ R·p + origin`, `R`'s first column `axis`. Metres. */
export interface PlanFrame {
  origin: Vec2;
  /** Unit x axis. */
  axis: Vec2;
}

export const IDENTITY_FRAME: PlanFrame = { origin: [0, 0], axis: [1, 0] };

export interface PlacementReader {
  readonly dataStore: IfcDataStore;
  readonly view: MutablePropertyView;
}

function attrs(r: PlacementReader, id: number): unknown[] | null {
  return readPlacementAttributes(r.dataStore, r.view, r.view, id);
}

/** A product's `ObjectPlacement` (an `IfcLocalPlacement` id), or null. */
export function objectPlacementOf(r: PlacementReader, productId: number): number | null {
  const product = attrs(r, productId);
  return product ? asExpressIdRef(product[5]) : null;
}

/** An `IfcLocalPlacement`'s `PlacementRelTo`, or null for a root placement. */
export function parentPlacementOf(r: PlacementReader, placementId: number): number | null {
  const placement = attrs(r, placementId);
  return placement ? asExpressIdRef(placement[0]) : null;
}

/** The `IfcAxis2Placement3D` attributes of an `IfcLocalPlacement`, or null. */
function axisPlacement(r: PlacementReader, placementId: number): unknown[] | null {
  const placement = attrs(r, placementId);
  const axisId = placement ? asExpressIdRef(placement[1]) : null;
  return axisId === null ? null : attrs(r, axisId);
}

/** A placement's origin in its parent's frame, metres (x, y). */
export function placementOrigin(r: PlacementReader, placementId: number): Vec2 | null {
  const axisAttrs = axisPlacement(r, placementId);
  const locationId = axisAttrs ? asExpressIdRef(axisAttrs[0]) : null;
  const location = locationId === null ? null : asCoordinateTriple(attrs(r, locationId)?.[0]);
  if (!location) return null;
  const scale = getModelLengthUnitScale(r.dataStore);
  return [location[0] * scale, location[1] * scale];
}

/**
 * A placement's own plan frame in its parent's frame; null when a link is
 * unreadable or its Z axis is not up — a tilted placement has no planar
 * frame, and turning it about Z would tip it: refuse, never guess.
 */
export function uprightFrame(r: PlacementReader, placementId: number): PlanFrame | null {
  const axisAttrs = axisPlacement(r, placementId);
  const origin = placementOrigin(r, placementId);
  if (!axisAttrs || !origin) return null;
  const zId = asExpressIdRef(axisAttrs[1]);
  if (zId !== null) {
    const z = asDirectionRatios(attrs(r, zId)?.[0]);
    if (!z || Math.hypot(z[0], z[1]) > 1e-6 || z[2] <= 0) return null;
  }
  let axis: Vec2 = [1, 0];
  const refId = asExpressIdRef(axisAttrs[2]);
  if (refId !== null) {
    const ref = asDirectionRatios(attrs(r, refId)?.[0]);
    const length = ref ? Math.hypot(ref[0], ref[1]) : 0;
    if (!ref || !(length > 1e-9)) return null;
    axis = [ref[0] / length, ref[1] / length];
  }
  return { origin, axis };
}

/** `inner` (in `outer`'s frame) re-expressed in `outer`'s parent frame. */
export function composeFrames(outer: PlanFrame, inner: PlanFrame): PlanFrame {
  return { origin: applyFrame(outer, inner.origin), axis: rotateBy(outer.axis, inner.axis) };
}

/** Rotate `v` by the rotation whose x axis is `axis`. */
export function rotateBy(axis: Vec2, v: readonly [number, number]): Vec2 {
  return [axis[0] * v[0] - axis[1] * v[1], axis[1] * v[0] + axis[0] * v[1]];
}

/** The inverse rotation of {@link rotateBy}. */
export function unrotateBy(axis: Vec2, v: readonly [number, number]): Vec2 {
  return [axis[0] * v[0] + axis[1] * v[1], -axis[1] * v[0] + axis[0] * v[1]];
}

export function applyFrame(frame: PlanFrame, p: readonly [number, number]): Vec2 {
  const [x, y] = rotateBy(frame.axis, p);
  return [frame.origin[0] + x, frame.origin[1] + y];
}

/**
 * The frame of `placementId` in the frame of `storeyPlacementId`: its own
 * frame composed with every `PlacementRelTo` hop up to (not including) the
 * storey's placement. `placementId === storeyPlacementId` is the identity.
 * Null when the chain never reaches the storey's placement (a root or a
 * cycle) or a link cannot be read.
 */
export function frameInStorey(r: PlacementReader, placementId: number, storeyPlacementId: number): PlanFrame | null {
  let frame = IDENTITY_FRAME;
  const seen = new Set<number>();
  for (let id: number | null = placementId; id !== storeyPlacementId; id = parentPlacementOf(r, id)) {
    if (id === null || seen.has(id)) return null;
    seen.add(id);
    const own = uprightFrame(r, id);
    if (!own) return null;
    frame = composeFrames(own, frame);
  }
  return frame;
}

/** Every placement above `placementId` (its parent first), stopping at a root or a cycle. */
export function placementAncestors(r: PlacementReader, placementId: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([placementId]);
  for (let id = parentPlacementOf(r, placementId); id !== null && !seen.has(id); id = parentPlacementOf(r, id)) {
    out.push(id);
    seen.add(id);
  }
  return out;
}
