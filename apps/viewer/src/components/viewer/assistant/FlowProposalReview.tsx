/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

// Review survives a panel switch; every effect stays pinned to its original target.
const useFlowReview = create<{ proposal: FlowProposal | null; receipts: FlowApplyReceipt[]; approved: boolean; error: string | null }>(
  () => ({ proposal: null, receipts: [], approved: false, error: null }));

export function FlowProposalReview() {
  const { t } = useTranslation();
  const assistant = useAssistant();
  const review = useFlowReview();
  // Native changes must refresh the visible freshness guard, including model placement.
  useViewerStore(s => s);
  const receipt = review.receipts.at(-1);
  const lastReply = assistant.messages.at(-1);
  const proposed = useMemo(() => lastReply?.role === 'assistant' && proposalOf(lastReply.content)?.kind === 'flow', [lastReply]);
  const eligible = assistant.snapshot?.source === 'flow' && proposed
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
        useFlowReview.setState({ proposal, approved: false });
      })}>{t('assistant.reviewFlowAnswer')}</Button>
      {review.proposal && <>
        <p>{t('assistant.flowTarget', { id: review.proposal.target.id, name: review.proposal.target.name })}</p>
        <EvidenceView evidence={review.proposal.evidence} state={isFlowProposalCurrent(review.proposal) ? 'captured' : 'stale'} />
        <p>{t('assistant.flowGrants', { capabilities: review.proposal.addedCapabilities.join(', ') || t('assistant.none') })}</p>
        {review.proposal.trackingChanged && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('assistant.flowTrackingWarning')}</p>}
        {!isFlowProposalCurrent(review.proposal) && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('assistant.flowProposalStale')}</p>}
        <details><summary className="cursor-pointer">{t('assistant.flowBefore')}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{review.proposal.beforeJson}</pre></details>
        <details><summary className="cursor-pointer">{t('assistant.flowAfter')}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{review.proposal.afterJson}</pre></details>
        <p className="font-mono text-2xs text-muted-foreground break-all">{review.proposal.digest}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={review.approved}
          disabled={!isFlowProposalCurrent(review.proposal)} onChange={event => useFlowReview.setState({ approved: event.target.checked })} />{t('assistant.flowApproved')}</label>
        <Button size="sm" className="h-7" disabled={!review.approved || !isFlowProposalCurrent(review.proposal)} onClick={() => run(() => {
          const receipt = applyFlowProposal(review.proposal!, review.proposal!.digest);
          useFlowReview.setState({ receipts: [...review.receipts, receipt].slice(-20), proposal: null, approved: false });
        })}>{t('assistant.applyFlow')}</Button>
      </>}
      {receipt && <>
        <p>{t('assistant.flowApplied')}</p>
        <Button size="sm" variant="outline" disabled={!isFlowReceiptCurrent(receipt)} onClick={() => run(() => {
          undoFlowProposal(receipt); useFlowReview.setState({ receipts: review.receipts.slice(0, -1) });
        })}>{t('assistant.undoFlow')}</Button>
      </>}
      {review.error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{review.error}</p>}
    </div>
  </section>;
}
