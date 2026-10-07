/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared recipe presentation and native step execution for the Assistant and Ideas panels. */

import { useEffect, useMemo, useState } from 'react';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { adapterFor, ADAPTERS } from '@/lib/assistant/adapters/registry';
import { subscribeBcfServer, loadBcfServerConfig } from '@/services/bcf-server-config';
import { captureEvidence, evidenceIsCurrent } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant } from '@/lib/assistant/conversation';
import type { RecipeStep, ReviewedAction } from '@/lib/assistant/reuse/recipe';
import { readHostSnapshot, type HostRequirement, type HostSnapshot } from '@/lib/assistant/reuse/recipe-availability';
import { stepAction, useRecipeRun } from '@/lib/assistant/reuse/recipe-run';

export const REQUIREMENT_KEY: Record<HostRequirement, TranslationKey> = {
  evidence: 'assistantRecipes.need.evidence', models: 'assistantRecipes.need.models', twoModels: 'assistantRecipes.need.twoModels',
  clashResult: 'assistantRecipes.need.clashResult', validationReport: 'assistantRecipes.need.validationReport',
  compareResult: 'assistantRecipes.need.compareResult', flowGraph: 'assistantRecipes.need.flowGraph',
  assistantModel: 'assistantRecipes.need.assistantModel', bcfServer: 'assistantRecipes.need.bcfServer',
  savedFlow: 'assistantRecipes.need.savedFlow', flowClean: 'assistantRecipes.refusedFlowDirty',
};
const REVIEW_KEY: Record<ReviewedAction, TranslationKey> = {
  'model.changes': 'assistantRecipes.step.reviewChanges', 'model.authoring': 'assistantRecipes.step.reviewAuthoring',
  'clash.groups': 'assistantRecipes.step.reviewClashGroups', 'flow.patch': 'assistantRecipes.step.reviewFlowPatch',
  'bcf.drafts': 'assistantRecipes.step.reviewBcfDrafts', 'report.draft': 'assistantRecipes.step.reviewReport',
};

export function useStepLabel(): (step: RecipeStep) => string {
  const { t } = useTranslation();
  return (step) => {
    switch (step.kind) {
      case 'analysis': return t('assistantRecipes.step.analysis', { source: t(adapterFor(step.source).titleKey) });
      case 'ask': return t('assistantRecipes.step.ask', { prompt: step.prompt });
      case 'review': return t(REVIEW_KEY[step.action]);
      case 'publish': return t('assistantRecipes.step.publish');
      case 'flow': return t('assistantRecipes.step.flow');
    }
  };
}

/** Live host availability: store changes and BCF connection changes both re-read it. */
export function useHostSnapshot(): HostSnapshot {
  const state = useViewerStore(s => s);
  const [bcfServer, setBcfServer] = useState(() => loadBcfServerConfig() !== null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const stops = ADAPTERS.flatMap(adapter => adapter.subscribe ? [adapter.subscribe(() => setRevision(value => value + 1))] : []);
    return () => stops.forEach(stop => stop());
  }, []);
  useEffect(() => subscribeBcfServer(() => setBcfServer(loadBcfServerConfig() !== null)), []);
  return useMemo(() => readHostSnapshot(state, bcfServer), [state, bcfServer, revision]);
}

/** Performs a step's native action. Asking attaches fresh evidence when needed and only fills the composer. */
export function useRunStep(): (step: RecipeStep) => Promise<void> {
  const panels = usePanelControls();
  const { t } = useTranslation();
  const { confirmDialog } = useDialogs();
  return async (step) => {
    const action = stepAction(step);
    if (action.kind === 'panel') { panels.openInHome(action.panel); return; }
    if (action.kind === 'flow') {
      const state = useViewerStore.getState();
      if (state.flowDirty || state.flowRunning || !state.savedFlows.some(flow => flow.doc.id === action.flowId)) return;
      state.openFlow(action.flowId);
      panels.openInHome('flow');
      return;
    }
    const current = useAssistant.getState();
    if (!current.snapshot || current.snapshot.source !== action.source || !evidenceIsCurrent(current.snapshot)) {
      if ((current.messages.length || current.status === 'streaming')
        && !await confirmDialog({ description: t('assistant.switchConfirm') })) return;
      replaceEvidence(captureEvidence(action.source));
    }
    // A review cancels any unconsumed recipe prompt; the user's persistent composer stays intact.
    useRecipeRun.setState({ draftPrompt: action.kind === 'ask' ? action.prompt : null });
    panels.openInHome('assistant');
  };
}
