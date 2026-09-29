/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.move` (charter #6232, C2): move the selection — one element or
 * many, authored or from the file — by a base point and a target point.
 *
 * The first click (snapped) is the base, the second the target; the target
 * snaps and tracks from the base like a wall's second point, and the Distance
 * and Direction fields lock it the same way (`endPoint`). Typing a distance
 * before any click moves from the selection's centre. Hosted openings and the
 * doors and windows in them go with their host (`lib/element-transform`).
 * The commit is ONE transaction, one undo step; the command then ends with the
 * selection kept, ready for the next edit.
 */

import { ElementMovePlan, ElementMoveScene } from '@/components/viewer/tools/command/ElementMoveLayers';
import { commitElementTransform } from '@/lib/element-transform/commit';
import type { Vec2 } from '@/lib/snap/types';
import { commandGhostId } from '../ghost.js';
import { currentAngle, currentLength, endPoint } from './wall-place-geometry.js';
import { readTransformSelection, selectionExtent, transformedGhosts } from './element-transform-shared.js';
import { moveAsWallGesture, type ElementMoveGesture } from './element-move-geometry.js';
import type { CommandContext, CommandField, ModelingCommand, Workplane } from '../types.js';

/** Below this a move is no move (metres). */
const MIN_MOVE = 1e-4;

function init(ctx: CommandContext): ElementMoveGesture {
  return { selection: readTransformSelection(ctx.get()), base: null, cursor: null, distance: null, angle: null };
}

/**
 * A value typed before any click moves from the selection's centre (the
 * cursor, the plane origin when it has no mesh): a typed distance and
 * direction are the whole move, whatever the base.
 */
function withBase(g: ElementMoveGesture, ctx: CommandContext): ElementMoveGesture {
  if (g.base || !g.selection || !ctx.workplane) return g;
  const base = selectionExtent(ctx.get(), g.selection, ctx.workplane)?.centre ?? g.cursor ?? [0, 0];
  return { ...g, base, cursor: g.cursor ?? base };
}

const target = (g: ElementMoveGesture): Vec2 | null => endPoint(moveAsWallGesture(g));

function op(g: ElementMoveGesture, plane: Workplane) {
  const to = target(g);
  if (!g.base || !to) return null;
  return { kind: 'move' as const, from: plane.localToRender([g.base[0], g.base[1], 0]), to: plane.localToRender([to[0], to[1], 0]) };
}

const FIELDS: readonly CommandField<ElementMoveGesture>[] = [
  {
    id: 'distance', labelKey: 'moveRotate.field.distance', unit: 'm', group: 'move',
    read: (g) => currentLength(moveAsWallGesture(g)),
    write: (g, v, ctx) => ({ ...withBase(g, ctx), distance: Math.abs(v) }),
  },
  {
    id: 'direction', labelKey: 'moveRotate.field.direction', unit: 'deg', group: 'move',
    read: (g) => currentAngle(moveAsWallGesture(g)),
    write: (g, v, ctx) => ({ ...withBase(g, ctx), angle: v }),
  },
];

function hint(g: ElementMoveGesture) {
  if (!g.selection) return 'moveRotate.noSelection' as const;
  if (g.selection.refusal) return 'moveRotate.refused' as const;
  return g.base ? 'moveRotate.move.hintTarget' as const : 'moveRotate.move.hintBase' as const;
}

export const ELEMENT_MOVE: ModelingCommand<ElementMoveGesture> = {
  id: 'element.move',
  labelKey: 'moveRotate.move.label',
  hud: { Scene: ElementMoveScene, Plan: ElementMovePlan, hint },
  fields: FIELDS,
  snap: 'modeling',
  init,
  snapQuery: (g) => ({
    anchor: g.base,
    chain: g.base ? [g.base] : [],
    locks: { ...(g.distance !== null ? { length: g.distance } : {}), ...(g.angle !== null ? { angleDeg: g.angle } : {}) },
  }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local }),
  pointerDown(g, s) {
    if (!g.selection || g.selection.refusal) return { commit: true }; // says why, through `validate`
    if (!g.base) return { ...g, base: s.local, cursor: s.local };
    return { commit: true };
  },
  // The first click of a double-click already set the point.
  doubleClick: (g) => g,
  undoPoint: (g) => ({ ...g, base: null, distance: null, angle: null }),
  validate(g, ctx) {
    if (!g.selection) return { ok: false, reasonKey: 'moveRotate.noSelection' };
    if (g.selection.refusal) return { ok: false, reasonKey: 'moveRotate.refused' };
    if (!ctx.workplane) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    const length = currentLength(moveAsWallGesture(g));
    return g.base && length !== null && length >= MIN_MOVE ? { ok: true } : { ok: false, reasonKey: 'moveRotate.move.hintTarget' };
  },
  commit(g, tx) {
    const move = tx.workplane ? op(g, tx.workplane) : null;
    if (!g.selection || !move) throw new Error('Nothing to move');
    return commitElementTransform(tx, g.selection.modelId, g.selection.ids, move);
  },
  afterCommit: () => ({ exit: true }),
  ghost(g, ctx) {
    const move = ctx.workplane ? op(g, ctx.workplane) : null;
    if (!g.selection || !move || !ctx.workplane) return [];
    return transformedGhosts(ctx.get(), g.selection, move, ctx.workplane.plane.normal, commandGhostId(ctx.get()));
  },
};
