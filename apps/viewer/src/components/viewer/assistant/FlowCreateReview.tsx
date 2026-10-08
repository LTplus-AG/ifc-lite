/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { ArrowUpRight, GitBranchPlus } from 'lucide-react';
import { create } from 'zustand';
import type { FlowDocument } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useAssistant } from '@/lib/assistant/conversation';
import { prepareFlowCreateProposal, applyFlowCreateProposal, flowCreateBlocker, openCreatedFlow, canRemoveCreatedFlow, removeCreatedFlow,
  type FlowCreateProposal, type FlowCreateReceipt } from '@/lib/assistant/flow-create';
import { proposalOf } from './AssistantConversation';
import { FlowCodeParams } from './FlowCodeParams';
import { FlowTrackingImpacts } from './FlowTrackingImpacts';
import { FlowPreflight } from './FlowPreflight';

// Review survives a panel switch; a created graph is a library entry, never a replacement.
export const useFlowCreateReview = create<{ proposal: FlowCreateProposal | null; receipt: FlowCreateReceipt | null; approved: boolean; error: string | null }>(
  () => ({ proposal: null, receipt: null, approved: false, error: null }));

const BLOCKER_KEY = { running: 'flowAssistant.blockedRunning', unsaved: 'flowAssistant.blockedUnsaved' } as const;

function GraphPreview({ doc, order }: { doc: FlowDocument; order: readonly string[] }) {
  const { t } = useTranslation();
  const nodes = new Map(doc.nodes.map(node => [node.id, node]));
  return <details open><summary className="cursor-pointer">{t('flowAssistant.createOrder')}</summary>
    <ol className="mt-1 list-decimal pl-5 space-y-0.5 font-mono text-2xs">
      {order.map(id => <li key={id} className="break-words">{id} · {nodes.get(id)?.type}
        {doc.edges.filter(edge => edge.to[0] === id).map(edge => ` ← ${edge.from[0]}.${edge.from[1]}→${edge.to[1]}`).join('')}</li>)}
    </ol>
  </details>;
}

export function FlowCreateReview() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const assistant = useAssistant();
  const review = useFlowCreateReview();
  // Library and open-graph changes refresh the create and remove guards.
  useViewerStore(s => s.savedFlows); useViewerStore(s => s.flowDirty); useViewerStore(s => s.flowRunning);
  const openGraph = useViewerStore(s => s.flowDoc);
  const lastReply = assistant.messages.at(-1);
  const proposed = useMemo(() => lastReply?.role === 'assistant' && proposalOf(lastReply.content)?.kind === 'flowCreate', [lastReply]);
  const doc = useMemo<FlowDocument | null>(() => review.proposal ? JSON.parse(review.proposal.docJson) : null, [review.proposal]);
  if (!proposed && !review.proposal && !review.receipt && !review.error) return null;
  const eligible = assistant.snapshot?.source === 'flow' && proposed && assistant.status !== 'streaming' && assistant.error !== 'truncated-output';
  const run = (action: () => void) => {
    try { action(); useFlowCreateReview.setState({ error: null }); }
    catch (error) { useFlowCreateReview.setState({ error: error instanceof Error ? error.message : String(error) }); }
  };
  const blocker = review.proposal ? flowCreateBlocker() : null;
  return <section aria-label={t('flowAssistant.createTitle')} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">
      <GitBranchPlus className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('flowAssistant.createTitle')}
    </h3>
    <div className="p-2 space-y-2">
      {!review.proposal && !review.receipt && <p className="text-muted-foreground">{t('flowAssistant.createHint')}</p>}
      {proposed && <Button size="sm" variant={review.proposal ? 'outline' : 'default'} className="h-7" disabled={!eligible} onClick={() => run(() => {
        useFlowCreateReview.setState({ proposal: prepareFlowCreateProposal(lastReply!.content, assistant.snapshot!), approved: false });
      })}>{t('flowAssistant.reviewCreate')}</Button>}
      {review.proposal && doc && <>
        <p className="font-medium break-words">{t('flowAssistant.createName', { name: doc.name })}</p>
        {doc.description && <p className="text-muted-foreground break-words">{doc.description}</p>}
        <p>{t('flowAssistant.createSize', { nodes: doc.nodes.length, edges: doc.edges.length })}</p>
        {doc.inputs.length > 0 && <details open><summary>{t('flowAssistant.createInputs')}</summary>
          <ul className="list-disc pl-5">{doc.inputs.map(input => <li key={`${input.nodeId}.${input.param}`} className="break-words">
            {input.label} · {input.nodeId}.{input.param} · {input.kind}
            {input.options && ` · ${input.options.join(', ')}`}
            {input.fileSlots?.map(slot => <span key={slot.id} className="block font-mono text-2xs">
              {slot.label} · {slot.accept || '*'} · {t(slot.required ? 'flowAssistant.inputRequired' : 'flowAssistant.inputOptional')}
              {' · '}{t(slot.multiple ? 'flowAssistant.inputMultiple' : 'flowAssistant.inputSingle')}
            </span>)}
          </li>)}</ul>
        </details>}
        <p>{t('flowAssistant.createCapabilities', { capabilities: review.proposal.capabilities.join(', ') || t('assistant.none') })}</p>
        {review.proposal.writers.length > 0 && <p>{t('flowAssistant.createWriters', { nodes: review.proposal.writers.join(', ') })}</p>}
        {review.proposal.unavailable.length > 0 && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 break-words">
          {t('flowAssistant.createUnavailable', { nodes: review.proposal.unavailable.join('; ') })}</p>}
        <FlowCodeParams code={review.proposal.code} />
        <FlowTrackingImpacts impacts={review.proposal.tracking} />
        <GraphPreview doc={doc} order={review.proposal.order} />
        <details><summary className="cursor-pointer">{t('assistant.flowAfter')}</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{review.proposal.docJson}</pre></details>
        {blocker && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t(BLOCKER_KEY[blocker])}</p>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={review.approved}
          onChange={event => useFlowCreateReview.setState({ approved: event.target.checked })} />{t('flowAssistant.createApproved')}</label>
        <Button size="sm" className="h-7" disabled={!review.approved || !!blocker} onClick={() => run(() => {
          const receipt = applyFlowCreateProposal(review.proposal!, review.proposal!.digest);
          useFlowCreateReview.setState({ receipt, proposal: null, approved: false });
          panels.openInHome('flow');
        })}>{t('flowAssistant.createApply')}</Button>
      </>}
      {review.receipt && <div aria-live="polite" className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 space-y-2">
        <p>{t('flowAssistant.created', { name: review.receipt.created.name })}</p>
        {/* Once the created graph is edited, the edit's own review offers preflight. */}
        {openGraph === review.receipt.created && <FlowPreflight />}
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" className="h-7" onClick={() => run(() => {
            openCreatedFlow(review.receipt!); panels.openInHome('flow');
          })}><ArrowUpRight className="h-3 w-3 mr-1" aria-hidden="true" />{t('flowAssistant.openFlow')}</Button>
          <Button size="sm" variant="outline" className="h-7" disabled={!canRemoveCreatedFlow(review.receipt)} onClick={() => run(() => {
            removeCreatedFlow(review.receipt!); useFlowCreateReview.setState({ receipt: null });
          })}>{t('flowAssistant.removeCreated')}</Button>
        </div>
      </div>}
      {review.error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{review.error}</p>}
    </div>
  </section>;
}
