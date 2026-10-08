/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { declaredSemanticKind, type SemanticProposalKind } from './proposal-common';
import { parseSemanticQuery, type SemanticQueryProposal } from './query-proposal';
import { parseSemanticMapping, type SemanticMappingProposal } from './mapping-proposal';
import { parseSemanticProjection, type SemanticProjectionProposal } from './projection-proposal';
import { parseSemanticRequirements, type SemanticRequirementProposal } from './requirement-proposal';

export type SemanticProposal = SemanticQueryProposal | SemanticMappingProposal | SemanticProjectionProposal | SemanticRequirementProposal;
export { declaredSemanticKind, type SemanticProposalKind };

/** Strictly parse a reply that declares a semantic kind; throws the refusal reason otherwise. */
export function parseSemanticProposal(content: string, kind: SemanticProposalKind): SemanticProposal {
  if (kind === 'semantic.query') return parseSemanticQuery(content);
  if (kind === 'semantic.mapping') return parseSemanticMapping(content);
  if (kind === 'semantic.projection') return parseSemanticProjection(content);
  return parseSemanticRequirements(content);
}

/** Item count shown on the proposal card. */
export function semanticProposalCount(proposal: SemanticProposal): number {
  if (proposal.kind === 'semantic.query') return 1;
  if (proposal.kind === 'semantic.mapping') return proposal.mappings.length;
  if (proposal.kind === 'semantic.projection') return proposal.projections.length;
  return proposal.requirements.length + proposal.unsupported.length;
}
