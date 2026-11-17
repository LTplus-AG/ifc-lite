/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a copy of an element on a grid does (#9199): it binds to the crossing it
 * lands on, among the same crossings a snap offers on its storey. Landing on none,
 * it comes free. Both index reads are built once per copy context, because a whole
 * array shares one.
 */

import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import type { CopyContext } from './copy-product.js';
import { hangsFromGrid, localPlacementHop, composeRigid, IDENTITY_FRAME, type CopyVec3, type RigidFrame } from './copy-frame.js';
import { extractGridAxesForStorey } from './extract-grids.js';
import { gridAxisIntersections, type GridCrossing } from './grid-crossings.js';
import { gridIntersectionPlacement } from './grid.js';
import { gridObjectPlacement, readGridPlacement, uprightFrameIn } from './grid-placement-read.js';
import { asRef, refList } from './style-entity-reader.js';

/** How close, in metres, a copy must land to a crossing to bind to it. */
export const GRID_LANDING_TOLERANCE_M = 1e-3;

interface GridIndex {
  gridOfAxis: Map<number, number> | null;
  crossings: Map<number, readonly GridCrossing[]>;
}

const indexes = new WeakMap<CopyContext, GridIndex>();

function indexOf(ctx: CopyContext): GridIndex {
  let index = indexes.get(ctx);
  if (!index) {
    index = { gridOfAxis: null, crossings: new Map() };
    indexes.set(ctx, index);
  }
  return index;
}

/** First grid in file order listing the axis: the reader's owner rule. */
function gridOfAxis(ctx: CopyContext, axisId: number): number | null {
  const index = indexOf(ctx);
  if (!index.gridOfAxis) {
    const owners = new Map<number, number>();
    for (const { expressId } of iterateEffectiveEntityIds(ctx.store, ctx.editor.getMutationView(), ['IFCGRID'])) {
      const grid = ctx.read(expressId);
      for (const row of [7, 8, 9]) for (const axis of refList(grid?.attributes[row])) if (!owners.has(axis)) owners.set(axis, expressId);
    }
    index.gridOfAxis = owners;
  }
  return index.gridOfAxis.get(axisId) ?? null;
}

function crossingsOn(ctx: CopyContext, storeyId: number): readonly GridCrossing[] {
  const index = indexOf(ctx);
  let crossings = index.crossings.get(storeyId);
  if (!crossings) {
    crossings = gridAxisIntersections(extractGridAxesForStorey(ctx.store, storeyId, ctx.editor.getMutationView()).axes);
    index.crossings.set(storeyId, crossings);
  }
  return crossings;
}

/**
 * Where a placement's chain reaches the grid from: itself when it is an
 * IfcGridPlacement, else its parent when that hangs from one. Null off the grid.
 */
export function gridChainStart(ctx: CopyContext, placementId: number | null): number | null {
  if (placementId === null) return null;
  const placement = ctx.read(placementId);
  if (placement?.type.toUpperCase() === 'IFCGRIDPLACEMENT') return placementId;
  if (placement?.type.toUpperCase() !== 'IFCLOCALPLACEMENT') return null;
  const parent = asRef(placement.attributes[0]);
  return hangsFromGrid(ctx.read, parent) ? parent : null;
}

export interface GridBoundFrame {
  /** The frame of the chain's start, in the reference. */
  readonly frame: RigidFrame;
  /** Where its grid's axes meet, with no offset, in the reference. */
  readonly crossing: CopyVec3;
  readonly gridId: number | null;
}

/** `startId`'s frame through its local placements and the IfcGridPlacement above them; null when a link does not read. */
export function gridBoundFrame(ctx: CopyContext, startId: number, referenceId: number | null): GridBoundFrame | null {
  let frame = IDENTITY_FRAME;
  const visited = new Set<number>();
  for (let id: number | null = startId; id !== null && !visited.has(id);) {
    visited.add(id);
    if (ctx.read(id)?.type.toUpperCase() === 'IFCGRIDPLACEMENT') {
      const grid = readGridPlacement(ctx.read, (axis) => gridOfAxis(ctx, axis), id, referenceId);
      return grid && { frame: composeRigid(grid.frame, frame), crossing: grid.crossing, gridId: grid.gridId };
    }
    let hop: ReturnType<typeof localPlacementHop>;
    try {
      hop = localPlacementHop(ctx.read, id);
    } catch (error) {
      // A tilted link has no rigid frame on the storey: the same answer as one that does not read.
      console.warn(`[create] placement #${id} cannot be read as a place on the grid`, error);
      return null;
    }
    if (!hop) return null;
    frame = composeRigid(hop.frame, frame);
    id = hop.parentId;
  }
  return null;
}

export interface GridLanding {
  readonly placementId: number;
  /** The new grid placement's frame in the storey's: the crossing, turned as the grid is. */
  readonly frame: RigidFrame;
  /** How far the copy's point moved to sit exactly on the crossing, native units. */
  readonly snap: readonly [number, number];
}

/**
 * Bind to the crossing one of `points` lands on, first point first; among several
 * grids the source's own wins, then the nearest. Writes the IfcGridPlacement, with
 * the schema's own layout. Null when none is there: a storey with no placement has
 * no frame to bind in, as for a column placed on a grid.
 */
export function landOnCrossing(
  ctx: CopyContext,
  storeyId: number,
  storeyPlacementId: number,
  points: readonly CopyVec3[],
  sourceGridId: number | null,
  scale: number,
): GridLanding | null {
  const crossings = crossingsOn(ctx, storeyId);
  if (crossings.length === 0) return null;
  for (const point of points) {
    const near = crossings
      .map((crossing) => ({ crossing, distance: Math.hypot(crossing.at[0] - point[0] * scale, crossing.at[1] - point[1] * scale) }))
      .filter(({ distance }) => distance <= GRID_LANDING_TOLERANCE_M)
      .sort((a, b) => Number(b.crossing.gridId === sourceGridId) - Number(a.crossing.gridId === sourceGridId) || a.distance - b.distance);
    for (const { crossing } of near) {
      const gridPlacementId = gridObjectPlacement(ctx.read, crossing.gridId);
      const gridFrame = gridPlacementId === null ? null : uprightFrameIn(ctx.read, gridPlacementId, storeyPlacementId);
      if (gridPlacementId === null || !gridFrame) continue;
      const at = [crossing.at[0] / scale, crossing.at[1] / scale] as const;
      try {
        const { placementId } = gridIntersectionPlacement(ctx.editor, { schema: (ctx.store.schemaVersion ?? 'IFC4') as Parameters<typeof gridIntersectionPlacement>[1]['schema'], lengthUnitScale: scale }, {
          Axes: crossing.IntersectingAxes, GridPlacementId: gridPlacementId,
        }, ctx.store);
        return {
          placementId,
          frame: { origin: [at[0], at[1], gridFrame.origin[2]], c: gridFrame.c, s: gridFrame.s },
          snap: [at[0] - point[0], at[1] - point[1]],
        };
      } catch (error) {
        // It refuses before it writes (an axis two grids list, say): this crossing is not one to bind to.
        console.warn(`[create] a copy cannot bind to grid #${crossing.gridId}'s crossing`, error);
      }
    }
  }
  return null;
}
