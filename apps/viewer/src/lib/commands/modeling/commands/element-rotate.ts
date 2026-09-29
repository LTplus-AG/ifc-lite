/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.rotate` (charter #6232, C2): turn the selection about a vertical
 * axis through a pivot, with a ring drawn round it in 3D and in the plan.
 *
 * The pivot is the selection's centre; P (or the bar's Pivot button) makes the
 * next click pick another one, snapped. A first click on the ring sets the
 * start ray, the cursor then turns the selection — in 15° steps unless Alt is
 * held or snapping is off — and a second click commits. A typed Angle commits
 * with Enter, no clicks needed. Hosted openings and fillings turn with their
 * host. ONE transaction, one undo step; the command then ends.
 */

import { ElementRotateBar, ElementRotatePlan, ElementRotateScene } from '@/components/viewer/tools/command/ElementRotateLayers';
import { commitElementTransform } from '@/lib/element-transform/commit';
import { commandGhostId } from '../ghost.js';
import { readTransformSelection, selectionExtent, transformedGhosts } from './element-transform-shared.js';
import { directionDeg, rotationDeg, togglePivotPick, type ElementRotateGesture } from './element-rotate-geometry.js';
import type { CommandContext, CommandField, ModelingCommand, Workplane } from '../types.js';

/** The smallest ring, metres: a column's ring must still be grabbable. */
const MIN_RADIUS = 0.6;

function init(ctx: CommandContext): ElementRotateGesture {
  const s = ctx.get();
  const selection = readTransformSelection(s);
  const extent = selection && ctx.workplane ? selectionExtent(s, selection, ctx.workplane) : null;
  return {
    selection,
    pivot: extent?.centre ?? null,
    radius: Math.max(MIN_RADIUS, (extent?.radius ?? 0) * 1.15),
    pickingPivot: false,
    start: null,
    cursor: null,
    snapAngle: s.snapEnabled,
    typed: null,
  };
}

function op(g: ElementRotateGesture, plane: Workplane) {
  const deg = rotationDeg(g);
  if (!g.pivot || deg === null) return null;
  return { kind: 'rotate' as const, pivot: plane.localToRender([g.pivot[0], g.pivot[1], 0]), angle: (deg * Math.PI) / 180 };
}

const FIELDS: readonly CommandField<ElementRotateGesture>[] = [
  {
    id: 'angle', labelKey: 'moveRotate.field.angle', unit: 'deg', group: 'rotate',
    read: rotationDeg,
    write: (g, v) => ({ ...g, typed: v }),
  },
];

function hint(g: ElementRotateGesture) {
  if (!g.selection) return 'moveRotate.noSelection' as const;
  if (g.selection.refusal) return 'moveRotate.refused' as const;
  if (g.pickingPivot) return 'moveRotate.rotate.hintPivot' as const;
  return g.start === null ? 'moveRotate.rotate.hintStart' as const : 'moveRotate.rotate.hintAngle' as const;
}

export const ELEMENT_ROTATE: ModelingCommand<ElementRotateGesture> = {
  id: 'element.rotate',
  labelKey: 'moveRotate.rotate.label',
  hud: { Bar: ElementRotateBar, Scene: ElementRotateScene, Plan: ElementRotatePlan, hint },
  fields: FIELDS,
  snap: 'modeling',
  keys: [{ commandKey: 'command.element.rotate.pivot', run: togglePivotPick }],
  init,
  snapQuery: (g) => ({ anchor: g.pickingPivot ? null : g.pivot, chain: [], locks: {} }),
  pointerMove: (g, s, ctx) => ({ ...g, cursor: s.local, snapAngle: ctx.get().snapEnabled && !s.modifiers?.alt }),
  pointerDown(g, s) {
    if (!g.selection || g.selection.refusal) return { commit: true }; // says why, through `validate`
    if (g.pickingPivot || !g.pivot) return { ...g, pivot: s.local, pickingPivot: false, start: null, typed: null };
    if (g.start === null) {
      const start = directionDeg(g.pivot, s.local);
      return start === null ? g : { ...g, start, cursor: s.local, typed: null };
    }
    return { commit: true };
  },
  doubleClick: (g) => g,
  undoPoint: (g) => ({ ...g, start: null, typed: null }),
  validate(g, ctx) {
    if (!g.selection) return { ok: false, reasonKey: 'moveRotate.noSelection' };
    if (g.selection.refusal) return { ok: false, reasonKey: 'moveRotate.refused' };
    if (!ctx.workplane || !g.pivot) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    const deg = rotationDeg(g);
    return deg !== null && Math.abs(deg) > 1e-6 ? { ok: true } : { ok: false, reasonKey: 'moveRotate.rotate.hintAngle' };
  },
  commit(g, tx) {
    const turn = tx.workplane ? op(g, tx.workplane) : null;
    if (!g.selection || !turn) throw new Error('Nothing to turn');
    return commitElementTransform(tx, g.selection.modelId, g.selection.ids, turn);
  },
  afterCommit: () => ({ exit: true }),
  ghost(g, ctx) {
    const turn = ctx.workplane ? op(g, ctx.workplane) : null;
    if (!g.selection || !turn || !ctx.workplane) return [];
    return transformedGhosts(ctx.get(), g.selection, turn, ctx.workplane.plane.normal, commandGhostId(ctx.get()));
  },
};
