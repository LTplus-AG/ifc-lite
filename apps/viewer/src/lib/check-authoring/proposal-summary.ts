/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { declaredCheckKind } from './proposal-json';
import { parseIdsProposal } from './ids-proposal';
import { parseRulesProposal } from './rules-proposal';
import { parseDocumentOutline } from './document-outline';

export type CheckDeclared = 'ids' | 'rules' | 'document';
export interface CheckProposalSummary { declared: CheckDeclared; items: number; unsupported: number }

const DECLARED = { 'ids.specifications': 'ids', 'rules.proposal': 'rules', 'document.outline': 'document' } as const;

/**
 * The conversation card's summary of a check-authoring answer: null for any
 * other reply; throws (with the parser's reason) for a refused one.
 */
export function checkProposalOf(content: string): { declared: CheckDeclared; summary: () => CheckProposalSummary } | null {
  const kind = declaredCheckKind(content);
  if (!kind) return null;
  const declared = DECLARED[kind];
  return { declared, summary: () => {
    if (kind === 'ids.specifications') {
      const proposal = parseIdsProposal(content);
      return { declared, items: proposal.document.specifications.length, unsupported: proposal.unsupported.length };
    }
    if (kind === 'rules.proposal') {
      const proposal = parseRulesProposal(content);
      return { declared, items: proposal.ruleSet.rules.length, unsupported: proposal.unsupported.length };
    }
    const outline = parseDocumentOutline(content);
    return { declared, items: outline.sections.length, unsupported: outline.unsupported.length };
  } };
}
