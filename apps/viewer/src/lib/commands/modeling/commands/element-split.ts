/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.split` (charter #6232, WP2): cut the selected element.
 *
 *   - wall / beam / column / member: the cursor is projected onto the
 *     element's axis; a click (or a typed distance) cuts there;
 *   - slab / roof / plate / space: the first click latches an anchor, the
 *     second commits the cut line anchor → cursor.
 *
 * The target is the selection when the command starts, and again after each
 * cut (the cut selects the half it lands on), so cuts can be chained. It may
 * sit in another federated model than the session's; the cut is written,
 * selected and re-meshed in the target's own model. The
 * cursor reaches the element's storey through that storey's own workplane,
 * not the session's: a slab on storey 3 is cut on storey 3's floor.
 *
 * Which elements split, and how, is the ONE predicate the Properties panel's
 * Split button shares (`readSplitTarget`, `lib/split-target.ts`, #6233): a
 * refused target keeps the command running with the reason as its hint, and
 * a click reports that same reason.
 */

import { toast } from '@/components/ui/toast';
import type { TranslationKey } from '@/i18n';
import { resolve as translate } from '@/i18n/registry';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { notifySplitCommitted } from '@/components/viewer/wallSplitNotice';
import { SplitScene } from '@/components/viewer/tools/SplitHud';
import { pointInPolygon, type Point2D } from '@/lib/polygon-clip';
import { shortcutLabel } from '@/lib/commands/shortcut-label';
import type { Vec2 } from '@/lib/snap/types';
import { joinedPartnersOf } from '@/store/slices/mutation-wall-joins';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '../workplane.js';
import type { CommandContext, CommitResult, ModelingCommand, Vec3, Workplane } from '../types.js';

export interface SplitHover {
  /** Cut point in render space. */
  render: Vec3;
  /** A render-space point one metre along the element axis from the cut. */
  axisAhead: Vec3;
  distance: number;
  length: number;
}

export interface SplitGesture {
  target: { modelId: string; expressId: number } | null;
  /** How the target splits (`readSplitTarget`), or why it cannot. */
  kind: 'wall' | 'linear' | 'slab' | null;
  refusal: TranslationKey | null;
  /** The target's storey workplane; null when it has none we trust. */
  plane: Workplane | null;
  /** Slab-like targets: storey-local outline; null for linear ones. */
  footprint: Point2D[] | null;
  hover: SplitHover | null;
  /** Slab cut: first click and live cursor, storey-local. */
  anchor: Vec2 | null;
  cursor: Vec2 | null;
  /** A distance typed at the cursor, metres from the element start. */
  typed: number | null;
}

function targetPlane(ctx: CommandContext, modelId: string, expressId: number): Workplane | null {
  const s = ctx.get();
  const storeyId = elementStoreyId(s, modelId, expressId);
  if (storeyId === null) return null;
  const plane = buildStoreyWorkplane(s, modelId, storeyId, 0);
  return isWorkplane(plane) ? plane : null;
}

function init(ctx: CommandContext): SplitGesture {
  // From the selected id, not `selectedEntity`: that is synced from the id
  // by a hook AFTER render, so right after a cut it still names the source.
  const selectedId = ctx.get().selectedEntityId;
  const empty: SplitGesture = {
    target: null, kind: null, refusal: null, plane: null, footprint: null, hover: null, anchor: null, cursor: null, typed: null,
  };
  if (selectedId === null) return empty;
  const { modelId, expressId } = resolveEntityRef(selectedId);
  if (!ctx.get().models.has(modelId)) return empty;
  const verdict = ctx.get().readSplitTarget(modelId, expressId);
  if (!verdict.ok) return { ...empty, target: { modelId, expressId }, refusal: verdict.reasonKey };
  return {
    ...empty,
    target: { modelId, expressId },
    kind: verdict.kind,
    plane: targetPlane(ctx, modelId, expressId),
    footprint: verdict.kind === 'slab' ? ctx.get().readSlabFootprint(modelId, expressId)?.footprint ?? null : null,
  };
}

function pointerMove(g: SplitGesture, s: { render?: Vec3 }, ctx: CommandContext): SplitGesture {
  // A moved cursor supersedes a typed distance that was never committed.
  g = g.typed === null ? g : { ...g, typed: null };
  if (!g.target || !g.kind || !g.plane || !s.render) return { ...g, hover: null };
  const local = g.plane.renderToLocal(s.render);
  if (g.footprint) return { ...g, cursor: [local[0], local[1]] };
  const { modelId, expressId } = g.target;
  const state = ctx.get();
  // Local z is the height above the storey floor: a wall projects in plan,
  // a column's vertical axis needs the cursor height (#6233).
  const projection = g.kind === 'wall'
    ? state.readWallSplitProjection(modelId, expressId, [local[0], local[1], 0])
    : state.readLinearElementSplitProjection(modelId, expressId, [local[0], local[1], local[2]]);
  if (!projection) return { ...g, hover: null };
  const [x, y, z] = projection.cutPoint;
  const [ax, ay, az] = projection.axis;
  return {
    ...g,
    hover: {
      render: g.plane.localToRender([x, y, z]),
      axisAhead: g.plane.localToRender([x + ax, y + ay, z + az]),
      distance: projection.distance,
      length: projection.length,
    },
  };
}

function commitSlab(g: SplitGesture & { target: NonNullable<SplitGesture['target']> }, store: CommandContext['get']): CommitResult {
  const { modelId, expressId } = g.target;
  const result = store().splitSlabByLine(modelId, expressId, [g.anchor![0], g.anchor![1]], [g.cursor![0], g.cursor![1]]);
  if (!result.ok) throw new Error(translate('splitTool.failed', { reason: result.reason }));
  // Select whichever half the second click landed in.
  const right = store().readSlabFootprint(modelId, result.right.expressId);
  const inRight = right ? pointInPolygon(right.footprint, [g.cursor![0], g.cursor![1]]) : false;
  toast.success(`Slab split — ${shortcutLabel('edit.undo')} to undo`);
  return splitCommit(modelId, expressId, result, inRight ? result.right.expressId : result.left.expressId);
}

/**
 * The split identity policy (#6233, `lib/split-guid.ts`): the larger piece
 * IS the source, reshaped in place, and exactly one element is created. Both
 * are re-meshed through the wasm service, and again on undo / redo of this
 * transaction's batch; nothing is deleted.
 */
function splitCommit(
  modelId: string,
  source: number,
  pieces: { left: { expressId: number }; right: { expressId: number } },
  select: number,
): CommitResult {
  const created = pieces.left.expressId === source ? pieces.right.expressId : pieces.left.expressId;
  return { modelId, created: [created], deleted: [], remesh: [source, created], select: [select] };
}

function commitLinear(g: SplitGesture & { target: NonNullable<SplitGesture['target']> }, store: CommandContext['get']): CommitResult {
  const { modelId, expressId } = g.target;
  const distance = g.typed ?? g.hover!.distance;
  if (g.kind === 'wall') {
    const wall = store().splitWallAtDistance(modelId, expressId, distance);
    if (!wall.ok) throw new Error(translate('splitTool.failed', { reason: wall.reason }));
    notifySplitCommitted(wall);
    const result = splitCommit(modelId, expressId, wall, wall.right.expressId);
    // The walls joined to either piece were cut again against it.
    const recut = joinedPartnersOf(store(), modelId, [wall.left.expressId, wall.right.expressId]);
    return { ...result, remesh: [...result.remesh, ...recut] };
  }
  const linear = store().splitLinearElementAtDistance(modelId, expressId, distance);
  if (!linear.ok) throw new Error(translate('splitTool.failed', { reason: linear.reason }));
  notifySplitCommitted(linear);
  return splitCommit(modelId, expressId, linear, linear.right.expressId);
}

export const ELEMENT_SPLIT: ModelingCommand<SplitGesture> = {
  id: 'element.split',
  labelKey: 'splitTool.barLabel',
  hud: { Scene: SplitScene, hint: (g) => g.refusal ?? (g.target ? 'splitTool.hint' : 'modelingCommand.split.noTarget') },
  snap: 'modeling',
  init,
  pointerMove,
  pointerDown(g) {
    if (!g.target) return g;
    // A click on an element that cannot split says why (through `validate`).
    if (g.refusal) return { commit: true };
    if (g.footprint) {
      if (!g.cursor) return g;
      return g.anchor ? { commit: true } : { ...g, anchor: g.cursor };
    }
    return g.hover ? { commit: true } : g;
  },
  validate(g) {
    if (!g.target) return { ok: false, reasonKey: 'modelingCommand.split.noTarget' };
    if (g.refusal) return { ok: false, reasonKey: g.refusal };
    if (!g.plane) return { ok: false, reasonKey: 'modelingCommand.split.noPlane' };
    if (g.footprint) return g.anchor && g.cursor ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.split.needLine' };
    const length = g.hover?.length ?? 0;
    const distance = g.typed ?? g.hover?.distance ?? null;
    return distance !== null && distance > 0 && distance < length
      ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.split.outOfRange' };
  },
  commit(g, tx) {
    const target = g.target;
    if (!target) throw new Error('Nothing selected to split');
    const store = () => tx.store;
    return g.footprint ? commitSlab({ ...g, target }, store) : commitLinear({ ...g, target }, store);
  },
};
