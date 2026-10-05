/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useAssistant } from '@/lib/assistant/conversation';
import { parseModelChangeBatch, type ModelChangeBatch } from '@/lib/actions/model-change';
import { ModelChangeReview } from '../actions/ModelChangeReview';

/** The latest completed `model.changes` answer, reviewed natively below the conversation. */
export function ModelChangeProposal() {
  const assistant = useAssistant();
  const reply = assistant.messages.at(-1);
  const content = reply?.role === 'assistant' && assistant.status !== 'streaming' ? reply.content : null;
  const batch = useMemo((): ModelChangeBatch | null => {
    if (!content || !/"kind"\s*:\s*"model\.changes"/.test(content)) return null;
    try { return parseModelChangeBatch(content); }
    catch (error) {
      // The conversation shows the refusal reason on the proposal card.
      console.warn('[Assistant] Model change proposal is not reviewable', error);
      return null;
    }
  }, [content]);
  if (!batch) return null;
  const origin = `assistant:${assistant.snapshot?.id ?? assistant.archived?.id ?? 'conversation'}:${assistant.messages.length}`;
  // Keyed by answer so a newer proposal starts a fresh review.
  return <ModelChangeReview key={origin} batch={batch} origin={origin} />;
}
