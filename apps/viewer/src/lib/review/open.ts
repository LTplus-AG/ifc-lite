/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Original evidence one click away (P18, #6922): opens the native panel that
 * owns a finding and, where the native store has a selection for it (a clash,
 * a BCF topic, a failed element), selects it there. The review layer never
 * shows a second copy of the evidence as if it were the original.
 */

import { clashReviewKey } from '@ifc-lite/clash';
import { loadRevisionBaseline } from '../clash/revision-baseline';
import { useOriginalClashBaseline } from '../clash/original-baseline';
import { useSemanticSession } from '@/lib/semantic/session';
import { useSavedComparisonFocus, useSemanticRecordFocus } from '@/lib/panels/evidence-focus';
import { useViewerStore } from '@/store';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import { selectChangedEntity } from '../changes/select-changed-entity';
import type { CoordinationCard } from './cards';
import type { FindingEvidence, ReviewFinding } from './types';

export const EVIDENCE_PANEL: Record<FindingEvidence['kind'], WorkspacePanelId> = {
  clash: 'clash', 'clash-baseline': 'clash', validation: 'validation', comparison: 'compare', 'saved-comparison': 'compare',
  bcf: 'bcf', linked: 'semantic',
};

/** Whether the original can still be reached: a historical clash baseline has no row in the live clash list. */
export function openOriginal(finding: ReviewFinding, openPanel: (panel: WorkspacePanelId) => void): boolean {
  const state = useViewerStore.getState();
  const { evidence } = finding;
  if (evidence.kind === 'clash-baseline') {
    const baseline = loadRevisionBaseline();
    const matches = baseline?.result.clashes.filter(clash => clashReviewKey(clash) === evidence.reviewKey) ?? [];
    if (!baseline || finding.run.capturedAt === null || baseline.takenAt !== Date.parse(finding.run.capturedAt) || matches.length !== 1) return false;
    useOriginalClashBaseline.setState({ finding: { clash: matches[0], takenAt: baseline.takenAt, modelNames: baseline.modelNames } });
  }
  if (evidence.kind === 'clash') {
    if (!state.clashResult?.clashes.some(clash => clash.id === evidence.clashId)) return false;
    state.setClashSelectedId(evidence.clashId);
  } else if (evidence.kind === 'bcf') {
    if (!state.bcfProject?.topics.has(evidence.topicGuid)) return false;
    state.setActiveTopic(evidence.topicGuid);
  }
  else if (evidence.kind === 'validation') {
    const sourceGlobalId = state.models.get(evidence.modelId)?.ifcDataStore?.entities.getGlobalId(evidence.expressId);
    const expected = finding.elements.find(element => element.modelId === evidence.modelId)?.globalId;
    if (!expected || !sourceGlobalId || sourceGlobalId !== expected) return false;
    if (!selectChangedEntity(evidence.modelId, evidence.expressId)) return false;
  } else if (evidence.kind === 'comparison') {
    if (!state.compareResult?.diff.entries.some(entry => entry.key === evidence.key)) return false;
    state.setCompareSelectedKey(evidence.key);
  } else if (evidence.kind === 'saved-comparison') {
    const saved = state.savedComparisons.find(item => item.id === evidence.comparisonId);
    if (saved?.report.rows.filter(row => (row.key ?? row.globalId) === evidence.key).length !== 1) return false;
    useSavedComparisonFocus.setState({ record: { comparisonId: evidence.comparisonId, key: evidence.key } });
  } else if (evidence.kind === 'linked') {
    if (!useSemanticSession.getState().document?.resources.some(resource => resource.id === evidence.resourceId)) return false;
    useSemanticRecordFocus.setState({ record: { resourceId: evidence.resourceId } });
  }
  openPanel(EVIDENCE_PANEL[evidence.kind]);
  return true;
}

/** Select every validated element of a card in the 3D view; unvalidated elements are never selected by guess. */
export function selectCardElements(card: CoordinationCard): number {
  const state = useViewerStore.getState();
  const refs = card.elements.flatMap(element => element.resolvedModelId !== null && element.expressId !== null
    ? [{ modelId: element.resolvedModelId, expressId: element.expressId }] : []);
  if (refs.length === 0) return 0;
  state.setSelectedEntityIds(refs.map(ref => state.toGlobalId(ref.modelId, ref.expressId)));
  state.setSelectedEntities(refs);
  if (state.cameraCallbacks.frameSelection) window.setTimeout(() => useViewerStore.getState().cameraCallbacks.frameSelection?.(), 50);
  return refs.length;
}
