/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Portable completed comparisons (#6506), never references into a live federation. */
import type { CompareResult } from '@/store/slices/compareSlice';
import type { FederatedModel } from '@/store/types';
import { buildCompareReport } from './exportReport';
import { modelsAsCompared } from './comparedModels';

import type { SavedComparison } from './savedComparisonSchema';
export { isSavedComparison, comparisonSummary, type SavedComparison } from './savedComparisonSchema';

export function snapshotComparison(result: CompareResult, models: ReadonlyMap<string, FederatedModel>, name: string): SavedComparison {
  if (!models.has(result.baseModelId) || !models.has(result.headModelId)) throw new Error('Both compared models must still be loaded');
  return {
    version: 1, id: crypto.randomUUID(), name: name.trim() || `${result.baseName} → ${result.headName}`,
    savedAt: new Date().toISOString(), pair: { baseModelId: result.baseModelId, headModelId: result.headModelId },
    geometryUnavailable: result.geometryUnavailable, placementOnlyGeometry: !!result.placementOnlyGeometry,
    ...(result.keyProperty ? { keyProperty: result.keyProperty } : {}),
    report: buildCompareReport(result, modelsAsCompared(models, result.comparedStores)),
  };
}

