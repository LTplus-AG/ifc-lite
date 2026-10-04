/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { useAssistant } from '@/lib/assistant/conversation';
import { EvidenceView } from '../analysis/EvidenceView';
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
  const eligible = assistant.snapshot?.source === 'flow' && lastReply?.role === 'assistant'
    && assistant.status !== 'streaming' && assistant.error !== 'truncated-output';
  if (!eligible && !review.proposal && !receipt) return null;
  const run = (action: () => void) => {
    try { action(); useFlowReview.setState({ error: null }); }
    catch (error) { useFlowReview.setState({ error: error instanceof Error ? error.message : String(error) }); }
  };
  return <details className="border-b border-border text-xs shrink-0">
    <summary className="cursor-pointer p-3">{t('assistant.flowReview')}</summary>
    <div className="px-3 pb-3 space-y-2 max-h-80 overflow-auto">
      <p>{t('assistant.flowDraftHint')}</p>
      <Button size="sm" variant="outline" disabled={!eligible} onClick={() => run(() => {
        const proposal = prepareFlowProposal(lastReply!.content, assistant.snapshot!);
        useFlowReview.setState({ proposal, approved: false });
      })}>{t('assistant.reviewFlowAnswer')}</Button>
      {review.proposal && <>
        <p>{t('assistant.flowTarget', { id: review.proposal.target.id, name: review.proposal.target.name })}</p>
        <EvidenceView evidence={review.proposal.evidence} state={isFlowProposalCurrent(review.proposal) ? 'captured' : 'stale'} />
        <p>{t('assistant.flowGrants', { capabilities: review.proposal.addedCapabilities.join(', ') || t('assistant.none') })}</p>
        {review.proposal.trackingChanged && <p role="alert">{t('assistant.flowTrackingWarning')}</p>}
        {!isFlowProposalCurrent(review.proposal) && <p role="alert">{t('assistant.flowProposalStale')}</p>}
        <details><summary>{t('assistant.flowBefore')}</summary><pre className="whitespace-pre-wrap break-words">{review.proposal.beforeJson}</pre></details>
        <details><summary>{t('assistant.flowAfter')}</summary><pre className="whitespace-pre-wrap break-words">{review.proposal.afterJson}</pre></details>
        <p className="font-mono break-all">{review.proposal.digest}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={review.approved}
          disabled={!isFlowProposalCurrent(review.proposal)} onChange={event => useFlowReview.setState({ approved: event.target.checked })} />{t('assistant.flowApproved')}</label>
        <Button size="sm" disabled={!review.approved || !isFlowProposalCurrent(review.proposal)} onClick={() => run(() => {
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
      {review.error && <p role="alert">{review.error}</p>}
    </div>
  </details>;
}
