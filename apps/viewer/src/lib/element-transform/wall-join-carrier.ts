/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */



import { modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { wallJoinRefusal } from '@/store/slices/mutation-wall-joins';
import { carryWallJoinsInStore } from '../../../../../packages/create/src/in-store/element-transform-joins.js';
import type { TransformJoinCarrier } from './commit.js';

export const carryWallJoins: TransformJoinCarrier = ({ tx, modelId, plan, op }) => {
  const target = modelEditTarget(tx.store, modelId);
  if (!target || wallJoinRefusal(tx.store, modelId) !== null) return [];
  return recordModellingEdit(tx.api, modelId, (_methods, draft) =>
    carryWallJoinsInStore({ ...target, view: draft.getMutationView(), editor: draft }, plan, op.kind === 'rotate' ? op.angle : 0), tx.batchId);
};
