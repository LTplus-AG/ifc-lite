/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ScheduleBackendMethods } from '@ifc-lite/sdk';
import { extractScheduleOnDemand, type IfcDataStore } from '@ifc-lite/parser';

export function createScheduleAdapter(
  store: IfcDataStore,
  assertKnownModelId: (modelId: string) => void,
): ScheduleBackendMethods {
  let cached: ReturnType<ScheduleBackendMethods['data']> | null = null;
  const extract = (modelId?: string) => {
    if (modelId) assertKnownModelId(modelId);
    if (!cached) cached = extractScheduleOnDemand(store) as ReturnType<ScheduleBackendMethods['data']>;
    return cached;
  };
  return {
    data: extract,
    tasks: modelId => extract(modelId).tasks,
    workSchedules: modelId => extract(modelId).workSchedules,
    sequences: modelId => extract(modelId).sequences,
  };
}
