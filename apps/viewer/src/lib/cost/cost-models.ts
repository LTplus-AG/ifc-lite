/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-model cost graphs from a store snapshot (#4858), outside React so the
 * Cost panel (`useCostModels`) and the assistant's cost evidence (#6833)
 * read exactly the same entries through the same `bim.cost` backend.
 *
 * `graph: null` and `graph.HasCostData === false` are DIFFERENT states:
 *   - `null` — this model has no loaded IFC source bytes to read cost from
 *     (a GLB/point-cloud/IFCX-only load, or extraction genuinely failed).
 *     `error` names why when available.
 *   - `HasCostData: false` — the source WAS read and genuinely has no
 *     `IfcCostItem`/`IfcCostSchedule` data.
 */

import type { CostBackendMethods, CostGraphData } from '@ifc-lite/sdk';
import type { ViewerState } from '@/store';
import { getAllModelEntries } from '@/sdk/adapters/model-compat';

export interface CostModelEntry {
  modelId: string;
  modelName: string;
  /** null = no cost graph could be read for this model (see module doc). */
  graph: CostGraphData | null;
  /** Set only when `graph` is null because reading failed with an error
   *  (as opposed to simply having no loaded IFC source bytes yet). */
  error?: string;
}

export function readCostModels(state: Pick<ViewerState, 'models' | 'ifcDataStore'>, backend: Pick<CostBackendMethods, 'data'>): CostModelEntry[] {
  const entries: CostModelEntry[] = [];
  // The legacy single-model path keeps its store in `ifcDataStore` with an
  // empty `models` Map; `getAllModelEntries` (the same compat layer the
  // `bim.cost` adapter resolves ids through) surfaces it as one entry.
  for (const [, model] of getAllModelEntries(state)) {
    const hasSource = !!model.ifcDataStore?.source && model.ifcDataStore.source.byteLength > 0;
    if (!hasSource) {
      entries.push({ modelId: model.id, modelName: model.name, graph: null });
      continue;
    }
    try {
      entries.push({ modelId: model.id, modelName: model.name, graph: backend.data(model.id) });
    } catch (err) {
      entries.push({ modelId: model.id, modelName: model.name, graph: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return entries;
}
