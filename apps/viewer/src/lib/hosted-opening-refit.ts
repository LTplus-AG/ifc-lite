/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keep a host's openings valid when its body changes size (charter #6232, C4).
 *
 * A wall or slab authored here carries its openings as `IfcOpeningElement`
 * voids whose cut runs across the host's body plus 50 mm each side
 * (`addOpeningToStore`). A thicker wall, or a slab pulled up, leaves that cut
 * too short: it stops in the body and the door or window no longer opens
 * through it. A shorter wall can leave an opening's top above the wall. This
 * module plans the fix as positional writes the caller batches with the
 * host's own resize (one undo step), or names the opening that stops the
 * change:
 *
 *   - `planCutRefit`: the cut no longer spans the new body along the axis it
 *     is extruded on. It is lengthened, keeping the overshoot, when it is the
 *     builders' shape (a rectangle extruded along the host's Y for a wall, Z
 *     for a slab, from the placement); another opening shape is refused
 *     rather than rewritten blind. A cut that still spans the body is left.
 *   - `heightRefusal`: an opening reaching above a wall's new top.
 *
 * Lengths here are the file's NATIVE unit, like the STEP entities they edit;
 * callers convert at the edge.
 */

import { placedBodyExtent, resolveHostAnchor, toNativeLength, type HostBounds } from '@ifc-lite/create';
import type { IfcAttributeValue } from '@ifc-lite/mutations';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { asCoordinateTriple, asDirectionRatios, asExpressIdRef, readAttributes } from './placement-core.js';

export interface PositionalUpdate {
  entityId: number;
  index: number;
  value: IfcAttributeValue;
}

export type RefitOutcome =
  | { ok: true; updates: PositionalUpdate[]; /** The openings the updates rewrite: they re-mesh with the host. */ openings: number[] }
  | { ok: false; reason: string };

/** Metres a cut overshoots each face of its host, as the opening builder writes it. */
const CLEARANCE_M = 0.05;
const EPS = 1e-6;

/** The openings voiding `hostId` (IfcRelVoidsElement), live in the source and the overlay. */
export function openingsOf(target: ModelEditTarget, hostId: number): number[] {
  const { dataStore, view, editor } = target;
  const openings: number[] = [];
  for (const { expressId: relId } of iterateEffectiveEntityIds(dataStore, view, ['IFCRELVOIDSELEMENT'])) {
    const rel = readAttributes(dataStore, view, editor, relId);
    const opening = rel && asExpressIdRef(rel[4]) === hostId ? asExpressIdRef(rel[5]) : null;
    if (opening !== null) openings.push(opening);
  }
  return openings;
}

/** An opening's placement point, axis and extrusion, when it is laid out the way the builders write it. */
interface CutLayout {
  pointId: number;
  location: [number, number, number];
  /** +1 or -1: the sign of the placement's Axis along the host axis being cut across. */
  sign: 1 | -1;
  solidId: number;
  depth: number;
}

function cutLayout(target: ModelEditTarget, openingId: number, axis: 1 | 2): CutLayout | null {
  const { dataStore, view, editor } = target;
  const read = (id: number | null) => (id === null ? null : readAttributes(dataStore, view, editor, id));
  const opening = read(openingId);
  const placement = read(opening ? asExpressIdRef(opening[5]) : null);
  const axis3 = read(placement ? asExpressIdRef(placement[1]) : null);
  const point = read(axis3 ? asExpressIdRef(axis3[0]) : null);
  const location = point ? asCoordinateTriple(point[0]) : null;
  if (!axis3 || !location) return null;

  // No Axis is the default +Z; otherwise it must run straight along the axis being cut across.
  const dir = axis3[1] == null ? [0, 0, 1] : asDirectionRatios(read(asExpressIdRef(axis3[1]))?.[0]);
  const len = dir ? Math.hypot(dir[0], dir[1], dir[2]) : 0;
  if (!dir || len < EPS) return null;
  const unit = dir.map((v) => v / len);
  if (Math.abs(unit[axis]) < 1 - 1e-6) return null;

  const shape = read(opening ? asExpressIdRef(opening[6]) : null);
  const reps = Array.isArray(shape?.[2]) ? shape[2] as unknown[] : [];
  const rep = read(reps.length > 0 ? asExpressIdRef(reps[0]) : null);
  const items = Array.isArray(rep?.[3]) ? rep[3] as unknown[] : [];
  const solidId = items.length > 0 ? asExpressIdRef(items[0]) : null;
  const solid = read(solidId);
  const depth = solid?.[3];
  if (solidId === null || typeof depth !== 'number' || !(depth > 0)) return null;
  // A solid position of its own would move the cut off the placement the formulas assume.
  if (solid?.[1] != null) {
    const position = read(asExpressIdRef(solid[1]));
    const at = position ? asCoordinateTriple(read(asExpressIdRef(position[0]))?.[0]) : null;
    if (!at || at.some((v) => Math.abs(v) > EPS) || position?.[1] != null || position?.[2] != null) return null;
  }
  return { pointId: asExpressIdRef(axis3[0])!, location, sign: unit[axis] > 0 ? 1 : -1, solidId, depth };
}

/**
 * The writes that make every opening of `hostId` span `newExtent` (native
 * units, the host's frame) along `axis` (1: across a wall, 2: through a slab)
 * with the builders' overshoot, or why one of them cannot.
 */
export function planCutRefit(
  target: ModelEditTarget,
  hostId: number,
  axis: 1 | 2,
  newExtent: readonly [number, number],
  lengthUnitScale: number,
): RefitOutcome {
  const { dataStore, view } = target;
  const over = toNativeLength({ lengthUnitScale }, CLEARANCE_M);
  const fit = over / 10;
  const updates: PositionalUpdate[] = [];
  const openings: number[] = [];
  for (const openingId of openingsOf(target, hostId)) {
    const extent = placedBodyExtent(dataStore, openingId, view);
    if (!extent) return { ok: false, reason: `The size of opening #${openingId} can't be read, so the host can't be resized safely` };
    if (extent.min[axis] <= newExtent[0] + EPS && extent.max[axis] >= newExtent[1] - EPS) continue;
    const layout = cutLayout(target, openingId, axis);
    const expected = layout && (layout.sign > 0
      ? [layout.location[axis], layout.location[axis] + layout.depth]
      : [layout.location[axis] - layout.depth, layout.location[axis]]);
    // Rewrite only the layout whose extent the formulas reproduce.
    if (!layout || !expected || Math.abs(expected[0] - extent.min[axis]) > fit || Math.abs(expected[1] - extent.max[axis]) > fit) {
      return { ok: false, reason: `Opening #${openingId} is not a plain cut, so it can't follow the resize; move or delete it first` };
    }
    const depth = newExtent[1] - newExtent[0] + 2 * over;
    const location: [number, number, number] = [...layout.location];
    location[axis] = layout.sign > 0 ? newExtent[0] - over : newExtent[1] + over;
    updates.push({ entityId: layout.pointId, index: 0, value: location });
    updates.push({ entityId: layout.solidId, index: 3, value: depth });
    openings.push(openingId);
  }
  return { ok: true, updates, openings };
}

/** Why a wall cannot be `topNative` high (the host's frame, native units): an opening reaches above it. Null when all fit. */
export function heightRefusal(target: ModelEditTarget, hostId: number, topNative: number, lengthUnitScale: number): string | null {
  const { dataStore, view } = target;
  const slack = toNativeLength({ lengthUnitScale }, 1e-4);
  for (const openingId of openingsOf(target, hostId)) {
    const extent = placedBodyExtent(dataStore, openingId, view);
    if (!extent) return `The size of opening #${openingId} can't be read, so the wall can't be resized safely`;
    if (extent.max[2] > topNative + slack) return `Opening #${openingId} reaches above the new top of the wall: lower or delete it first`;
  }
  return null;
}

/** The host's body extent in its own frame (native units), or null when its geometry is unreadable. */
export function hostBodyExtent(target: ModelEditTarget, hostId: number): HostBounds | null {
  try {
    return resolveHostAnchor(target.dataStore, hostId, target.view).hostBounds;
  } catch (error) {
    console.warn(`[modeling] host #${hostId} is unreadable; its openings are not refitted`, error);
    return null;
  }
}
