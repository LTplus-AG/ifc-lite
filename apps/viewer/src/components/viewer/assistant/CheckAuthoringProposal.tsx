/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useAssistant } from '@/lib/assistant/conversation';
import { declaredCheckKind } from '@/lib/check-authoring/proposal-json';
import { parseIdsProposal, type IdsProposal } from '@/lib/check-authoring/ids-proposal';
import { parseRulesProposal, type RulesProposal } from '@/lib/check-authoring/rules-proposal';
import { parseDocumentOutline, type DocumentOutline } from '@/lib/check-authoring/document-outline';
import { IdsDraftReview } from '../check-authoring/IdsDraftReview';
import { RulesDraftReview } from '../check-authoring/RulesDraftReview';
import { DocumentOutlineReview } from '../check-authoring/DocumentOutlineReview';

type Reviewable = { kind: 'ids'; proposal: IdsProposal } | { kind: 'rules'; proposal: RulesProposal } | { kind: 'document'; proposal: DocumentOutline };

/**
 * The latest completed `ids.specifications`, `rules.proposal` or
 * `document.outline` answer, reviewed natively below the conversation (P07).
 * Nothing is run or saved until the coordinator does so in the review.
 */
export function CheckAuthoringProposal() {
  const assistant = useAssistant();
  const reply = assistant.messages.at(-1);
  const content = reply?.role === 'assistant' && assistant.status !== 'streaming' ? reply.content : null;
  const reviewable = useMemo((): Reviewable | null => {
    const kind = content ? declaredCheckKind(content) : null;
    if (!content || !kind) return null;
    try {
      if (kind === 'ids.specifications') return { kind: 'ids', proposal: parseIdsProposal(content) };
      if (kind === 'rules.proposal') return { kind: 'rules', proposal: parseRulesProposal(content) };
      return { kind: 'document', proposal: parseDocumentOutline(content) };
    } catch (error) {
      // The conversation's refused proposal card shows the reason and a correction request.
      console.warn('[Assistant] Check authoring proposal is not reviewable', error);
      return null;
    }
  }, [content]);
  if (!reviewable) return null;
  // Keyed by answer so a newer proposal starts a fresh review.
  const key = `${assistant.snapshot?.id ?? assistant.archived?.id ?? 'conversation'}:${assistant.messages.length}`;
  if (reviewable.kind === 'ids') return <IdsDraftReview key={key} initial={reviewable.proposal} />;
  if (reviewable.kind === 'rules') return <RulesDraftReview key={key} initial={reviewable.proposal} />;
  return <DocumentOutlineReview key={key} initial={reviewable.proposal} />;
}
