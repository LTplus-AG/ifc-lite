/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native review of a replayed answer (#6928): what IFClite does with it after
 * the conversation classified it. Typed proposals go through their native
 * preview (clash partition, model change/authoring preflight, Flow graph
 * patch); prose goes through the report-draft path, which validates citation
 * existence. Nothing here applies an effect. The recorded-response tests and
 * the live-evaluation review share this, so a live answer is judged by the
 * same native code as a CI recording.
 */

import { useViewerStore } from '@/store';
import { normalizeClashGroupAnswer, prepareClashGroupPreview } from '@/lib/assistant/clash-group-proposal';
import { prepareFlowProposal } from '@/lib/assistant/flow-proposal';
import { prepareReportDraft } from '@/lib/assistant/report-draft';
import { parseModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { previewCounts, previewModelChanges } from '@/lib/actions/model-change-preview';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { authoringCounts, previewModelAuthoring } from '@/lib/actions/model-authoring-preview';
import type { ReplayResult } from './ai-eval-replay';

export type NativeReview =
  | { kind: 'none'; reason: string }
  | { kind: 'refused'; stage: 'parse' | 'preview' | 'report'; reason: string; normalized?: { removedRepeats: number; removedUnknown: number; droppedGroups: number } }
  | { kind: 'clash.groups'; groups: number; totalFindings: number; proposedFindings: number; unclassifiedFindings: number; omittedFromEvidence: number }
  | { kind: 'model.changes'; counts: ReturnType<typeof previewCounts>; rows: Array<{ status: string; current: unknown }> }
  | { kind: 'model.authoring'; counts: ReturnType<typeof authoringCounts> }
  | { kind: 'flow.patch'; operations: number; nodesBefore: number; nodesAfter: number; edgesAfter: number; addedCapabilities: string[] }
  | { kind: 'report'; citations: string[]; blocks: number };

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Review the completed answer of a replay; never applies, commits or saves anything. */
export function reviewReplay(result: ReplayResult): NativeReview {
  const { answer, proposal, evidence } = result;
  if (answer === null) return { kind: 'none', reason: result.error ?? 'no completed answer' };
  if (proposal?.kind === 'invalid') {
    const normalized = proposal.declared === 'clash' ? normalizeClashGroupAnswer(answer, evidence) : null;
    return { kind: 'refused', stage: 'parse', reason: proposal.reason,
      ...(normalized ? { normalized: { removedRepeats: normalized.removedRepeats, removedUnknown: normalized.removedUnknown, droppedGroups: normalized.droppedGroups } } : {}) };
  }
  try {
    if (proposal?.kind === 'clash') {
      const preview = prepareClashGroupPreview(answer, evidence);
      return { kind: 'clash.groups', groups: preview.groups.length, totalFindings: preview.totalFindings,
        proposedFindings: preview.proposedFindings, unclassifiedFindings: preview.unclassifiedFindings, omittedFromEvidence: preview.omittedFromEvidence };
    }
    if (proposal?.kind === 'changes') {
      const { rows } = previewModelChanges(useViewerStore.getState(), parseModelChangeBatch(answer));
      return { kind: 'model.changes', counts: previewCounts(rows), rows: rows.map(row => ({ status: row.status, current: row.current ?? null })) };
    }
    if (proposal?.kind === 'authoring') {
      return { kind: 'model.authoring', counts: authoringCounts(previewModelAuthoring(useViewerStore.getState(), parseModelAuthoringBatch(answer)).rows) };
    }
    if (proposal?.kind === 'flow') {
      const flow = prepareFlowProposal(answer, evidence);
      const before = JSON.parse(flow.beforeJson) as { nodes: unknown[] };
      const after = JSON.parse(flow.afterJson) as { nodes: unknown[]; edges: unknown[] };
      return { kind: 'flow.patch', operations: JSON.parse(flow.patchJson).operations.length, nodesBefore: before.nodes.length,
        nodesAfter: after.nodes.length, edgesAfter: after.edges.length, addedCapabilities: [...flow.addedCapabilities] };
    }
  } catch (error) {
    return { kind: 'refused', stage: 'preview', reason: message(error) };
  }
  if (evidence.source === 'flow') return { kind: 'none', reason: 'Flow discussion answers have no report path' };
  try {
    const draft = prepareReportDraft('Evaluation report');
    return { kind: 'report', citations: draft.citations, blocks: draft.document.blocks.length };
  } catch (error) {
    return { kind: 'refused', stage: 'report', reason: message(error) };
  }
}
