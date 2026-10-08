/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isFlowSource } from '@/lib/assistant/sources';
import { useMemo } from 'react';
import { GitBranch } from 'lucide-react';
import { create } from 'zustand';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { useAssistant } from '@/lib/assistant/conversation';
import { EvidenceView } from '../analysis/EvidenceView';
import { proposalOf } from './AssistantConversation';
import { prepareFlowProposal, applyFlowProposal, undoFlowProposal, isFlowProposalCurrent, isFlowReceiptCurrent,
  type FlowProposal, type FlowApplyReceipt } from '@/lib/assistant/flow-proposal';
import { FlowCreateReview } from './FlowCreateReview';
import { FlowTrackingImpacts } from './FlowTrackingImpacts';
import { FlowCodeParams } from './FlowCodeParams';
import { FlowPreflight } from './FlowPreflight';

// Review survives a panel switch; every effect stays pinned to its original target.
export const useFlowReview = create<{ proposal: FlowProposal | null; receipts: FlowApplyReceipt[]; approved: boolean; trackingAcknowledged: boolean; error: string | null }>(
  () => ({ proposal: null, receipts: [], approved: false, trackingAcknowledged: false, error: null }));

/** New graphs and edits of the open graph are reviewed separately; each card hides when idle. */
export function FlowProposalReview() {
  return <><FlowCreateReview /><FlowPatchReview /></>;
}

function FlowPatchReview() {
  const { t } = useTranslation();
  const assistant = useAssistant();
  const review = useFlowReview();
  // Native changes must refresh the visible freshness guard, including model placement.
  useViewerStore(s => s);
  const receipt = review.receipts.at(-1);
  const lastReply = assistant.messages.at(-1);
  const proposed = useMemo(() => lastReply?.role === 'assistant' && proposalOf(lastReply.content)?.kind === 'flow', [lastReply]);
  // Graph evidence drafts patches; run evidence (#6919) drafts patches with a diagnosis of that run.
  const eligible = (!!assistant.snapshot && isFlowSource(assistant.snapshot.source)) && proposed
    && assistant.status !== 'streaming' && assistant.error !== 'truncated-output';
  if (!proposed && !review.proposal && !receipt && !review.error) return null;
  const run = (action: () => void) => {
    try { action(); useFlowReview.setState({ error: null }); }
    catch (error) { useFlowReview.setState({ error: error instanceof Error ? error.message : String(error) }); }
  };
  return <section aria-label={t('assistant.flowReview')} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">
      <GitBranch className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('assistant.flowReview')}
    </h3>
    <div className="p-2 space-y-2">
      {!review.proposal && !receipt && <p className="text-muted-foreground">{t('assistant.flowDraftHint')}</p>}
      <Button size="sm" variant={review.proposal ? 'outline' : 'default'} className="h-7" disabled={!eligible} onClick={() => run(() => {
        const proposal = prepareFlowProposal(lastReply!.content, assistant.snapshot!);
        useFlowReview.setState({ proposal, approved: false, trackingAcknowledged: false });
      })}>{t('assistant.reviewFlowAnswer')}</Button>
      {review.proposal && <>
        <p className="font-medium break-words">{t('assistant.flowTarget', { id: review.proposal.target.id, name: review.proposal.target.name })}</p>
        <p>{t('assistant.flowGrants', { capabilities: review.proposal.addedCapabilities.join(', ') || t('assistant.none') })}</p>
        {review.proposal.diagnosis && <div className="rounded border border-border p-2 space-y-1">
          <p className="font-semibold">{t('flowAssistant.diagnosisTitle')}</p>
          <ul className="space-y-1">{review.proposal.diagnosis.nodes.map(node => <li key={node.nodeId} className="break-words">
            <span className="font-mono">{t('flowAssistant.diagnosisNode', { node: node.nodeId, status: node.status, count: node.laneErrors })}</span>
            {node.messages.map(message => <span key={message} className="block text-destructive">{message}</span>)}
          </li>)}</ul>
          <p className="whitespace-pre-wrap break-words">{review.proposal.diagnosis.explanation}</p>
        </div>}
        <FlowCodeParams code={review.proposal.code} />
        {review.proposal.tracking.length > 0 && <>
          <FlowTrackingImpacts impacts={review.proposal.tracking} />
          <label className="flex items-start gap-2"><input type="checkbox" checked={review.trackingAcknowledged}
            disabled={!isFlowProposalCurrent(review.proposal)} onChange={event => useFlowReview.setState({ trackingAcknowledged: event.target.checked })} />{t('flowAssistant.trackingAcknowledge')}</label>
        </>}
        {!isFlowProposalCurrent(review.proposal) && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('assistant.flowProposalStale')}</p>}
        <details><summary className="cursor-pointer py-1">{t('assistant.flowBefore')}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{review.proposal.beforeJson}</pre></details>
        <details><summary className="cursor-pointer py-1">{t('assistant.flowAfter')}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{review.proposal.afterJson}</pre></details>
        <details><summary className="cursor-pointer py-1">{t('assistant.evidenceDetails')}</summary>
          <div className="mt-2 space-y-1">
            <EvidenceView evidence={review.proposal.evidence} state={isFlowProposalCurrent(review.proposal) ? 'captured' : 'stale'} />
            <p className="font-mono text-2xs text-muted-foreground break-all">{review.proposal.digest}</p>
          </div>
        </details>
        <label className="flex min-h-6 items-center gap-2"><input type="checkbox" className="h-4 w-4 shrink-0" checked={review.approved}
          disabled={!isFlowProposalCurrent(review.proposal)} onChange={event => useFlowReview.setState({ approved: event.target.checked })} />{t('assistant.flowApproved')}</label>
        <Button size="sm" className="h-7" disabled={!review.approved || !isFlowProposalCurrent(review.proposal)
          || (review.proposal.tracking.length > 0 && !review.trackingAcknowledged)} onClick={() => run(() => {
          const receipt = applyFlowProposal(review.proposal!, review.proposal!.digest, { trackingAcknowledged: review.trackingAcknowledged });
          useFlowReview.setState({ receipts: [...review.receipts, receipt].slice(-20), proposal: null, approved: false, trackingAcknowledged: false });
        })}>{t('assistant.applyFlow')}</Button>
      </>}
      {receipt && <div aria-live="polite" className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 space-y-2">
        <p>{t('assistant.flowApplied')}</p>
        {isFlowReceiptCurrent(receipt) && <FlowPreflight />}
        <Button size="sm" variant="outline" className="h-7" disabled={!isFlowReceiptCurrent(receipt)} onClick={() => run(() => {
          undoFlowProposal(receipt); useFlowReview.setState({ receipts: review.receipts.slice(0, -1) });
        })}>{t('assistant.undoFlow')}</Button>
      </div>}
      {review.error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{review.error}</p>}
    </div>
  </section>;
}
