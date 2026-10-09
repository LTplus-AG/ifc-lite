/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The live comparison impact for the Compare panel (#6921): recomputed when
 * the comparison or any joined analysis is replaced, or when an edit makes
 * one stale. Reads the same state `compareImpactOf` reads for the assistant.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { compareImpactOf } from '@/lib/compare/compare-analysis-state';
import { captureImpactNavigation } from '@/lib/compare/impact-navigation';

/** Rows the panel lists; totals stay exact beyond it. */
export const PANEL_IMPACT_ROWS = 50;

export function useCompareImpact() {
  const compareResult = useViewerStore(s => s.compareResult);
  const models = useViewerStore(s => s.models);
  const clashResult = useViewerStore(s => s.clashResult);
  const clashRawResult = useViewerStore(s => s.clashRawResult);
  const idsValidationReport = useViewerStore(s => s.idsValidationReport);
  const listResult = useViewerStore(s => s.listResult);
  const listDefinitions = useViewerStore(s => s.listDefinitions);
  const activeListId = useViewerStore(s => s.activeListId);
  const bcfProject = useViewerStore(s => s.bcfProject);
  const mutationVersion = useViewerStore(s => s.mutationVersion);
  const geometryContentVersion = useViewerStore(s => s.geometryContentVersion);
  const modelPlacement = useViewerStore(s => s.modelPlacement);
  return useMemo(() => {
    const impact = compareImpactOf({ compareResult, models, clashResult, clashRawResult, idsValidationReport, listResult,
    listDefinitions, activeListId, bcfProject, mutationVersion, geometryContentVersion, modelPlacement }, PANEL_IMPACT_ROWS);
    return impact ? { impact, navigation: captureImpactNavigation(useViewerStore.getState(), impact) } : null;
  },
  [compareResult, models, clashResult, clashRawResult, idsValidationReport, listResult, listDefinitions, activeListId, bcfProject,
    mutationVersion, geometryContentVersion, modelPlacement]);
}
