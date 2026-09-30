/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The writes of `element.trimExtend` (charter #6232, C1), inside the one
 * `runTransaction` a commit is: one undo step, one re-mesh request.
 *
 * A wall gets its new axis end through the ONE wall resize
 * (`resizeWallMetres`: a plain rectangle takes the four-slot write, a joined,
 * cut or Axis wall is reshaped by the join core with every join that touches
 * it kept current). Meeting a boundary WALL, it is then joined to it
 * (`joinWallsInStore`): a T where it ends on the wall's path, an L at a corner,
 * each with its `IfcRelConnectsPathElements`, the ending wall cut at the
 * other's face. Moving a wall's START moves its placement, which would carry
 * its openings, doors and windows along; they are put back where they were.
 * A trim never leaves one beyond the new end: the plan refuses that.
 *
 * A beam or member is a rectangle extruded along its axis: its length is the
 * extrusion depth, and moving its start moves the placement point.
 */

import { readWallJoinTarget, joinWallsInStore, resolveWallJoinAnchor, toNativeLength } from '@ifc-lite/create';
import { toast } from '@/components/ui/toast';
import { resolve as translate } from '@/i18n/registry';
import { modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { resizeWallMetres } from '@/store/slices/mutation-wall-resize';
import { wallJoinRefusal } from '@/store/slices/mutation-wall-joins';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { shortcutLabel } from '@/lib/commands/shortcut-label';
import { readHostedCuts } from '@/lib/wall-hosted-cuts';
import type { AuthoringTransaction, CommitResult } from '../types.js';
import type { Boundary, TrimTarget } from './trim-extend-model.js';
import type { TrimExtendPreview } from './trim-extend-plan.js';

type Ok = Extract<TrimExtendPreview, { ok: true }>;

function editTarget(tx: AuthoringTransaction, modelId: string) {
  const edit = modelEditTarget(tx.store, modelId);
  if (!edit) throw new Error(`No model loaded for id "${modelId}"`);
  return edit;
}

function commitWall(tx: AuthoringTransaction, target: TrimTarget, boundary: Boundary, plan: Ok): CommitResult {
  const { modelId, expressId } = target;
  const axis = target.axis!;
  const before = target.wall!;
  const edit = editTarget(tx, modelId);
  const scale = getModelLengthUnitScale(edit.dataStore);
  const joinsBoundary = boundary.kind === 'wall' && boundary.ref !== null;
  if (joinsBoundary) {
    const refusal = wallJoinRefusal(tx.store, modelId);
    if (refusal) throw new Error(refusal);
  }

  // Where the wall's openings sit now, before the write moves anything.
  const cuts = readHostedCuts(edit.dataStore, edit.view, edit.editor, expressId).cuts;

  const z = axis.p0[2];
  const resized = resizeWallMetres(tx.api, edit, modelId, expressId, [plan.start[0], plan.start[1], z], [plan.stop[0], plan.stop[1], z], tx.batchId);
  if (!resized.ok) throw new Error(translate('trimExtend.failed', { reason: resized.reason }));
  const walls = new Set<number>(resized.walls);
  walls.add(expressId);

  // A new placement (the start moved) carries the openings with it: put each back where it stood.
  const after = readWallJoinTarget(edit.dataStore, edit.view, expressId, scale);
  if (cuts.length > 0 && !after) throw new Error(translate('trimExtend.failed', { reason: translate('trimExtend.refused.wallBody') }));
  if (after && cuts.length > 0) {
    const [dx, dy] = axis.dir;
    const mx = after.origin[0] - before.origin[0];
    const my = after.origin[1] - before.origin[1];
    const along = mx * dx + my * dy;
    const across = -mx * dy + my * dx;
    if (Math.abs(along) > 1e-9 || Math.abs(across) > 1e-9) {
      const native = (v: number) => toNativeLength({ lengthUnitScale: scale }, v);
      for (const cut of cuts) {
        tx.store.setPositionalAttribute(modelId, cut.locationPointId, 0, [cut.location[0] - native(along), cut.location[1] - native(across), cut.location[2]]);
      }
    }
  }

  let joined = false;
  if (joinsBoundary) {
    const boundaryId = boundary.ref!.expressId;
    recordModellingEdit(tx.api, modelId, (_methods, draft) => {
      const anchor = resolveWallJoinAnchor(edit.dataStore, draft.getMutationView());
      return joinWallsInStore(draft, edit.dataStore, anchor, boundaryId, expressId);
    }, tx.batchId);
    walls.add(boundaryId);
    joined = true;
  }
  toast.success(`${translate(plan.op === 'trim' ? 'trimExtend.done.trim' : 'trimExtend.done.extend', { name: target.label })}${joined ? ` · ${translate('trimExtend.done.joined')}` : ''} — ${shortcutLabel('edit.undo')}`);
  // 'hostsChanged': the openings and fillings of every re-cut wall are rebuilt with it.
  return { modelId, created: [], deleted: [], remesh: [...walls], remeshCause: 'hostsChanged', select: [expressId] };
}

function commitBeam(tx: AuthoringTransaction, target: TrimTarget, plan: Ok): CommitResult {
  const { modelId, expressId } = target;
  const chain = target.beam!;
  const k = chain.lengthUnitScale;
  const native = (v: number) => toNativeLength({ lengthUnitScale: k }, v);
  // Length is the extrusion depth; only a moved start moves the placement point.
  tx.store.setPositionalAttribute(modelId, chain.extrudedSolidId, 3, native(plan.length));
  if (plan.end === 'start') {
    tx.store.setPositionalAttribute(modelId, chain.startPointId, 0, [native(plan.start[0]), native(plan.start[1]), native(plan.start[2])]);
  }
  toast.success(`${translate(plan.op === 'trim' ? 'trimExtend.done.trim' : 'trimExtend.done.extend', { name: target.label })} — ${shortcutLabel('edit.undo')}`);
  return { modelId, created: [], deleted: [], remesh: [expressId], select: [expressId] };
}

/** Write a decided plan. Throws (writing nothing that survives: the transaction reverts) when the live model refuses. */
export function commitTrimExtend(tx: AuthoringTransaction, target: TrimTarget, boundary: Boundary, plan: Ok): CommitResult {
  return target.kind === 'wall' ? commitWall(tx, target, boundary, plan) : commitBeam(tx, target, plan);
}
