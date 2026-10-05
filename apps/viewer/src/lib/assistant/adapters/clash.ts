/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import { clashDisciplineCandidates, CLASH_TAXONOMY_LIMITATIONS } from '../clash-taxonomy';
import { unavailableCapture, type EvidenceAdapter } from './types';

/** Native clash findings; row shape frozen by saved conversations (#6813). */
export const clashAdapter: EvidenceAdapter = {
  id: 'clash', group: 'checks', panelIds: ['clash'],
  titleKey: 'clashPanel.title', descriptionKey: 'assistant.pickClashDescription',
  rowMeaningKey: 'assistant.evidenceRowsClash', unavailableKey: 'assistant.evidenceUnavailableClash',
  suggestionKeys: ['assistant.suggestClashSummary', 'assistant.suggestClashGroups'],
  readiness: s => s.clashRunning ? { status: { labelKey: 'assistant.pickRunning' }, ready: false, running: true }
    : s.clashResult ? { status: { labelKey: 'assistant.pickFindings', params: { count: s.clashResult.clashes.length } }, ready: true }
      : { status: { labelKey: 'assistant.pickNotRun' }, ready: false, runnable: s.models.size > 0 },
  identity: s => s.clashResult,
  reportStamp: s => analysisStampOf(s.clashRawResult ?? s.clashResult),
  capture: (s, limit) => {
    const result = s.clashResult;
    if (!result) return unavailableCapture();
    return {
      summary: { ...result.summary, truncated: result.truncated, settings: result.settings, taxonomyLimitations: CLASH_TAXONOMY_LIMITATIONS },
      totalRows: result.clashes.length,
      availability: 'available',
      rows: result.clashes.slice(0, limit).map(c => ({ id: c.id, a: c.a, b: c.b, rule: c.rule,
        status: c.status, severity: c.severity, distance: c.distance, distanceKind: c.distanceKind,
        disciplineCandidates: clashDisciplineCandidates(c) })),
    };
  },
};
