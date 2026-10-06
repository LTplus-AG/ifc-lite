/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Review facets: values come from the snapshot, counts are cards (never findings). */

import type { CoordinationCard } from './cards';
import { decisionFor, type ReviewWorkspace } from './workspace';
import type { FindingRun } from './types';

export const FACETS = ['source', 'run', 'model', 'state', 'decision', 'discipline', 'storey'] as const;
export type FacetKey = typeof FACETS[number];
export type ReviewFilter = Partial<Record<FacetKey, readonly string[]>>;

export interface FacetOption { value: string; label: string; cards: number }

function values(card: CoordinationCard, facet: FacetKey, workspace: ReviewWorkspace): string[] {
  switch (facet) {
    case 'source': return card.sources;
    case 'run': return [...new Set(card.findings.map(finding => finding.run.id))];
    case 'model': return card.models;
    case 'state': return [card.state];
    case 'decision': return [decisionFor(workspace, card.key)?.status ?? 'none'];
    case 'discipline': return card.disciplines;
    case 'storey': return card.storeys;
  }
}

/** A card passes when, for every facet with a selection, it carries at least one selected value. */
export function filterCards(cards: readonly CoordinationCard[], filter: ReviewFilter, workspace: ReviewWorkspace): CoordinationCard[] {
  const active = FACETS.filter(facet => (filter[facet]?.length ?? 0) > 0);
  return cards.filter(card => active.every(facet => values(card, facet, workspace).some(value => filter[facet]!.includes(value))));
}

export function facetOptions(cards: readonly CoordinationCard[], runs: readonly FindingRun[], workspace: ReviewWorkspace): Record<FacetKey, FacetOption[]> {
  const runLabels = new Map(runs.map(run => [run.id, run.label]));
  const options = {} as Record<FacetKey, FacetOption[]>;
  for (const facet of FACETS) {
    const counts = new Map<string, number>();
    for (const card of cards) for (const value of values(card, facet, workspace)) counts.set(value, (counts.get(value) ?? 0) + 1);
    options[facet] = [...counts].map(([value, count]) => ({ value, label: facet === 'run' ? runLabels.get(value) ?? value : value, cards: count }))
      .sort((a, b) => b.cards - a.cards || a.label.localeCompare(b.label));
  }
  return options;
}
