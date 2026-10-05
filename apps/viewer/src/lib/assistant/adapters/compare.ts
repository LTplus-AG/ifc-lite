/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import { compareImpactOf } from '@/lib/compare/compare-analysis-state';
import { IMPACT_LIMITATIONS } from '@/lib/compare/impact';
import { unavailableCapture, type AdapterCapture, type EvidenceAdapter } from './types';

const IMPACT_ROWS = 30;
const RECONCILIATION_ROWS = 20;

const RECONCILIATION_LIMITATIONS = 'Reconciliation pairs findings by native identity (clash review key; specification id + GlobalId) '
  + 'only between runs that passed the compatibility check. notEvaluated means the head run could not have observed the finding '
  + '(truncated or partial run, rule/specification not run or errored, element not re-examined); it is never a resolution.';

/**
 * Native diff entries, the Impact section (#6921) and the last run reconciliation.
 * Rows share one bound; the impact and reconciliation sections reserve part of it so
 * they are never crowded out by a large diff. Every number is native.
 */
function captureCompare(s: ViewerState, rowLimit: number): AdapterCapture {
  const r = s.compareResult;
  if (!r) return unavailableCapture();
  const impact = compareImpactOf(s, IMPACT_ROWS);
  const outcome = s.compareReconciliation?.comparison === r ? s.compareReconciliation.outcome : null;
  const reconciled = outcome?.ok ? outcome.findings.filter(f => f.state !== 'persisting') : [];
  const reconciliationRows = reconciled.slice(0, RECONCILIATION_ROWS);
  const sectionRows = (impact?.rows.length ?? 0) + reconciliationRows.length;
  // Changed entries first: an unchanged entry is context, never the sample's headline.
  const ordered = [...r.diff.entries.filter(e => e.state !== 'unchanged'), ...r.diff.entries.filter(e => e.state === 'unchanged')];
  const rows: unknown[] = ordered.slice(0, Math.max(0, rowLimit - sectionRows)).map(e => ({ section: 'diff', key: e.key,
    state: e.state, changeKinds: e.changeKinds, base: e.base?.ref, head: e.head?.ref }));
  for (const row of impact?.rows ?? []) rows.push({ section: 'impact', ...row });
  for (const finding of reconciliationRows) rows.push({ section: 'reconciliation', ...finding });
  const summary = { counts: r.diff.counts, scope: r.scope, baseModelId: r.baseModelId, headModelId: r.headModelId,
    geometryUnavailable: r.geometryUnavailable, placementOnlyGeometry: r.placementOnlyGeometry, excludedTypes: r.diff.excludedTypes,
    impact: impact ? { changedElements: impact.changedElements, unresolvedChanges: impact.unresolvedChanges, sources: impact.sources,
      totals: impact.totals, totalRows: impact.totalRows, includedRows: impact.rows.length, limitations: IMPACT_LIMITATIONS } : null,
    reconciliation: outcome ? (outcome.ok
      ? { kind: outcome.kind, compatible: true, counts: outcome.counts, partial: outcome.partial, excluded: outcome.excluded,
        includedRows: reconciliationRows.length, limitations: RECONCILIATION_LIMITATIONS }
      : { kind: outcome.kind, compatible: false, incompatibilities: outcome.incompatibilities }) : null };
  return { summary, rows, totalRows: r.diff.entries.length + (impact?.totalRows ?? 0) + reconciled.length, availability: 'available' };
}


/** Native model comparison entries with canonical base/head references. */
export const compareAdapter: EvidenceAdapter = {
  id: 'compare', group: 'coordination', panelIds: ['compare'],
  titleKey: 'comparePanel.panel.title', descriptionKey: 'assistant.pickCompareDescription',
  rowMeaningKey: 'assistant.evidenceRowsCompare', unavailableKey: 'assistant.evidenceUnavailableCompare',
  suggestionKeys: ['assistant.suggestCompareSummary', 'sceneActions.suggestShowChanged'],
  readiness: s => s.compareResult
    ? { status: { labelKey: 'assistant.pickChanges', params: { count: s.compareResult.diff.entries.length } }, ready: true }
    : { status: { labelKey: s.models.size < 2 ? 'assistant.pickNeedsTwoModels' : 'assistant.pickNotRun' }, ready: false },
  // The diff plus everything its impact and reconciliation sections join: replacing any of them stales the snapshot.
  identity: s => [s.compareResult, s.compareReconciliation, s.clashResult, s.clashRawResult, s.idsValidationReport,
    s.listResult, s.activeListId, s.bcfProject],
  reportStamp: s => analysisStampOf(s.compareResult),
  capture: captureCompare,
};
