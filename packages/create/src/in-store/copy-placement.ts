/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a copy goes: its parent placement and its own place in that parent, in
 * the frame the preview (`copy-ghost.ts`) moves the mesh in, the storey's.
 *
 * An element on a grid (#9199) has a place through its grid placement. Its copy
 * binds to the crossing it lands on, under a new IfcGridPlacement with a local
 * child holding what the source held (height, heading, any offset from the
 * crossing). Landing on none, it comes free under the storey's placement.
 */

import type { SourceAttributes } from './duplicate.js';
import { resolveDuplicateSource } from './resolve-source.js';
import { asRef } from './style-entity-reader.js';
import {
  IDENTITY_FRAME, applyRigid, composeRigid, frameInAncestor, invertRigid, readOwnPlacement,
  type CopyVec3, type LiveRead, type OwnPlacement, type RigidFrame,
} from './copy-frame.js';
import type { CopyContext } from './copy-product.js';
import { copyDependentSteps } from './copy-dependent-walk.js';
import { gridBoundFrame, gridChainStart, landOnCrossing } from './copy-grid-landing.js';

/** Where a copy sits: its parent placement and its own placement in that parent. */
export interface Placed {
  readonly parentPlacementId: number | null;
  readonly location: CopyVec3;
  /** The turn to apply to the source's Axis and RefDirection. */
  readonly turn: RigidFrame;
  /** What it turns, when the source's placement has no axes of its own to read: one directly on a grid. */
  readonly own?: Pick<OwnPlacement, 'axis' | 'refDirection'>;
  /** How a copy of a grid-bound element ended up; absent for any other. */
  readonly grid?: 'bound' | 'free';
}

const UNREADABLE_GRID_PLACEMENT = "It sits on a grid crossing whose position can't be read, so it can't be copied";
/** A product pointing straight at its grid placement has no place of its own in it. */
const AT_THE_PLACEMENT = { location: [0, 0, 0] as CopyVec3, axis: null, refDirection: null };

export function storeyPlacementId(read: LiveRead, storeyId: number | null): number | null {
  return storeyId === null ? null : asRef(read(storeyId)?.attributes[5]);
}

/** Why `rootId`, or something it carries, cannot be copied from the grid: its place on it does not read. */
export function gridCopyRefusal(ctx: CopyContext, rootId: number): string | null {
  const ids = [rootId];
  for (const step of copyDependentSteps(ctx, rootId)) if (step.kind !== 'assembly') ids.push(step.sourceId);
  const starts = ids.map((id) => gridChainStart(ctx, asRef(ctx.read(id)?.attributes[5]))).filter((start) => start !== null);
  if (starts.length === 0) return null;
  let reference: number | null;
  try {
    reference = storeyPlacementId(ctx.read, resolveDuplicateSource(ctx.store, rootId, ctx.editor, ctx.sourceScope).storeyId);
  } catch (error) {
    console.warn(`[create] #${rootId} has no readable placement to copy from`, error);
    return UNREADABLE_GRID_PLACEMENT;
  }
  return starts.every((start) => gridBoundFrame(ctx, start, reference)) ? null : UNREADABLE_GRID_PLACEMENT;
}

/**
 * The source's parent placement as a frame in its storey's. A storey without a
 * placement has no frame to tie to (the storey plane is then the model frame).
 * A parent that does not chain to the storey's placement has no known place on
 * the storey, so the copy is refused: the preview (`copy-ghost.ts`) works in
 * the storey's frame, and a guess here would commit the copy somewhere else.
 */
function parentFrameInStorey(read: LiveRead, source: SourceAttributes, fromStorey: number | null): RigidFrame {
  if (fromStorey === null) return IDENTITY_FRAME;
  const parent = frameInAncestor(read, source.parentPlacementId, fromStorey);
  if (!parent) throw new Error("Its placement is not tied to its storey's, so it cannot be copied");
  return parent;
}

function ownOf(ctx: CopyContext, source: SourceAttributes, start: number | null): Pick<OwnPlacement, 'location' | 'axis' | 'refDirection'> | null {
  return start === source.placementExpressId ? AT_THE_PLACEMENT : readOwnPlacement(ctx.read, source.placementExpressId);
}

/** Zero the arithmetic's dust, so a copy on a crossing writes a clean local point. */
const clean = (p: CopyVec3): CopyVec3 => [p[0], p[1], p[2]].map((v) => (Math.abs(v) < 1e-9 ? 0 : v)) as CopyVec3;

function placeFromGrid(ctx: CopyContext, source: SourceAttributes, start: number, targetStoreyId: number | null, move: RigidFrame): Placed {
  const bound = gridBoundFrame(ctx, start, storeyPlacementId(ctx.read, source.storeyId));
  const own = ownOf(ctx, source, start);
  if (!bound || !own) throw new Error(UNREADABLE_GRID_PLACEMENT);
  const toStorey = storeyPlacementId(ctx.read, targetStoreyId);
  if (toStorey === null && targetStoreyId !== source.storeyId) throw new Error('The storey it is copied to has no placement to copy under');
  const moved = composeRigid(move, bound.frame);
  const shared = start === source.placementExpressId ? { own: AT_THE_PLACEMENT } : {};
  const free: Placed = { parentPlacementId: toStorey, location: applyRigid(moved, own.location), turn: moved, ...shared, grid: 'free' };
  if (targetStoreyId === null || toStorey === null) return free;
  // The crossing moved with it keeps an offset element off the new crossing as it
  // was off its own. Its own origin is what a paste grips, so that may land instead.
  const scale = source.lengthUnitScale && source.lengthUnitScale > 0 ? source.lengthUnitScale : 1;
  const landing = landOnCrossing(ctx, targetStoreyId, toStorey, [applyRigid(move, bound.crossing), free.location], bound.gridId, scale);
  if (!landing) return free;
  const snapped: RigidFrame = { ...moved, origin: [moved.origin[0] + landing.snap[0], moved.origin[1] + landing.snap[1], moved.origin[2]] };
  const turn = composeRigid(invertRigid(landing.frame), snapped);
  return { parentPlacementId: landing.placementId, location: clean(applyRigid(turn, own.location)), turn, ...shared, grid: 'bound' };
}

export function placeOnStorey(ctx: CopyContext, source: SourceAttributes, targetStoreyId: number | null, move: RigidFrame): Placed {
  const start = gridChainStart(ctx, source.placementExpressId);
  if (start !== null) return placeFromGrid(ctx, source, start, targetStoreyId, move);
  const { read } = ctx;
  const own = readOwnPlacement(read, source.placementExpressId);
  if (!own) throw new Error('Its placement could not be read, so it cannot be copied');
  const parent = parentFrameInStorey(read, source, storeyPlacementId(read, source.storeyId));
  if (targetStoreyId === source.storeyId) {
    const location = applyRigid(invertRigid(parent), applyRigid(move, applyRigid(parent, own.location)));
    return { parentPlacementId: source.parentPlacementId, location, turn: move };
  }
  const toStorey = storeyPlacementId(read, targetStoreyId);
  if (toStorey === null) {
    throw new Error('The storey it is copied to has no placement to copy under');
  }
  // Same plan position and height above the floor, now under the other storey's placement.
  return { parentPlacementId: toStorey, location: applyRigid(move, applyRigid(parent, own.location)), turn: composeRigid(move, parent) };
}

/**
 * A hosted element: under the copy of the placement it was placed relative
 * to, unchanged; otherwise moved as its host was, on the host's storey (an
 * opening is not contained in one of its own).
 */
export function follow(
  ctx: CopyContext,
  source: SourceAttributes,
  host: SourceAttributes,
  targetStoreyId: number | null,
  placements: ReadonlyMap<number, number>,
  move: RigidFrame,
): Placed {
  const mapped = source.parentPlacementId === null ? undefined : placements.get(source.parentPlacementId);
  if (mapped !== undefined) return { parentPlacementId: mapped, location: [...source.sourceLocation], turn: IDENTITY_FRAME };
  return placeOnStorey(ctx, { ...source, storeyId: host.storeyId }, targetStoreyId, move);
}

/**
 * Where a product's placement origin is on its storey, metres: the point a
 * paste lines up with the cursor. Null when its placement does not read;
 * throws (with the reason) when it is not tied to its storey, as a copy would.
 */
export function productStoreyOrigin(ctx: CopyContext, id: number): { storeyId: number | null; origin: CopyVec3 } | null {
  let source: SourceAttributes;
  try {
    source = resolveDuplicateSource(ctx.store, id, ctx.editor, ctx.sourceScope);
  } catch (error) {
    console.warn(`[create] #${id} has no readable placement to copy from`, error);
    return null;
  }
  const fromStorey = storeyPlacementId(ctx.read, source.storeyId);
  const start = gridChainStart(ctx, source.placementExpressId);
  const own = ownOf(ctx, source, start);
  if (!own) return null;
  const grid = start === null ? null : gridBoundFrame(ctx, start, fromStorey);
  if (start !== null && !grid) throw new Error(UNREADABLE_GRID_PLACEMENT);
  const parent = grid ? grid.frame : parentFrameInStorey(ctx.read, source, fromStorey);
  const scale = source.lengthUnitScale && source.lengthUnitScale > 0 ? source.lengthUnitScale : 1;
  const [x, y, z] = applyRigid(parent, own.location);
  return { storeyId: source.storeyId, origin: [x * scale, y * scale, z * scale] };
}
