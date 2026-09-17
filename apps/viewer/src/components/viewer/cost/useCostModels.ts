/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useCostModels — live per-model cost graphs for the Cost panel (#4858).
 *
 * Consumes the SAME `createCostAdapter` surface `bim.cost` scripting uses
 * (`apps/viewer/src/sdk/adapters/cost-adapter.ts`, from the merged #4867) —
 * no cost arithmetic is re-implemented here.
 *
 * `graph: null` and `graph.HasCostData === false` are DIFFERENT states,
 * both surfaced to the caller rather than collapsed:
 *   - `null` — this model has no loaded IFC source bytes to read cost from
 *     (a GLB/point-cloud/IFCX-only load, or extraction genuinely failed).
 *     `error` names why when available.
 *   - `HasCostData: false` — the source WAS read and genuinely has no
 *     `IfcCostItem`/`IfcCostSchedule` data (the "empty" state, #4858).
 *
 * Recomputes from the store's live `models` Map on every render where that
 * Map's identity changed — so removing or replacing a model (teardown)
 * naturally drops its entry with no stale reference to clean up here; the
 * effort was `buildLoadReports` (`lib/loadReport.ts`) already established
 * for the same "no store or cache retained per-model" precedent.
 */

import { useMemo } from 'react';
import type { CostGraphData } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { getAllModelEntries } from '@/sdk/adapters/model-compat';
import { useCostBackend } from './useCostBackend';

export interface CostModelEntry {
  modelId: string;
  modelName: string;
  /** null = no cost graph could be read for this model (see module doc). */
  graph: CostGraphData | null;
  /** Set only when `graph` is null because reading failed with an error
   *  (as opposed to simply having no loaded IFC source bytes yet). */
  error?: string;
}

export function useCostModels(): CostModelEntry[] {
  const models = useViewerStore((s) => s.models);
  // The legacy single-model path keeps its store in `ifcDataStore` with an
  // empty `models` Map; `getAllModelEntries` (the same compat layer the
  // `bim.cost` adapter resolves ids through) surfaces it as one entry.
  const legacyDataStore = useViewerStore((s) => s.ifcDataStore);
  const backend = useCostBackend();

  return useMemo(() => {
    const entries: CostModelEntry[] = [];
    for (const [, model] of getAllModelEntries({ models, ifcDataStore: legacyDataStore })) {
      const hasSource = !!model.ifcDataStore?.source && model.ifcDataStore.source.byteLength > 0;
      if (!hasSource) {
        entries.push({ modelId: model.id, modelName: model.name, graph: null });
        continue;
      }
      try {
        entries.push({ modelId: model.id, modelName: model.name, graph: backend.data(model.id) });
      } catch (err) {
        entries.push({
          modelId: model.id,
          modelName: model.name,
          graph: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return entries;
  }, [models, legacyDataStore, backend]);
}
