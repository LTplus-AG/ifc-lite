/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One entry point for the four artifact proposal kinds (viewer AI P13). */

import type { ArtifactKind } from './artifact-json';
import { parseFilterProposal, type FilterProposal } from './filter-proposal';
import { parseListProposal, type ListProposal } from './list-proposal';
import { parseLensProposal, type LensProposal } from './lens-proposal';
import { parseChartProposal, type ChartProposal } from './chart-proposal';

export type { ArtifactKind } from './artifact-json';
export type ArtifactProposal = FilterProposal | ListProposal | LensProposal | ChartProposal;

/** Matches the declared kind of a JSON answer, before any strict parse. */
export const ARTIFACT_KIND_PATTERN = /"kind"\s*:\s*"(filter\.proposal|list\.proposal|lens\.proposal|chart\.proposal)"/;

export function declaredArtifactKind(content: string): ArtifactKind | null {
  return (ARTIFACT_KIND_PATTERN.exec(content)?.[1] as ArtifactKind | undefined) ?? null;
}

/** Strict parse by declared kind; throws a reason a person can act on. */
export function parseArtifactProposal(content: string, kind: ArtifactKind): ArtifactProposal {
  switch (kind) {
    case 'filter.proposal': return parseFilterProposal(content);
    case 'list.proposal': return parseListProposal(content);
    case 'lens.proposal': return parseLensProposal(content);
    case 'chart.proposal': return parseChartProposal(content);
  }
}

/** The size the proposal card states: filter rules, list columns, lens rules (an auto-colour lens is one), or one chart. */
export function artifactParts(proposal: ArtifactProposal): number {
  switch (proposal.kind) {
    case 'filter.proposal': return proposal.groups.reduce((sum, group) => sum + group.rules.length, 0);
    case 'list.proposal': return proposal.list.columns.length;
    case 'lens.proposal': return proposal.lens.autoColor ? 1 : proposal.lens.rules.length;
    case 'chart.proposal': return 1;
  }
}
