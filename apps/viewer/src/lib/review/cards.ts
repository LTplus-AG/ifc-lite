/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordination cards (P18, #6922): findings that refer to exactly the same
 * set of validated elements form one card. Cards are not transitive clusters:
 * a clash between A and B is its own card, and links to the card of findings
 * on A alone as *related* instead of absorbing it, so no finding is ever in
 * two cards and one busy element cannot swallow the whole model.
 *
 * A finding with any element that does not resolve to exactly one loaded
 * model (ambiguous, missing, or unresolved by its native source) is never
 * merged: it gets a card of its own marked unvalidated.
 */

import { elementKey, resolveElement, type ElementResolution } from './identity';
import type { FindingElement, FindingSourceKind, ReviewFinding, ReviewModel } from './types';

export interface CardElement extends FindingElement {
  /** Durable key when validated; null otherwise. */
  key: string | null;
  resolution: ElementResolution['state'];
  /** Live express id in `resolvedModelId` when validated. */
  expressId: number | null;
  resolvedModelId: string | null;
}

/**
 * `current`: an analysis observes it now. `not-evaluated`: only historical
 * evidence, and no complete compatible run looked again. `resolution-candidate`:
 * only historical evidence, every item re-examined by a complete current run
 * and no longer observed; a human decides. `record`: only coordination records (BCF topics or saved grouping receipts).
 */
export type CardState = 'current' | 'not-evaluated' | 'resolution-candidate' | 'record';
export const CARD_STATES: readonly CardState[] = ['current', 'not-evaluated', 'resolution-candidate', 'record'];

export interface CoordinationCard {
  /** Durable identity: the sorted validated element keys, or the single finding for an unvalidated card. */
  key: string;
  identity: 'validated' | 'unvalidated';
  elements: CardElement[];
  findings: ReviewFinding[];
  sources: FindingSourceKind[];
  state: CardState;
  /** BCF topic GUIDs among the findings. */
  topics: string[];
  /** Cards sharing at least one validated element with this one. */
  related: string[];
  disciplines: string[];
  storeys: string[];
  models: string[];
}

/** Each total counts a different thing; none is derived from another. */
export interface ReviewTotals {
  uniqueElements: number;
  unverifiedElements: number;
  currentFindings: number;
  historicalFindings: number;
  cards: number;
  topics: number;
}

const ANALYSIS_CURRENT = new Set(['observed', 'new', 'persistent']);

function cardState(findings: readonly ReviewFinding[]): CardState {
  if (findings.some(finding => finding.source !== 'bcf' && ANALYSIS_CURRENT.has(finding.lifecycle))) return 'current';
  const historical = findings.filter(finding => finding.lifecycle !== 'record');
  if (historical.length === 0) return 'record';
  // A partial or missing re-run leaves at least one item not evaluated, which blocks a resolution candidate.
  return historical.every(finding => finding.lifecycle === 'no-longer-observed') ? 'resolution-candidate' : 'not-evaluated';
}

const STATE_ORDER: Record<CardState, number> = { current: 0, 'not-evaluated': 1, 'resolution-candidate': 2, record: 3 };

export function buildCards(findings: readonly ReviewFinding[], models: readonly ReviewModel[]): { cards: CoordinationCard[]; totals: ReviewTotals } {
  const groups = new Map<string, { identity: CoordinationCard['identity']; elements: Map<string, CardElement>; findings: ReviewFinding[] }>();
  for (const finding of findings) {
    const elements = finding.elements.map((element): CardElement => {
      const resolution = resolveElement(element, models);
      if (resolution.state !== 'resolved') {
        return { ...element, key: null, resolution: resolution.state, expressId: null, resolvedModelId: null };
      }
      return { ...element, modelName: resolution.modelName, key: elementKey(resolution.modelName, element.globalId),
        resolution: 'resolved', expressId: resolution.expressId, resolvedModelId: resolution.modelId };
    });
    const validated = elements.length > 0 && elements.every(element => element.key !== null);
    const key = validated ? [...new Set(elements.map(element => element.key!))].sort().join('\n') : `finding:${finding.id}`;
    const group = groups.get(key) ?? { identity: validated ? 'validated' as const : 'unvalidated' as const, elements: new Map<string, CardElement>(), findings: [] as ReviewFinding[] };
    for (const element of elements) {
      const id = element.key ?? `${element.modelName ?? ''}\u001f${element.globalId}`;
      if (!group.elements.has(id)) group.elements.set(id, element);
    }
    group.findings.push(finding);
    groups.set(key, group);
  }
  const byElement = new Map<string, string[]>();
  for (const [key, group] of groups) {
    if (group.identity !== 'validated') continue;
    for (const elementId of group.elements.keys()) byElement.set(elementId, [...(byElement.get(elementId) ?? []), key]);
  }
  const cards: CoordinationCard[] = [...groups].map(([key, group]) => {
    const related = new Set<string>();
    if (group.identity === 'validated') for (const elementId of group.elements.keys()) {
      for (const other of byElement.get(elementId) ?? []) if (other !== key) related.add(other);
    }
    const elements = [...group.elements.values()];
    return { key, identity: group.identity, elements, findings: group.findings,
      sources: [...new Set(group.findings.map(finding => finding.source))], state: cardState(group.findings),
      topics: [...new Set(group.findings.flatMap(finding => finding.evidence.kind === 'bcf' ? [finding.evidence.topicGuid] : []))],
      related: [...related].sort(),
      disciplines: [...new Set(group.findings.flatMap(finding => finding.disciplines))].sort(),
      storeys: [...new Set(group.findings.flatMap(finding => finding.storeys))].sort(),
      models: [...new Set(elements.flatMap(element => element.modelName ? [element.modelName] : []))].sort() };
  }).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.sources.length - a.sources.length
    || b.findings.length - a.findings.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { cards, totals: totalsForCards(cards) };
}

/** Totals for the exact cards included in an action, independently of workspace filters. */
export function totalsForCards(cards: readonly CoordinationCard[]): ReviewTotals {
  const validatedElements = new Set(cards.flatMap(card => card.elements.flatMap(element => element.key ? [element.key] : [])));
  const unverifiedElements = new Set(cards.flatMap(card => card.elements.filter(element => !element.key).map(element => `${element.modelName ?? ''}\u001f${element.globalId}`)));
  const analysis = cards.flatMap(card => card.findings).filter(finding => finding.source !== 'bcf');
  return {
    uniqueElements: validatedElements.size,
    unverifiedElements: unverifiedElements.size,
    currentFindings: analysis.filter(finding => finding.run.temporal === 'current').length,
    historicalFindings: analysis.filter(finding => finding.run.temporal === 'historical').length,
    cards: cards.length,
    topics: new Set(cards.flatMap(card => card.topics)).size,
  };
}
