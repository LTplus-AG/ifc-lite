/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';
import { resolve as translate } from '@/i18n/registry';
import { recordModellingCommit } from '@/store/slices/mutation-modelling-records';
import { wallJoinRefusal } from '@/store/slices/mutation-wall-joins';
import { shortcutLabel } from '@/lib/commands/shortcut-label';
import { trimExtendElementInStore } from '../../../../../../../packages/create/src/in-store/element-trim-extend.js';
import type { AuthoringTransaction, CommitResult } from '../types.js';
import type { Boundary, TrimTarget } from './trim-extend-model.js';
import type { TrimExtendPreview } from './trim-extend-plan.js';

/** Replan against the live source inside the same shared atomic writer. */
export function commitTrimExtend(tx: AuthoringTransaction, target: TrimTarget, boundary: Boundary, plan: Extract<TrimExtendPreview, { ok: true }>): CommitResult {
  const joinsBoundary = plan.joinKind !== null && boundary.kind === 'wall' && boundary.ref !== null;
  if (joinsBoundary) {
    const refusal = wallJoinRefusal(tx.store, target.modelId);
    if (refusal) throw new Error(refusal);
  }
  const axis = target.axis;
  if (!axis) throw new Error(translate('trimExtend.refused.wallBody'));
  // Selecting the same original side reproduces the gesture's chosen end.
  const click: [number, number] = plan.end === 'start'
    ? [axis.p0[0], axis.p0[1]]
    : [axis.p0[0] + axis.dir[0] * axis.length, axis.p0[1] + axis.dir[1] * axis.length];
  const result = recordModellingCommit(tx.api, target.modelId, (editor, store) => trimExtendElementInStore(store, editor, target.expressId, {
    mode: plan.op, click,
    boundary: joinsBoundary && boundary.ref
      ? { wallId: boundary.ref.expressId }
      : { a: boundary.a, b: boundary.b, tMin: boundary.tMin, tMax: boundary.tMax, reach: boundary.reach },
  }), tx.batchId);
  toast.success(`${translate(result.op === 'trim' ? 'trimExtend.done.trim' : 'trimExtend.done.extend', { name: target.label })}${result.joined ? ` · ${translate('trimExtend.done.joined')}` : ''} — ${shortcutLabel('edit.undo')}`);
  return { modelId: target.modelId, created: [], deleted: [], remesh: result.walls,
    ...(target.kind === 'wall' ? { remeshCause: 'hostsChanged' as const } : {}), select: [target.expressId] };
}
