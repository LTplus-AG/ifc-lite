/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '../index.js';
import { countGeneratedTasks } from './schedule-edit-helpers.js';

type PendingState = Partial<Pick<ViewerState, 'georefMutations' | 'scheduleSourceModelId' | 'scheduleIsEdited' | 'scheduleData'>>;

export function hasPendingScheduleEdits(state: PendingState, modelId: string): boolean {
  return state.scheduleSourceModelId === modelId
    && ((state.scheduleIsEdited ?? false) || countGeneratedTasks(state.scheduleData) > 0);
}

/** Unsaved work of a model that lives outside its mutation view: a pending
 *  georeference value, or the schedule it owns (generated tasks or edits). */
export function hasPendingWorkOutsideView(state: PendingState, modelId: string): boolean {
  return (state.georefMutations?.has(modelId) ?? false)
    || hasPendingScheduleEdits(state, modelId);
}
