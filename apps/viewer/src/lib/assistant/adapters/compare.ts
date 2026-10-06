/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import { unavailableCapture, type EvidenceAdapter } from './types';

/** Native model comparison entries with canonical base/head references. */
export const compareAdapter: EvidenceAdapter = {
  id: 'compare', group: 'coordination', panelIds: ['compare'],
  titleKey: 'comparePanel.panel.title', descriptionKey: 'assistant.pickCompareDescription',
  rowMeaningKey: 'assistant.evidenceRowsCompare', unavailableKey: 'assistant.evidenceUnavailableCompare',
  suggestionKeys: ['assistant.suggestCompareSummary', 'sceneActions.suggestShowChanged'],
  readiness: s => s.compareResult
    ? { status: { labelKey: 'assistant.pickChanges', params: { count: s.compareResult.diff.entries.length } }, ready: true }
    : { status: { labelKey: s.models.size < 2 ? 'assistant.pickNeedsTwoModels' : 'assistant.pickNotRun' }, ready: false },
  identity: s => s.compareResult,
  reportStamp: s => analysisStampOf(s.compareResult),
  capture: (s, limit) => {
    const r = s.compareResult;
    if (!r) return unavailableCapture();
    return {
      summary: { counts: r.diff.counts, scope: r.scope, baseModelId: r.baseModelId, headModelId: r.headModelId,
        geometryUnavailable: r.geometryUnavailable, placementOnlyGeometry: r.placementOnlyGeometry, excludedTypes: r.diff.excludedTypes },
      totalRows: r.diff.entries.length,
      availability: 'available',
      rows: r.diff.entries.slice(0, limit).map(e => ({ key: e.key, state: e.state, changeKinds: e.changeKinds, base: e.base?.ref, head: e.head?.ref })),
    };
  },
};
