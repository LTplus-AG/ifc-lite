/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { FlowDocument } from '@ifc-lite/flow';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { applyFlowCreateProposal, flowCreateBlocker, openCreatedFlow, type FlowCreateProposal, type FlowCreateReceipt } from '@/lib/assistant/flow-create';
import { captureWorkflowIntent, proposeWorkflowFlow, saveWorkflowRecipe, type WorkflowIntent } from '@/lib/assistant/reuse/workflow-flow';
import { assistantRecipeLibrary, useAssistantRecipes } from '@/lib/assistant/reuse/recipe-library';
import { REVIEWED_ACTIONS, type ReviewedAction } from '@/lib/assistant/reuse/recipe';
import { FlowCodeParams } from './FlowCodeParams';
import { FlowTrackingImpacts } from './FlowTrackingImpacts';
import { FlowPreflight } from './FlowPreflight';
import { useStepLabel } from './recipe-steps';
import { adapterFor } from '@/lib/assistant/adapters/registry';

/** A draft and its save receipt survive switching the Assistant's host. */
export const useWorkflowFlowSave = create<{
  intent: WorkflowIntent | null; proposal: FlowCreateProposal | null; receipt: FlowCreateReceipt | null; receiptSaved: boolean; recipeId: string | null; error: string | null;
}>(() => ({ intent: null, proposal: null, receipt: null, receiptSaved: false, recipeId: null, error: null }));

let latestGeneration: string | null = null;

export function WorkflowFlowSave({ name }: { name: string }) {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const label = useStepLabel();
  const review = useWorkflowFlowSave();
  const [actions, setActions] = useState<ReviewedAction[]>(() => [...(review.intent?.reviewedActionTypes ?? [])]);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setApproved(false), [review.proposal?.digest]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const currentGraph = useViewerStore(state => state.flowDoc);
  const recipeStatus = useAssistantRecipes(state => state.status);
  const storageError = useViewerStore(state => state.flowStorageError);
  useViewerStore(state => state.flowRunning); useViewerStore(state => state.flowDirty);
  const blocker = flowCreateBlocker();
  const doc: FlowDocument | null = review.proposal ? JSON.parse(review.proposal.docJson) : null;
  const run = (work: () => void) => {
    try { work(); useWorkflowFlowSave.setState({ error: null }); }
    catch (error) { useWorkflowFlowSave.setState({ error: error instanceof Error ? error.message : String(error) }); }
  };
  const generate = async () => {
    if (controller.current || busy) return;
    const job = new AbortController();
    const generation = crypto.randomUUID(); latestGeneration = generation;
    controller.current = job; setBusy(true); setApproved(false);
    try {
      const intent = captureWorkflowIntent(name || t('workflowFlow.defaultName'), actions);
      useWorkflowFlowSave.setState({ intent, proposal: null, receipt: null, error: null });
      const proposal = await proposeWorkflowFlow(intent, job.signal);
      job.signal.throwIfAborted();
      if (latestGeneration === generation) useWorkflowFlowSave.setState({ proposal });
    } catch (error) {
      if (latestGeneration === generation) useWorkflowFlowSave.setState({ error: job.signal.aborted ? t('workflowFlow.cancelled') : error instanceof Error ? error.message : String(error) });
    } finally { controller.current = null; setBusy(false); }
  };
  return <section aria-label={t('workflowFlow.title')} className="rounded border border-border p-2 space-y-2">
    <h4 className="font-semibold">{t('workflowFlow.title')}</h4>
    <p>{t('workflowFlow.hint')}</p>
    {!review.proposal && !review.receipt && <>
      <fieldset disabled={busy} className="space-y-1">
        <legend className="font-medium">{t('workflowFlow.actionKinds')}</legend>
        {REVIEWED_ACTIONS.map(action => <label key={action} className="flex items-center gap-1">
          <input type="checkbox" checked={actions.includes(action)} onChange={event => setActions(previous => event.target.checked
            ? [...previous, action] : previous.filter(item => item !== action))} />{label({ kind: 'review', action })}
        </label>)}
      </fieldset>
      <Button size="sm" disabled={busy} onClick={() => void generate()}>{t('workflowFlow.draft')}</Button>
      {busy && <Button size="sm" variant="outline" onClick={() => controller.current?.abort()}>{t('assistant.cancel')}</Button>}
    </>}
    {review.intent && <p>{t('workflowFlow.source', { source: t(adapterFor(review.intent.source).titleKey), count: review.intent.prompts.length })}</p>}
    {doc && review.proposal && <>
      <h5 className="font-medium">{doc.name}</h5>
      <ol className="list-decimal pl-5 font-mono text-2xs">
        {review.proposal.order.map(id => <li key={id}>{id} · {doc.nodes.find(node => node.id === id)?.type}</li>)}
      </ol>
      <details><summary>{t('workflowFlow.graphDetails')}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(doc, null, 2)}</pre></details>
      <p>{t('flowAssistant.createCapabilities', { capabilities: review.proposal.capabilities.join(', ') || t('assistant.none') })}</p>
      {!!review.proposal.writers.length && <p>{t('flowAssistant.createWriters', { nodes: review.proposal.writers.join(', ') })}</p>}
      {!!review.proposal.unavailable.length && <p role="alert">{t('flowAssistant.createUnavailable', { nodes: review.proposal.unavailable.join('; ') })}</p>}
      <FlowTrackingImpacts impacts={review.proposal.tracking} /><FlowCodeParams code={review.proposal.code} />
      <label className="flex items-start gap-1"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />{t('flowAssistant.createApproved')}</label>
      {blocker && <p role="alert">{t(blocker === 'running' ? 'flowAssistant.blockedRunning' : 'flowAssistant.blockedUnsaved')}</p>}
      <Button size="sm" disabled={!approved || !!blocker} onClick={() => void (async () => {
        try {
          if (!review.proposal || !review.intent) return;
          const receipt = applyFlowCreateProposal(review.proposal, review.proposal.digest);
          useWorkflowFlowSave.setState({ receipt, receiptSaved: !useViewerStore.getState().flowStorageError, proposal: null, recipeId: null, error: null });
          setApproved(false);
          const recipe = await saveWorkflowRecipe(review.intent, receipt.flowId);
          if (useWorkflowFlowSave.getState().receipt === receipt) useWorkflowFlowSave.setState({ recipeId: recipe.id });
        } catch (error) { useWorkflowFlowSave.setState({ error: error instanceof Error ? error.message : String(error) }); }
      })()}>{t('workflowFlow.save')}</Button>
      <Button size="sm" variant="outline" onClick={() => { useWorkflowFlowSave.setState({ proposal: null }); setApproved(false); }}>{t('workflowFlow.redraft')}</Button>
    </>}
    {review.receipt && <div aria-live="polite" className="space-y-2">
      <p>{t(!review.receiptSaved ? 'workflowFlow.memoryOnly' : 'flowAssistant.created', { name: review.receipt.created.name })}</p>
      {!review.receiptSaved && currentGraph?.id === review.receipt.flowId && <>
        <p role="alert">{storageError}</p>
        <Button size="sm" onClick={() => run(() => {
          useViewerStore.getState().saveFlow();
          useWorkflowFlowSave.setState({ receiptSaved: !useViewerStore.getState().flowStorageError });
        })}>{t('validationPanel.history.retrySave')}</Button>
      </>}
      {review.recipeId && recipeStatus.items[review.recipeId] !== 'saved' && <div>
        <p role="alert">{t('workflowFlow.recipeUnsaved')}</p>
        <Button size="sm" onClick={() => void assistantRecipeLibrary.retry()}>{t('workflowFlow.retryRecipe')}</Button>
      </div>}
      <Button size="sm" variant="outline" onClick={() => run(() => { openCreatedFlow(review.receipt!); panels.openInHome('flow'); })}>{t('flowAssistant.openFlow')}</Button>
      {currentGraph?.id === review.receipt.flowId && <FlowPreflight />}
      <Button size="sm" variant="outline" onClick={() => useWorkflowFlowSave.setState({ intent: null, proposal: null, receipt: null, error: null })}>{t('workflowFlow.another')}</Button>
    </div>}
    {review.error && <p role="alert">{review.error}</p>}
  </section>;
}
