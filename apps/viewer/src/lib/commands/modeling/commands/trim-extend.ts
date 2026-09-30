/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.trimExtend` (charter #6232, C1): Autodesk-style Trim/Extend.
 *
 *   1. Pick the boundary: a wall or beam (its axis), a slab edge, or a guide
 *      line the snap solver holds (a grid axis, any edge).
 *   2. Click walls and beams. The mode decides what a click means: TRIM cuts
 *      the element back to the boundary, removing the side you clicked;
 *      EXTEND lengthens the end nearest the click to reach it. The bar's
 *      switch sets the mode; holding Shift flips it for a click.
 *
 * A wall meeting a boundary wall is joined to it through the join core: a T
 * where it ends on the wall's path, an L at a corner, with its
 * `IfcRelConnectsPathElements`, one transaction, one undo step. A trim that
 * would cut through an opening, door or window hosted in the wall is refused
 * with the count; a wall the join core cannot read (a mesh or polygon body) is
 * refused with the reason the Split button gives for it. Beams and members
 * are trimmed and extended along their axis.
 *
 * The boundary stays after each commit, so one boundary can take many clicks;
 * Backspace picks another, Esc starts over, and Esc again leaves. The ghost
 * previews the result; a refused target is outlined red with its reason.
 * Session model only: a boundary or target in another federated model is
 * never offered.
 */

import { TrimExtendBar } from '@/components/viewer/tools/command/TrimExtendBar';
import { TrimExtendPlanLayer } from '@/components/viewer/plan/TrimExtendPlanLayer';
import { TrimExtendScene } from '@/components/viewer/tools/command/TrimExtendScene';
import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import type { SnapProfile } from '@/lib/snap/types';
import { commandGhostId } from '../ghost.js';
import type { CommandContext, ModelingCommand } from '../types.js';
import { notifyCommandRefusal } from '../runtime.js';
import { isWorkplane } from '../workplane.js';
import { commitTrimExtend } from './trim-extend-commit.js';
import type { ReachMode } from './trim-extend-geometry.js';
import {
  EMPTY_MODEL, boundaryOfTarget, pickBoundary, pickSlack, pickTarget, prepareModel,
  type Boundary, type TrimExtendModel,
} from './trim-extend-model.js';
import { previewFor, previewGhost, type TrimExtendPreview } from './trim-extend-plan.js';
import type { Vec2 } from '@/lib/snap/types';

export interface TrimExtendGesture {
  /** What a click does, as the bar's switch says. Shift flips it for one click. */
  readonly mode: ReachMode;
  /** Shift is held at the last pointer event. */
  readonly shift: boolean;
  /** The storey's walls and beams and slab edges, read when the gesture began and again whenever the model changed (a commit, an undo, a collaborator). */
  readonly model: TrimExtendModel;
  /** `mutationVersion` the model was read at. */
  readonly version: number;
  readonly boundary: Boundary | null;
  /** While picking the boundary: what a click would take. */
  readonly hover: Boundary | null;
  /** While picking targets: what a click would do to the element under the cursor. */
  readonly preview: TrimExtendPreview | null;
  /** The cursor, storey-local: where along an element it was clicked. */
  readonly cursor: Vec2 | null;
}

/**
 * The cursor only snaps to EDGES (kind `edge`, sources of the modeling
 * profile): a boundary needs the guide line of one, and an element is picked
 * by where the cursor really is, so points of other elements must not pull it.
 */
export const TRIM_EXTEND_SNAP: SnapProfile = { ...MODELING_SNAP_PROFILE, tiers: [['edge']] };

export const effectiveMode = (g: Pick<TrimExtendGesture, 'mode' | 'shift'>): ReachMode =>
  (g.shift ? (g.mode === 'trim' ? 'extend' : 'trim') : g.mode);

function freshModel(ctx: Pick<CommandContext, 'get' | 'modelId' | 'storeyId' | 'workplane'>): TrimExtendModel {
  const { workplane, storeyId } = ctx;
  if (!workplane || storeyId === null || !isWorkplane(workplane)) return EMPTY_MODEL;
  return prepareModel(ctx.get(), ctx.modelId, storeyId, workplane);
}

const init = (ctx: CommandContext): TrimExtendGesture => ({
  mode: 'trim', shift: false, model: freshModel(ctx), version: ctx.get().mutationVersion, boundary: null, hover: null, preview: null, cursor: null,
});

/** The gesture on the model as it is now: an undo or an edit from elsewhere leaves the reads stale. */
function synced(g: TrimExtendGesture, ctx: CommandContext): TrimExtendGesture {
  const version = ctx.get().mutationVersion;
  if (version === g.version) return g;
  const model = freshModel(ctx);
  return { ...g, model, version, boundary: refreshBoundary(g.boundary, model), hover: null, preview: null };
}

function pointerMove(gesture: TrimExtendGesture, s: Parameters<NonNullable<ModelingCommand['pointerMove']>>[1], ctx: CommandContext): TrimExtendGesture {
  const g = synced(gesture, ctx);
  const next = { ...g, shift: s.modifiers?.shift ?? false, cursor: s.local };
  if (!g.boundary) return { ...next, hover: pickBoundary(g.model, s), preview: null };
  const target = pickTarget(g.model, s.local, pickSlack(s), g.boundary.ref);
  return { ...next, hover: null, preview: target ? previewFor(ctx.get(), target, g.boundary, effectiveMode(next), s.local) : null };
}

/** The boundary again from the live model (an element boundary may have been re-cut by the commit). */
function refreshBoundary(boundary: Boundary | null, model: TrimExtendModel): Boundary | null {
  if (!boundary?.ref) return boundary;
  const { modelId, expressId } = boundary.ref;
  const target = model.targets.find((t) => t.modelId === modelId && t.expressId === expressId);
  return target ? boundaryOfTarget(target) : null;
}

export const ELEMENT_TRIM_EXTEND: ModelingCommand<TrimExtendGesture> = {
  id: 'element.trimExtend',
  labelKey: 'trimExtend.label',
  hud: {
    Bar: TrimExtendBar,
    Scene: TrimExtendScene,
    Plan: TrimExtendPlanLayer,
    hint: (g) => {
      if (g.model.targets.length === 0) return 'trimExtend.noTargets';
      if (!g.boundary) return 'trimExtend.hint.boundary';
      return effectiveMode(g) === 'trim' ? 'trimExtend.hint.trim' : 'trimExtend.hint.extend';
    },
  },
  snap: TRIM_EXTEND_SNAP,
  init,
  pointerMove,
  pointerDown(g) {
    if (!g.boundary) return g.hover ? { ...g, boundary: g.hover, hover: null, preview: null } : g;
    if (!g.preview) return g;
    // A refusal is said, not committed: nothing to write, nothing to revert.
    if (!g.preview.ok) {
      notifyCommandRefusal(g.preview.reason);
      return g;
    }
    return { commit: true };
  },
  // Backspace: pick another boundary.
  undoPoint: (g) => ({ ...g, boundary: null, hover: null, preview: null }),
  validate(g) {
    if (g.model.targets.length === 0) return { ok: false, reasonKey: 'trimExtend.noTargets' };
    if (!g.boundary) return { ok: false, reasonKey: 'trimExtend.needBoundary' };
    if (!g.preview) return { ok: false, reasonKey: 'trimExtend.needTarget' };
    // The reason itself is beside the element in the scene and the plan, and said by a click on it.
    return g.preview.ok ? { ok: true } : { ok: false, reasonKey: 'trimExtend.refusedHere' };
  },
  commit(g, tx) {
    const preview = g.preview, boundary = g.boundary;
    if (!preview || !boundary) throw new Error('Nothing to trim or extend');
    // What the model is NOW: the gesture's reads are from when it began or the last commit.
    const model = tx.workplane && tx.storeyId !== null ? prepareModel(tx.store, tx.modelId, tx.storeyId, tx.workplane) : EMPTY_MODEL;
    const { modelId, expressId } = preview.target;
    const target = model.targets.find((t) => t.modelId === modelId && t.expressId === expressId);
    const live = refreshBoundary(boundary, model);
    if (!target || !live) throw new Error('The element or its boundary is no longer there');
    const again = previewFor(tx.store, target, live, effectiveMode(g), g.cursor ?? [0, 0]);
    if (!again.ok) throw new Error(again.reason);
    return commitTrimExtend(tx, target, live, again);
  },
  afterCommit(g, _result, ctx) {
    const model = freshModel(ctx);
    return { ...g, model, version: ctx.get().mutationVersion, boundary: refreshBoundary(g.boundary, model), hover: null, preview: null };
  },
  ghost(g, ctx) {
    const { preview } = g;
    if (!preview || !ctx.workplane) return [];
    const mesh = previewGhost(preview, ctx.workplane, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
