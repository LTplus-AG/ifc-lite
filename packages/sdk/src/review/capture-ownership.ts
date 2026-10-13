/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { NativeReviewModel } from './capture-types.js';

export interface NativeReviewTarget {
  model: NativeReviewModel;
  view: ReturnType<NativeReviewModel['mutationView']>;
  revision: number;
}

/** The shared actual owner/store/source/revision boundary, without editor allocation. */
export function targetState(target: NativeReviewTarget, models: readonly NativeReviewModel[]) {
  const live = models.find(model => model.id === target.model.id);
  const replaced = !live || live.owner !== target.model.owner || live.store !== target.model.store || live.source !== target.model.source;
  return { replaced, stale: replaced || live?.mutationView() !== target.view
    || (target.view?.getMutationRevision() ?? 0) !== target.revision };
}
