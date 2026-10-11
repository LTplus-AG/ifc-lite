/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.align` (charter #6232, C4): line elements up on one edge of a
 * reference. Distinct from the wall tool's `wallAlign`, which is which side
 * of the drawn line a new wall sits on.
 *
 * Pick the reference (the first click, or the selection's primary element
 * when the command starts with several selected), then the targets (each
 * click toggles one; the rest of a multi-selection start as targets). The bar
 * chooses the edge: Left / Centre / Right along the workplane's u axis, Top /
 * Middle / Bottom along v. Enter (or a double-click) moves every target so
 * its chosen edge sits on the reference's: ONE transaction, so one undo puts
 * them all back, and each target re-meshes with what it hosts.
 *
 * The boxes are read once from the session storey's rendered meshes, in the
 * session workplane; targets must be on that storey.
 */

import { resolveEntityRef } from '@/store/resolveEntityRef';
import type { SnapProfile } from '@/lib/snap/types';
import { commitElementAlignment, planSelectionTransform } from '@/lib/element-transform/commit';
import { AlignBar } from '@/components/viewer/tools/command/AlignBar';
import { AlignPlan, AlignScene } from '@/components/viewer/tools/command/AlignLayers';
import { pickBox, storeyBoxes, type PlanBox } from '../align-boxes.js';
import { alignMoves, type AlignGesture } from '../align-gesture.js';
import { commandGhostId } from '../ghost.js';
import { alignmentGhosts } from '../align-ghosts';
import type { CommandContext, ModelingCommand } from '../types.js';

function init(ctx: CommandContext): AlignGesture {
  const s = ctx.get();
  const boxes = ctx.workplane && ctx.storeyId !== null ? storeyBoxes(s, ctx.modelId, ctx.storeyId, ctx.workplane) : new Map<number, PlanBox>();
  const selected = [...s.selectedEntityIds]
    .map((id) => resolveEntityRef(id))
    .filter((ref) => ref.modelId === ctx.modelId && boxes.has(ref.expressId))
    .map((ref) => ref.expressId);
  const primary = s.selectedEntityId === null ? null : resolveEntityRef(s.selectedEntityId);
  const reference = primary && primary.modelId === ctx.modelId && boxes.has(primary.expressId) ? primary.expressId : null;
  return withSelection({
    boxes,
    reference,
    targets: selected.filter((id) => id !== reference),
    mode: 'left',
    hover: null,
  }, ctx);
}

function withSelection(g: AlignGesture, ctx: CommandContext): AlignGesture {
  const plan = planSelectionTransform(ctx.get(), ctx.modelId, g.targets);
  return { ...g, carried: plan?.carried ?? [] };
}

/**
 * Align picks elements, it does not place points: with the modeling profile a
 * click near a wall's end or edge would snap onto that instead of the element
 * under the cursor. No sources, so the solved point is the cursor.
 */
export const ALIGN_PICK_PROFILE: SnapProfile = { radiusPx: 0, tiers: [], sources: [] };

export const ELEMENT_ALIGN: ModelingCommand<AlignGesture> = {
  id: 'element.align',
  labelKey: 'align.label',
  hud: {
    Bar: AlignBar,
    Scene: AlignScene,
    Plan: AlignPlan,
    hint: (g) => (g.reference === null ? 'align.hint.reference' : g.targets.length === 0 ? 'align.hint.targets' : 'align.hint.commit'),
  },
  snap: ALIGN_PICK_PROFILE,
  init,
  pointerMove: (g, s) => {
    const hover = pickBox(g.boxes, s.local);
    return hover === g.hover ? g : { ...g, hover };
  },
  pointerDown(g, s, ctx) {
    const id = pickBox(g.boxes, s.local);
    if (id === null) return g;
    if (g.reference === null) return withSelection({ ...g, reference: id, targets: g.targets.filter((t) => t !== id) }, ctx);
    // The reference again lets go of it, and of the targets that were chosen against it.
    if (id === g.reference) return withSelection({ ...g, reference: null, targets: [] }, ctx);
    return withSelection({ ...g, targets: g.targets.includes(id) ? g.targets.filter((t) => t !== id) : [...g.targets, id] }, ctx);
  },
  doubleClick: (g) => (alignMoves(g).length > 0 ? { commit: true } : g),
  validate(g, ctx) {
    if (!ctx.workplane) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    if (g.reference === null) return { ok: false, reasonKey: 'align.hint.reference' };
    if (g.targets.length === 0) return { ok: false, reasonKey: 'align.hint.targets' };
    return alignMoves(g).length > 0 ? { ok: true } : { ok: false, reasonKey: 'align.alreadyAligned' };
  },
  commit(g, tx) {
    const plane = tx.workplane;
    const moves = alignMoves(g);
    if (!plane || g.reference === null || moves.length === 0) throw new Error('Nothing to align');
    return commitElementAlignment(tx, tx.modelId, { reference: g.reference, targets: g.targets, mode: g.mode }, g.boxes, plane);
  },
  afterCommit: () => ({ exit: true }),
  ghost(g, ctx) {
    if (!ctx.workplane) return [];
    const plane = ctx.workplane;
    const base = commandGhostId(ctx.get());
    return alignmentGhosts(g, plane, base);
  },
};
