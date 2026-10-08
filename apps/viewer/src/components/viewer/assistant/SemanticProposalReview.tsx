/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useAssistant } from '@/lib/assistant/conversation';
import { declaredSemanticKind, parseSemanticProposal, type SemanticProposal } from '@/lib/semantic/assist/proposals';
import { capturedPassages } from '@/lib/semantic/assist/spans';
import { SemanticQueryReview } from './SemanticQueryReview';
import { SemanticMappingReview } from './SemanticMappingReview';
import { SemanticProjectionReview } from './SemanticProjectionReview';
import { SemanticRequirementReview } from './SemanticRequirementReview';

/** The latest completed semantic proposal, reviewed natively below the conversation. Nothing runs, saves or applies by itself. */
export function SemanticProposalReview() {
  const assistant = useAssistant();
  const evidence = assistant.snapshot ?? assistant.archived?.evidence;
  const reply = assistant.messages.at(-1);
  const content = reply?.role === 'assistant' && assistant.status !== 'streaming' ? reply.content : null;
  const proposal = useMemo((): SemanticProposal | null => {
    const kind = content ? declaredSemanticKind(content) : null;
    if (!content || !kind) return null;
    try { return parseSemanticProposal(content, kind); }
    catch (error) {
      // The conversation's refused proposal card shows the reason.
      console.warn('[Assistant] Semantic proposal is not reviewable', error);
      return null;
    }
  }, [content]);
  // Spans verify only against passages frozen into this conversation's evidence.
  const passages = useMemo(() => evidence ? capturedPassages(evidence.payload) : [], [evidence]);
  if (!proposal) return null;
  const origin = `assistant:${assistant.snapshot?.id ?? assistant.archived?.id ?? 'conversation'}:${assistant.messages.length}`;
  if (proposal.kind === 'semantic.query') return <SemanticQueryReview key={origin} proposal={proposal} />;
  if (proposal.kind === 'semantic.mapping') return <SemanticMappingReview key={origin} proposal={proposal} origin={origin} passages={passages} />;
  if (proposal.kind === 'semantic.projection') return <SemanticProjectionReview key={origin} proposal={proposal} />;
  return <SemanticRequirementReview key={origin} proposal={proposal} origin={origin} passages={passages} />;
}
