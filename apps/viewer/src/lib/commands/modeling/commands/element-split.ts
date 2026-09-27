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
 * cut (the cut selects the half it lands on), so cuts can be chained. The
 * cursor reaches the element's storey through that storey's own workplane,
 * not the session's: a slab on storey 3 is cut on storey 3's floor.
 */

import { toast } from '@/components/ui/toast';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { notifyWallSplit } from '@/components/viewer/wallSplitNotice';
import { SplitScene } from '@/components/viewer/tools/SplitHud';
import { pointInPolygon, type Point2D } from '@/lib/polygon-clip';
import { shortcutLabel } from '@/lib/commands/shortcut-label';
import type { Vec2, Vec3 } from '@/lib/snap/types';
import { buildStoreyWorkplane, isWorkplane } from '../workplane.js';
import type { CommandContext, CommitResult, ModelingCommand, Workplane } from '../types.js';

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
  const storeyId = s.models.get(modelId)?.ifcDataStore?.spatialHierarchy?.elementToStorey.get(expressId);
  if (storeyId === undefined) return null;
  const plane = buildStoreyWorkplane(s, modelId, storeyId, 0);
  return isWorkplane(plane) ? plane : null;
}

function init(ctx: CommandContext): SplitGesture {
  // From the selected id, not `selectedEntity`: that is synced from the id
  // by a hook AFTER render, so right after a cut it still names the source.
  const selectedId = ctx.get().selectedEntityId;
  const empty: SplitGesture = { target: null, plane: null, footprint: null, hover: null, anchor: null, cursor: null, typed: null };
  if (selectedId === null) return empty;
  const { modelId, expressId } = resolveEntityRef(selectedId);
  if (!ctx.get().models.has(modelId)) return empty;
  return {
    ...empty,
    target: { modelId, expressId },
    plane: targetPlane(ctx, modelId, expressId),
    footprint: ctx.get().readSlabFootprint(modelId, expressId)?.footprint ?? null,
  };
}

function pointerMove(g: SplitGesture, s: { render?: Vec3 }, ctx: CommandContext): SplitGesture {
  // A moved cursor supersedes a typed distance that was never committed.
  g = g.typed === null ? g : { ...g, typed: null };
  if (!g.target || !g.plane || !s.render) return { ...g, hover: null };
  const local = g.plane.renderToLocal(s.render);
  if (g.footprint) return { ...g, cursor: [local[0], local[1]] };
  const cursor: [number, number, number] = [local[0], local[1], 0];
  const state = ctx.get();
  const projection = state.readWallSplitProjection(g.target.modelId, g.target.expressId, cursor)
    ?? state.readLinearElementSplitProjection(g.target.modelId, g.target.expressId, cursor);
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
  if (!result.ok) throw new Error(`Couldn't split slab: ${result.reason}`);
  // Select whichever half the second click landed in.
  const right = store().readSlabFootprint(modelId, result.right.expressId);
  const inRight = right ? pointInPolygon(right.footprint, [g.cursor![0], g.cursor![1]]) : false;
  toast.success(`Slab split — ${shortcutLabel('edit.undo')} to undo`);
  const created = [result.left.expressId, result.right.expressId];
  return { created, deleted: [expressId], remesh: created, select: [inRight ? result.right.expressId : result.left.expressId] };
}

function commitLinear(g: SplitGesture & { target: NonNullable<SplitGesture['target']> }, store: CommandContext['get']): CommitResult {
  const { modelId, expressId } = g.target;
  const distance = g.typed ?? g.hover!.distance;
  const wall = store().splitWallAtDistance(modelId, expressId, distance);
  if (wall.ok) {
    notifyWallSplit(wall.openings);
    const created = [wall.left.expressId, wall.right.expressId];
    return { created, deleted: [expressId], remesh: created, select: [wall.right.expressId] };
  }
  const linear = store().splitLinearElementAtDistance(modelId, expressId, distance);
  if (!linear.ok) throw new Error(`Couldn't split: ${linear.reason}`);
  toast.success(`Element split — ${shortcutLabel('edit.undo')} to undo`);
  return { created: [linear.right.expressId], deleted: [], remesh: [expressId, linear.right.expressId], select: [linear.right.expressId] };
}

export const ELEMENT_SPLIT: ModelingCommand<SplitGesture> = {
  id: 'element.split',
  labelKey: 'splitTool.barLabel',
  hud: { Scene: SplitScene, hint: (g) => (g.target ? 'splitTool.hint' : 'modelingCommand.split.noTarget') },
  snap: 'modeling',
  init,
  pointerMove,
  pointerDown(g) {
    if (!g.target) return g;
    if (g.footprint) {
      if (!g.cursor) return g;
      return g.anchor ? { commit: true } : { ...g, anchor: g.cursor };
    }
    return g.hover ? { commit: true } : g;
  },
  validate(g) {
    if (!g.target) return { ok: false, reasonKey: 'modelingCommand.split.noTarget' };
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
