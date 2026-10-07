/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useAssistant } from '@/lib/assistant/conversation';
import { flowRegistry } from '@/lib/flow/runner';
import { RECIPE_VERSION, type AssistantRecipe, type ReviewedAction } from '@/lib/assistant/reuse/recipe';
import { assistantRecipeLibrary } from '@/lib/assistant/reuse/recipe-library';
import { buildWorkflowGraph, conversationWorkflowSpec, type SaveRefusal } from '@/lib/assistant/reuse/save-to-flow';
import { adapterFor } from '@/lib/assistant/adapters/registry';
import { proposalOf } from './AssistantConversation';

const ACTION: Record<string, ReviewedAction> = { clash: 'clash.groups', flow: 'flow.patch', changes: 'model.changes', authoring: 'model.authoring' };
/** Only proposals that passed their strict parser count as reviewed action kinds. */
const actionOf = (content: string): ReviewedAction | null => {
  const proposal = proposalOf(content);
  return proposal && proposal.kind !== 'invalid' ? ACTION[proposal.kind] ?? null : null;
};
const REFUSAL: Record<SaveRefusal | 'flow-dirty' | 'library-full', TranslationKey> = {
  'flow-source': 'assistantReuse.saveRefusedFlowSource', 'no-prompts': 'assistantReuse.saveRefusedNoPrompts',
  credential: 'assistantReuse.saveRefusedCredential', 'too-large': 'assistantReuse.saveRefusedTooLarge',
  'flow-dirty': 'assistantRecipes.refusedFlowDirty', 'library-full': 'assistantReuse.saveRefusedLibraryFull',
};

/**
 * Save the conversation as a reusable workflow: a native Flow graph (analysis
 * nodes, prompts, reviewed action kinds; placeholders until Flow AI nodes
 * exist) plus a recipe that walks through it. Answers and evidence values stay out.
 */
export function SaveToFlow() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const state = useAssistant();
  const evidence = state.snapshot ?? state.archived?.evidence;
  const [name, setName] = useState('');
  const [report, setReport] = useState(false);
  const [result, setResult] = useState<{ flowId: string; placeholders: number } | { refused: TranslationKey } | null>(null);
  // A graph discussion is already a native graph; native Save keeps it reusable.
  if (!evidence || evidence.source === 'flow' || !state.messages.length || state.status === 'streaming') return null;
  const save = async () => {
    const title = name.trim() || t('assistantReuse.defaultName', { source: t(adapterFor(evidence.source).titleKey) });
    const spec = conversationWorkflowSpec(title, evidence.source, state.messages, actionOf);
    if (report && !spec.actions.includes('report.draft')) spec.actions.push('report.draft');
    const graph = buildWorkflowGraph(spec, flowRegistry());
    if (!graph.ok) { setResult({ refused: REFUSAL[graph.reason] }); return; }
    const store = useViewerStore.getState();
    // The native Flow import opens the graph; never replace an unsaved open graph.
    if (store.flowDirty) { setResult({ refused: REFUSAL['flow-dirty'] }); return; }
    const flowId = store.importFlow(graph.doc);
    if (!flowId) { setResult({ refused: REFUSAL['library-full'] }); return; }
    const recipe: AssistantRecipe = { version: RECIPE_VERSION, id: crypto.randomUUID(), origin: 'conversation', revision: 1, title,
      description: t('assistantReuse.savedDescription', { source: t(adapterFor(evidence.source).titleKey) }), createdAt: new Date().toISOString(),
      steps: [{ kind: 'analysis', source: evidence.source }, ...spec.prompts.map(prompt => ({ kind: 'ask' as const, source: evidence.source, prompt })),
        ...spec.actions.map(action => ({ kind: 'review' as const, action })), { kind: 'flow', flowId }] };
    await assistantRecipeLibrary.put(recipe.id, recipe);
    setResult({ flowId, placeholders: graph.placeholders.length });
  };
  return <section aria-label={t('assistantReuse.saveTitle')} className="mx-3 my-2 rounded border border-border p-2 text-xs space-y-1.5">
    <p className="flex items-center gap-1.5 font-semibold"><GitBranch className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('assistantReuse.saveTitle')}</p>
    <p className="text-muted-foreground">{t('assistantReuse.saveHint')}</p>
    <label className="sr-only" htmlFor="assistant-workflow-name">{t('assistantReuse.workflowName')}</label>
    <input id="assistant-workflow-name" className="w-full h-7 border border-input rounded bg-background px-2" value={name} maxLength={200}
      placeholder={t('assistantReuse.workflowName')} onChange={event => setName(event.target.value)} />
    <label className="flex items-center gap-1.5">
      <input type="checkbox" checked={report} onChange={event => setReport(event.target.checked)} />{t('assistantReuse.includeReport')}
    </label>
    <Button size="sm" variant="outline" className="h-7" onClick={() => void save()}>{t('assistantReuse.save')}</Button>
    {result && ('refused' in result
      ? <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t(result.refused)}</p>
      : <div role="status" className="space-y-1">
        <p>{t('assistantReuse.saved', { count: result.placeholders })}</p>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => { useViewerStore.getState().openFlow(result.flowId); panels.openInHome('flow'); }}>
          {t('assistantReuse.openGraph')}
        </Button>
      </div>)}
  </section>;
}
