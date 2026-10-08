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
import { useViewerStore } from '@/store';
import { readCostModels, type CostModelEntry } from '@/lib/cost/cost-models';
import { useCostBackend } from './useCostBackend';

export type { CostModelEntry } from '@/lib/cost/cost-models';

export function useCostModels(): CostModelEntry[] {
  const models = useViewerStore((s) => s.models);
  // The legacy single-model path keeps its store in `ifcDataStore` with an
  // empty `models` Map; `readCostModels` surfaces it as one entry.
  const legacyDataStore = useViewerStore((s) => s.ifcDataStore);
  // Loaded-model cost authoring mutates the existing MutablePropertyView; it
  // does not replace `models` or `ifcDataStore`. Observe the store's canonical
  // mutation revision so an already-open panel re-reads that live overlay.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const backend = useCostBackend();

  return useMemo(() => readCostModels({ models, ifcDataStore: legacyDataStore }, backend), [models, legacyDataStore, backend, mutationVersion]);
}
