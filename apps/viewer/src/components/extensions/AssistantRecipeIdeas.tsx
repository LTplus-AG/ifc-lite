/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ideas integration (viewer AI P20): saved assistant workflows and curated
 * task recipes appear beside mined patterns and starter ideas. Opening one
 * starts the same native walk-through as the Assistant's recipe list (with
 * the same grant refusals); a saved workflow can also open its Flow graph.
 * Nothing new is collected here: these are the user's saved recipes.
 */

import { useMemo, useState } from 'react';
import { GitBranch, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import type { AssistantRecipe } from '@/lib/assistant/reuse/recipe';
import { curatedRecipes } from '@/lib/assistant/reuse/recipe-catalogue';
import { useAssistantRecipes } from '@/lib/assistant/reuse/recipe-library';
import { startRecipe } from '@/lib/assistant/reuse/recipe-run';
import { REQUIREMENT_KEY, useHostSnapshot } from '@/components/viewer/assistant/recipe-steps';

export function AssistantRecipeIdeas() {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const host = useHostSnapshot();
  const saved = useAssistantRecipes(s => s.entries);
  const curated = useMemo(() => curatedRecipes(t), [t]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const open = (recipe: AssistantRecipe) => {
    const result = startRecipe(recipe, host);
    if (!result.ok) {
      setRefusal(t('assistantRecipes.refused', { reasons: [...new Set(result.refusals.map(r => t(REQUIREMENT_KEY[r.requirement])))].join(' ') }));
      return;
    }
    setRefusal(null);
    panels.openInHome('assistant');
  };
  const graphOf = (recipe: AssistantRecipe) => recipe.steps.find(step => step.kind === 'flow');
  const item = (recipe: AssistantRecipe) => {
    const graph = graphOf(recipe);
    const graphSaved = graph?.kind === 'flow' && host.savedFlowIds.has(graph.flowId);
    return <li key={recipe.id} className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium"><ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{recipe.title}</span></p>
          {recipe.description && <p className="mt-1 text-2xs text-muted-foreground leading-relaxed line-clamp-3">{recipe.description}</p>}
          <p className="mt-1 text-2xs text-muted-foreground">{t('assistantRecipes.stepCount', { count: recipe.steps.length })}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button size="sm" aria-label={t('assistantRecipes.startLabel', { title: recipe.title })} onClick={() => open(recipe)}>
            {t('assistantRecipes.start')}
          </Button>
          {graph?.kind === 'flow' && <Button size="sm" variant="outline" disabled={!graphSaved}
            title={graphSaved ? undefined : t(REQUIREMENT_KEY.savedFlow)}
            onClick={() => { useViewerStore.getState().openFlow(graph.flowId); panels.openInHome('flow'); }}>
            <GitBranch className="mr-1 h-3.5 w-3.5" />{t('assistantReuse.openGraph')}
          </Button>}
        </div>
      </div>
    </li>;
  };
  return <div>
    <div className="px-4 pt-4 pb-1 text-2xs uppercase tracking-wide font-semibold text-muted-foreground">{t('assistantRecipes.ideasHeading')}</div>
    {refusal && <p role="alert" className="mx-4 my-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">{refusal}</p>}
    <ul className="divide-y">{saved.map(item)}{curated.map(item)}</ul>
  </div>;
}
