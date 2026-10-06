/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Original evidence one click away (P18, #6922): opens the native panel that
 * owns a finding and, where the native store has a selection for it (a clash,
 * a BCF topic, a failed element), selects it there. The review layer never
 * shows a second copy of the evidence as if it were the original.
 */

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
export function openOriginal(finding: ReviewFinding, openPanel: (panel: WorkspacePanelId) => void): void {
  const state = useViewerStore.getState();
  const { evidence } = finding;
  if (evidence.kind === 'clash') state.setClashSelectedId(evidence.clashId);
  else if (evidence.kind === 'bcf') state.setActiveTopic(evidence.topicGuid);
  else if (evidence.kind === 'validation') selectChangedEntity(evidence.modelId, evidence.expressId);
  openPanel(EVIDENCE_PANEL[evidence.kind]);
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
