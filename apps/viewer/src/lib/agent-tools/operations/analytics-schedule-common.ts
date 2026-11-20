/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import type { ViewerState } from '@/store';

export function requireModelSchedule(state: Pick<ViewerState, 'scheduleData' | 'scheduleSourceModelId'>, modelId: string) {
  if (!state.scheduleData) throw new ToolExecutionError({
    code: ToolErrorCode.UNSUPPORTED_OPERATION,
    message: 'Initialize the native timeline for the target model first.',
    details: { reason: 'unavailable' },
  });
  if (state.scheduleSourceModelId !== modelId) throw new ToolExecutionError({
    code: ToolErrorCode.INVALID_INPUT,
    message: 'The loaded timeline belongs to a different model.',
    details: { reason: 'wrong-target' },
  });
  return state.scheduleData;
}
