/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { bcfWorldOffset } from '@/hooks/bcf/viewpoint-world-frame';
import type { DraftRun } from './draft-create';
/** The run drafts are made from and reconciled against: the filtered result the panel shows. */
export function currentDraftRun(): DraftRun | null {
  const state = useViewerStore.getState();
  const result = state.clashResult;
  if (!result) return null;
  return { clashes: result.clashes, rules: result.rulesRun.map(rule => rule.id), worldOffset: bcfWorldOffset(state.models, state.geometryResult) };
}

