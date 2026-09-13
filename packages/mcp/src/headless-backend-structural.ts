/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StructuralBackendMethods } from '@ifc-lite/sdk';
import { extractStructuralOnDemand, type IfcDataStore } from '@ifc-lite/parser';

export function createStructuralAdapter(
  store: IfcDataStore,
  assertKnownModelId: (modelId: string) => void,
): StructuralBackendMethods {
  let cached: ReturnType<StructuralBackendMethods['data']> | null = null;
  const extract = (modelId?: string): ReturnType<StructuralBackendMethods['data']> => {
    if (modelId) assertKnownModelId(modelId);
    if (!cached) cached = extractStructuralOnDemand(store) as ReturnType<StructuralBackendMethods['data']>;
    return cached;
  };
  return {
    data: extract,
    analysisModels: modelId => extract(modelId).analysisModels,
    members: modelId => extract(modelId).members,
    connections: modelId => extract(modelId).connections,
    activities: modelId => extract(modelId).activities,
    loadGroups: modelId => extract(modelId).loadGroups,
    resultGroups: modelId => extract(modelId).resultGroups,
  };
}
