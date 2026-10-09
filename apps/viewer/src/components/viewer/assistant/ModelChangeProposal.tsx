/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { declaresStructuralGraph, parseStructuralProposal, type StructuralProposal } from '@/lib/actions/structural-graph-proposal';
import { StructuralGraphReview } from './StructuralGraphReview';


import { useMemo } from 'react';
import { useAssistant } from '@/lib/assistant/conversation';
import { parseModelChangeBatch, type ModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { parseModelAuthoringBatch, type ModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { ModelChangeReview } from '../actions/ModelChangeReview';
import { ModelAuthoringReview } from '../actions/ModelAuthoringReview';
import { declaresRoomCommand, parseRoomProposal, type RoomProposal } from '@/lib/actions/room-command-proposal';
import type { RoomReview } from '@/lib/actions/room-review';
import { RoomCommandReview } from './RoomCommandReview';
import { declaresCostGraph, parseCostProposal, type CostProposal } from '@/lib/actions/cost-graph-proposal';
import { CostGraphReview } from './CostGraphReview';

type Reviewable = { kind: 'cost'; proposal: CostProposal } | { kind: 'structural'; proposal: StructuralProposal } | { kind: 'changes'; batch: ModelChangeBatch } | { kind: 'authoring'; batch: ModelAuthoringBatch } | { kind: 'room'; proposal: RoomProposal };

/** Latest completed changes, authoring or async Room answer, reviewed natively and never applied by itself. */
export function ModelChangeProposal({ onAttachRoom }: { onAttachRoom?: (review: RoomReview) => void } = {}) {
  const assistant = useAssistant();
  const reply = assistant.messages.at(-1);
  const content = reply?.role === 'assistant' && assistant.status !== 'streaming' ? reply.content : null;
  const reviewable = useMemo((): Reviewable | null => {
    if (content && declaresStructuralGraph(content)) {
      try { return { kind: 'structural', proposal: parseStructuralProposal(content) }; }
      catch (error) { console.warn('[Assistant] Structural proposal is not reviewable', error); return null; }
    }
    if (content && declaresCostGraph(content)) {
      try { return { kind: 'cost', proposal: parseCostProposal(content) }; }
      catch (error) { console.warn('[Assistant] Cost proposal is not reviewable', error); return null; }
    }
    if (content && declaresRoomCommand(content)) {
      try { return { kind: 'room', proposal: parseRoomProposal(content) }; }
      catch (error) { console.warn('[Assistant] Room proposal is not reviewable', error); return null; }
    }
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
  if (reviewable.kind === 'structural') return <StructuralGraphReview key={origin} proposal={reviewable.proposal} origin={origin} />;
  if (reviewable.kind === 'cost') return <CostGraphReview key={origin} proposal={reviewable.proposal} origin={origin} />;
  if (reviewable.kind === 'room') return <RoomCommandReview key={origin} proposal={reviewable.proposal} origin={origin} onAttach={onAttachRoom} />;
  // Keyed by answer so a newer proposal starts a fresh review.
  return reviewable.kind === 'changes'
    ? <ModelChangeReview key={origin} batch={reviewable.batch} origin={origin} />
    : <ModelAuthoringReview key={origin} batch={reviewable.batch} origin={origin} />;
}
