/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { UnsupportedItem } from './proposal-common';
import type { ExtractedRequirement, SemanticRequirementProposal } from './requirement-proposal';
import { verifySpan, type Passage, type SpanCheck } from './spans';

export interface RequirementReview {
  requirements: Array<{ requirement: ExtractedRequirement; check: SpanCheck }>;
  unsupported: Array<{ item: UnsupportedItem; check: SpanCheck | null }>;
  verified: number;
}
/** Every span is checked against the passages frozen in the conversation's evidence. */
export function reviewRequirements(proposal: SemanticRequirementProposal, passages: readonly Passage[]): RequirementReview {
  const requirements = proposal.requirements.map(item => ({ requirement: item, check: verifySpan(item.span, passages) }));
  return { requirements, verified: requirements.filter(row => row.check.status === 'verified').length,
    unsupported: proposal.unsupported.map(item => ({ item, check: item.span ? verifySpan(item.span, passages) : null })) };
}
