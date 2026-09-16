/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One memoized `CostBackendMethods` instance for the Cost panel tree
 * (`useCostModels`) and the detail view to share — both consume the exact
 * same `createCostAdapter` surface `bim.cost` scripting uses.
 */

import { useMemo } from 'react';
import type { CostBackendMethods } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { createCostAdapter } from '@/sdk/adapters/cost-adapter';

export function useCostBackend(): CostBackendMethods {
  return useMemo(() => createCostAdapter(useViewerStore), []);
}
