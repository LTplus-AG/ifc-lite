/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { invalidInput, unavailable } from './refusals';

export function requireModelSchedule(state: Pick<ViewerState, 'scheduleData' | 'scheduleSourceModelId'>, modelId: string) {
  if (!state.scheduleData) throw unavailable('Initialize the native timeline for the target model first.');
  if (state.scheduleSourceModelId !== modelId) throw invalidInput('wrong-target', 'The loaded timeline belongs to a different model.');
  return state.scheduleData;
}
