/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `split.multi` (charter #6232, C5; decision D6): one cut line, every element
 * it crosses split, in ONE undo step.
 *
 * Two clicks (snapped, in the plan or in 3D) give a vertical cut plane. The
 * targets are the selection, or with nothing selected every wall, beam and
 * slab of the active storey. Each crossed target is split by the existing
 * `element.split` store actions (`splitWallAtDistance`,
 * `splitLinearElementAtDistance`, `splitSlabByLine`), composed inside the one
 * `runTransaction` a commit is: the split identity policy (the larger piece
 * keeps the identity, the new piece a derived GlobalId, `lib/split-guid.ts`)
 * and the hosted-opening reassignment (`lib/wall-opening-reassign.ts`) are
 * theirs, so a window follows the wall piece it stands in. A target the plane
 * crosses but the split predicate refuses (a tilted extrusion, a mesh body…)
 * is reported with its reason and never touched. If a split that was planned
 * fails while committing, the whole commit is reverted.
 *
 * The cut is a plane, not a segment: like `element.split` on a slab, the two
 * points fix the line and it runs on through everything.
 */

import { toast } from '@/components/ui/toast';
import { MultiSplitBar } from '@/components/viewer/tools/command/MultiSplitBar';
import { MultiSplitPlanLayer } from '@/components/viewer/plan/MultiSplitPlanLayer';
import { MultiSplitScene } from '@/components/viewer/tools/command/MultiSplitScene';
import { resolve as translate } from '@/i18n/registry';
import type { ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { shortcutLabel } from '@/lib/commands/shortcut-label';
import type { Vec2 } from '@/lib/snap/types';
import { commandGhostId, wallGhostMesh } from '../ghost.js';
import type { AuthoringTransaction, CommandContext, CommitResult, ModelingCommand, Vec3 } from '../types.js';
import {
  EMPTY_PLAN, evaluateCut, prepareTargets, storeyCandidates,
  type MultiSplitPlan, type MultiSplitTarget, type PlannedSplit, type TargetRef,
} from './multi-split-plan.js';

export interface MultiSplitGesture {
  /** Whose elements the cut takes: the selection, or the active storey's walls, beams and slabs. */
  readonly mode: 'selection' | 'storey';
  readonly refs: readonly TargetRef[];
  readonly targets: readonly MultiSplitTarget[];
  /** The cut line's two points, workplane-local. `b` follows the cursor until the second click. */
  readonly a: Vec2 | null;
  readonly b: Vec2 | null;
  readonly plan: MultiSplitPlan;
}

/** The cut plane's ghost is this tall, metres: a storey's worth, whatever it cuts. */
const GHOST_HEIGHT = 3;
const GHOST_THICKNESS = 0.03;
/** How far the drawn cut runs past the outermost target it crosses, metres. */
const EXTENT_MARGIN = 1;
/** A line shorter than this is a click, not a cut, metres. */
const MIN_LINE = 0.01;

function selectedRefs(ctx: CommandContext): TargetRef[] {
  const s = ctx.get();
  const ids = new Set(s.selectedEntityIds);
  if (s.selectedEntityId !== null) ids.add(s.selectedEntityId);
  const seen = new Set<string>();
  const refs: TargetRef[] = [];
  for (const id of ids) {
    const { modelId, expressId } = resolveEntityRef(id);
    if (!s.models.has(modelId) || seen.has(`${modelId}:${expressId}`)) continue;
    seen.add(`${modelId}:${expressId}`);
    refs.push({ modelId, expressId });
  }
  return refs;
}

function storeyRefs(ctx: CommandContext): TargetRef[] {
  if (ctx.storeyId === null) return [];
  return storeyCandidates(ctx.get(), ctx.modelId, ctx.storeyId).map((expressId) => ({ modelId: ctx.modelId, expressId }));
}

const render = (ctx: Pick<CommandContext, 'workplane'>, p: Vec2): Vec3 | null => ctx.workplane?.localToRender([p[0], p[1], 0]) ?? null;

function evaluate(g: MultiSplitGesture, ctx: Pick<CommandContext, 'workplane'>): MultiSplitPlan {
  const a = g.a && render(ctx, g.a);
  const b = g.b && render(ctx, g.b);
  return a && b ? evaluateCut(g.targets, a, b) : EMPTY_PLAN;
}

/**
 * The stretch of the cut line to draw, workplane-local: from a margin before
 * the first thing it crosses to a margin past the last (just the two points
 * when it crosses nothing).
 */
export function cutExtent(g: MultiSplitGesture, ctx: Pick<CommandContext, 'workplane'>): [Vec2, Vec2] | null {
  const plane = ctx.workplane;
  if (!plane || !g.a || !g.b) return null;
  const length = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
  if (length < MIN_LINE) return null;
  const dir: Vec2 = [(g.b[0] - g.a[0]) / length, (g.b[1] - g.a[1]) / length];
  let lo = 0, hi = length;
  for (const mark of g.plan.marks) {
    for (const point of mark.outline) {
      const local = plane.renderToLocal(point);
      const t = (local[0] - g.a[0]) * dir[0] + (local[1] - g.a[1]) * dir[1];
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
  }
  const at = (t: number): Vec2 => [g.a![0] + dir[0] * t, g.a![1] + dir[1] * t];
  return [at(lo - EXTENT_MARGIN), at(hi + EXTENT_MARGIN)];
}

function gestureFor(ctx: CommandContext, mode: MultiSplitGesture['mode']): MultiSplitGesture {
  const refs = mode === 'selection' ? selectedRefs(ctx) : storeyRefs(ctx);
  return { mode, refs, targets: prepareTargets(ctx.get(), refs, mode === 'selection', ctx.modelId), a: null, b: null, plan: EMPTY_PLAN };
}

/** The selection when there is one, otherwise the active storey's walls, beams and slabs. */
const init = (ctx: CommandContext): MultiSplitGesture => gestureFor(ctx, selectedRefs(ctx).length > 0 ? 'selection' : 'storey');

function summarise(splits: number, refused: number, skippedOpenings: number): void {
  toast.success(`${translate('multiSplit.done', { count: splits, countDisplay: String(splits) })} — ${shortcutLabel('edit.undo')}`);
  if (refused > 0) toast.info(translate('multiSplit.leftAlone', { count: refused, countDisplay: String(refused) }));
  if (skippedOpenings > 0) toast.info(translate('multiSplit.openingsSkipped', { count: skippedOpenings, countDisplay: String(skippedOpenings) }));
}

type Cut = { ok: true; left: { expressId: number }; right: { expressId: number }; skippedOpenings: number } | { ok: false; reason: string };

/** One planned split, through the store action the Split button shares. */
function cutOne(store: ViewerState, { modelId, expressId, op }: PlannedSplit): Cut {
  if (op.kind === 'wall') {
    const wall = store.splitWallAtDistance(modelId, expressId, op.distance);
    return wall.ok ? { ...wall, skippedOpenings: wall.openings.skipped } : wall;
  }
  const other = op.kind === 'linear'
    ? store.splitLinearElementAtDistance(modelId, expressId, op.distance)
    : store.splitSlabByLine(modelId, expressId, op.a, op.b);
  return other.ok ? { ...other, skippedOpenings: 0 } : other;
}

function commit(g: MultiSplitGesture, tx: AuthoringTransaction): CommitResult {
  if (!tx.workplane) throw new Error(translate('modelingCommand.noPlane'));
  // What the line crosses NOW: the gesture's reads are from when it started.
  const fresh = { ...g, targets: prepareTargets(tx.store, g.refs, g.mode === 'selection', tx.modelId) };
  const plan = evaluate(fresh, tx);
  if (plan.splits.length === 0) throw new Error(translate('multiSplit.crossesNothing'));

  const created: number[] = [];
  const remesh = new Set<number>();
  const select = new Set<number>();
  let skippedOpenings = 0;
  for (const split of plan.splits) {
    const { expressId } = split;
    const result = cutOne(tx.store, split);
    // Refused after planning: reverting the commit is the atomic answer, never half a cut.
    if (!result.ok) throw new Error(translate('splitTool.failed', { reason: `${split.label}: ${result.reason}` }));
    skippedOpenings += result.skippedOpenings;
    // The larger piece IS the source (`lib/split-guid.ts`); exactly one element is new.
    const added = result.left.expressId === expressId ? result.right.expressId : result.left.expressId;
    created.push(added);
    remesh.add(expressId).add(added);
    select.add(expressId).add(added);
  }
  summarise(plan.splits.length, plan.refused.length, skippedOpenings);
  return { created, deleted: [], remesh: [...remesh], select: [...select] };
}

export const SPLIT_MULTI: ModelingCommand<MultiSplitGesture> = {
  id: 'split.multi',
  labelKey: 'multiSplit.label',
  hud: {
    Bar: MultiSplitBar,
    Scene: MultiSplitScene,
    Plan: MultiSplitPlanLayer,
    hint: (g) => (g.targets.length === 0 ? 'multiSplit.noTargets' : g.a === null ? 'multiSplit.hintStart' : 'multiSplit.hintEnd'),
  },
  snap: 'modeling',
  init,
  snapQuery: (g) => ({ anchor: g.a, chain: g.a ? [g.a] : [], locks: {} }),
  pointerMove(g, s, ctx) {
    if (!g.a) return g;
    const next = { ...g, b: s.local };
    return { ...next, plan: evaluate(next, ctx) };
  },
  pointerDown(g, s) {
    if (g.targets.length === 0) return g;
    return g.a ? { commit: true } : { ...g, a: s.local, b: s.local };
  },
  undoPoint: (g) => ({ ...g, a: null, b: null, plan: EMPTY_PLAN }),
  validate(g) {
    if (g.targets.length === 0) return { ok: false, reasonKey: 'multiSplit.noTargets' };
    if (!g.a || !g.b || Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) < MIN_LINE) return { ok: false, reasonKey: 'multiSplit.needLine' };
    if (g.plan.splits.length > 0) return { ok: true };
    return { ok: false, reasonKey: g.plan.refused.length > 0 ? 'multiSplit.nothingSplittable' : 'multiSplit.crossesNothing' };
  },
  commit,
  // A commit selects the pieces; a storey-wide cut stays storey-wide for the next line.
  afterCommit: (g, _result, ctx) => gestureFor(ctx, g.mode),
  ghost(g, ctx) {
    const extent = cutExtent(g, ctx);
    if (!ctx.workplane || !extent) return [];
    const mesh = wallGhostMesh(ctx.workplane, extent[0], extent[1], GHOST_THICKNESS, GHOST_HEIGHT, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
