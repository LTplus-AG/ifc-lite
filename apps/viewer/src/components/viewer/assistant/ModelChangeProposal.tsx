/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useAssistant } from '@/lib/assistant/conversation';
import { parseModelChangeBatch, type ModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { parseModelAuthoringBatch, type ModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { ModelChangeReview } from '../actions/ModelChangeReview';
import { ModelAuthoringReview } from '../actions/ModelAuthoringReview';

type Reviewable = { kind: 'changes'; batch: ModelChangeBatch } | { kind: 'authoring'; batch: ModelAuthoringBatch };

/** The latest completed `model.changes` or `model.authoring` answer, reviewed natively below the conversation. Never applied by itself. */
export function ModelChangeProposal() {
  const assistant = useAssistant();
  const reply = assistant.messages.at(-1);
  const content = reply?.role === 'assistant' && assistant.status !== 'streaming' ? reply.content : null;
  const reviewable = useMemo((): Reviewable | null => {
    const kind = content ? /"kind"\s*:\s*"model\.(changes|authoring)"/.exec(content)?.[1] : undefined;
    if (!content || !kind) return null;
    try {
      return kind === 'changes' ? { kind, batch: parseModelChangeBatch(content) } : { kind: 'authoring', batch: parseModelAuthoringBatch(content) };
    } catch (error) {
      // The conversation shows the refusal reason on the proposal card.
      console.warn('[Assistant] Model change proposal is not reviewable', error);
      return null;
    }
  }, [content]);
  if (!reviewable) return null;
  const origin = `assistant:${assistant.snapshot?.id ?? assistant.archived?.id ?? 'conversation'}:${assistant.messages.length}`;
  // Keyed by answer so a newer proposal starts a fresh review.
  return reviewable.kind === 'changes'
    ? <ModelChangeReview key={origin} batch={reviewable.batch} origin={origin} />
    : <ModelAuthoringReview key={origin} batch={reviewable.batch} origin={origin} />;
}
