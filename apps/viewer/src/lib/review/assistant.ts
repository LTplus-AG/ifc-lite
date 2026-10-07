/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Ask the assistant about this card" (P18, #6922). The Review panel pins the
 * card it was asked about; the `review` evidence adapter projects exactly that
 * card: its findings with native statuses, run temporality and completeness,
 * and the separately stored human decision. The card object is the source
 * identity, so pinning another card makes earlier evidence stale.
 */

import { useViewerStore } from '@/store';
import { useSemanticSession } from '../semantic/session';
import { take } from '../assistant/adapters/types';
import { useReviewAssistantCard } from './assistant-state';
import type { CoordinationCard } from './cards';
import { currentReviewWorkspace, decisionFor, useReviewWorkspaces, type CardDecision } from './workspace';

/** Pin one card (and the person's decision on it) for the next assistant attachment. */
export function pinReviewCard(card: CoordinationCard, decision: CardDecision | null): void {
  useReviewAssistantCard.setState({ card, project: limit => ({
    summary: reviewCardSummary(card, decision), rows: take(card.findings, limit).map(reviewFindingRow),
    totalRows: card.findings.length, availability: 'available',
  }) });
}

// The pin outlives the Review panel. Native decision edits invalidate captured evidence
// and replace the projector, including a cleared decision, without requiring a re-pin.
useReviewWorkspaces.subscribe((next, previous) => {
  const card = useReviewAssistantCard.getState().card;
  if (!card || next.entries === previous.entries) return;
  const latest = decisionFor(currentReviewWorkspace(next.entries), card.key);
  const held = decisionFor(currentReviewWorkspace(previous.entries), card.key);
  if (JSON.stringify(latest) !== JSON.stringify(held)) pinReviewCard({ ...card }, latest);
});

const clearSourcePin = () => {
  if (useReviewAssistantCard.getState().card) useReviewAssistantCard.setState({ card: null, project: null });
};
useViewerStore.subscribe((next, previous) => {
  if (next.clashResult !== previous.clashResult || next.clashRawResult !== previous.clashRawResult
    || next.idsValidationReport !== previous.idsValidationReport || next.compareResult !== previous.compareResult
    || next.savedComparisons !== previous.savedComparisons || next.bcfProject !== previous.bcfProject
    || next.models !== previous.models || next.mutationVersion !== previous.mutationVersion
    || next.geometryContentVersion !== previous.geometryContentVersion || next.modelPlacement !== previous.modelPlacement) clearSourcePin();
});
useSemanticSession.subscribe((next, previous) => {
  if (next.document !== previous.document || next.findings !== previous.findings || next.report !== previous.report
    || next.revisions !== previous.revisions || next.retrievedAt !== previous.retrievedAt) clearSourcePin();
});

export const REVIEW_EVIDENCE_LIMITATIONS =
  'One coordination card from the review workspace. Findings were grouped only because they name exactly the same validated elements; '
  + 'nativeStatus is the source analysis status, verbatim. run.temporal=historical is saved earlier evidence and does not describe the live model. '
  + 'lifecycle no-longer-observed is a resolution candidate for a person to confirm, never a resolution; not-evaluated means no complete compatible run looked again. '
  + 'humanDecision is the reviewer\'s own status and comment; do not restate it as an engine result, and never propose changing native statuses or BCF topic status.';

/** One cited row per finding; the common envelope first, then the source fields. */
export function reviewFindingRow(finding: CoordinationCard['findings'][number]) {
  const [first] = finding.elements;
  return {
    kind: 'reviewFinding', modelId: first?.modelId ?? null, globalId: first?.globalId ?? null, status: finding.nativeStatus || null,
    source: finding.source,
    run: { label: finding.run.label, temporal: finding.run.temporal, capturedAt: finding.run.capturedAt, complete: finding.run.complete,
      incomplete: finding.run.incomplete.map(gap => gap.detail ? `${gap.code}: ${gap.detail}` : gap.code) },
    lifecycle: finding.lifecycle, title: finding.title, detail: finding.detail, disciplineCandidates: finding.disciplines, storeys: finding.storeys,
    elements: finding.elements.map(element => ({ GlobalId: element.globalId, model: element.modelName })),
  };
}

export function reviewCardSummary(card: CoordinationCard, decision: CardDecision | null) {
  return {
    kind: 'coordination-card', identity: card.identity, state: card.state, sources: card.sources, topics: card.topics,
    relatedCards: card.related.length, findingCount: card.findings.length,
    elements: card.elements.map(element => ({ GlobalId: element.globalId, model: element.modelName, ifcType: element.ifcType,
      name: element.name, identity: element.resolution })),
    humanDecision: decision ? { status: decision.status, comment: decision.comment, updatedAt: decision.updatedAt } : null,
    limitations: REVIEW_EVIDENCE_LIMITATIONS,
  };
}
