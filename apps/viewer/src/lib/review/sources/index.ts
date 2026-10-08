/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The finding-source registry: each entry reads one native analysis from its
 * own store and returns normalised findings. This is the seam for packages
 * landing in parallel: P10 (clash group receipts), P16 (semantic records) and
 * P17 (comparison reconciliation) replace or add an entry here; the card,
 * facet, persistence and UI code never reads a native store directly.
 */

import { useViewerStore } from '@/store';
import { analysisStampOf, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import { loadRevisionBaseline } from '../../clash/revision-baseline';
import { liveEntities } from '../../semantic/viewer';
import { resolveResource } from '../../semantic/resolver';
import { useSemanticSession } from '../../semantic/session';
import type { FindingSource } from '../types';
import { bcfFindings } from './bcf';
import { clashFindings } from './clash';
import { groupReceiptFindings } from './group-receipts';
import { useClashGroupApplications } from '../../clash/group-applications';
import { useClashGroupLibrary } from '../../clash/group-workspace';
import { comparisonFindings } from './comparison';
import { reconciliationFindings } from './reconciliation';
import { linkedFindings } from './linked';
import { validationFindings } from './validation';

function stale(report: object): boolean {
  const state = useViewerStore.getState();
  return isAnalysisStale(analysisStampOf(report), { mutationVersion: state.mutationVersion,
    geometryContentVersion: state.geometryContentVersion, modelPlacement: state.modelPlacement, models: state.models });
}

export const FINDING_SOURCES: readonly FindingSource[] = [
  { kind: 'clash', collect(models) {
    const state = useViewerStore.getState();
    const result = state.clashResult;
    const findings = clashFindings({
      current: result ? { result, stale: stale(state.clashRawResult ?? result) } : null,
      baseline: loadRevisionBaseline(),
    }, models);
    const applications = useClashGroupApplications.getState(), workspaces = useClashGroupLibrary.getState();
    const receipts = groupReceiptFindings(applications.entries, workspaces.status.phase === 'ready' ? workspaces.entries : [],
      result ? { result, stale: stale(state.clashRawResult ?? result) } : null, models);
    const loading = [applications, workspaces].filter(library => library.status.phase !== 'ready');
    if (loading.length) receipts.runs.push({ id: 'clash-group-libraries', source: 'clash', temporal: 'historical',
      label: 'Saved grouping evidence', capturedAt: null, complete: false, models: [],
      incomplete: [{ code: 'partial-source', detail: `Saved grouping libraries: applications ${applications.status.phase}; workspaces ${workspaces.status.phase}` }] });
    return { runs: [...findings.runs, ...receipts.runs], findings: [...findings.findings, ...receipts.findings] };
  } },
  { kind: 'validation', collect(models) {
    const report = useViewerStore.getState().idsValidationReport;
    return validationFindings(report ? { report, stale: stale(report) } : null, models);
  } },
  { kind: 'comparison', collect(models) {
    const state = useViewerStore.getState();
    const result = state.compareResult;
    const edited = result?.mutationVersion !== undefined && result.mutationVersion !== state.mutationVersion;
    const compared = comparisonFindings({ current: result ? { result, stale: edited || stale(result) } : null,
      saved: state.savedComparisons }, models);
    const reconciled = reconciliationFindings(state, models);
    return { runs: [...compared.runs, ...reconciled.runs], findings: [...compared.findings, ...reconciled.findings] };
  } },
  { kind: 'bcf', collect() { return bcfFindings(useViewerStore.getState().bcfProject); } },
  { kind: 'linked', collect(models) {
    const session = useSemanticSession.getState();
    if (!session.document || session.findings.length === 0) return linkedFindings(null, models);
    let entities: ReturnType<typeof liveEntities> | null = null;
    return linkedFindings({ document: session.document, findings: session.findings, reportTruncated: session.report?.truncated ?? false,
      retrievedAt: session.retrievedAt ?? null,
      resolve: resource => resolveResource(resource, entities ??= liveEntities(), session.revisions) }, models);
  } },
];
