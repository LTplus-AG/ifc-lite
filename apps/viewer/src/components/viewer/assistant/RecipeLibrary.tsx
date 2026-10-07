/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef, useState } from 'react';
import { Download, Play, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import type { AssistantRecipe } from '@/lib/assistant/reuse/recipe';
import { curatedRecipes } from '@/lib/assistant/reuse/recipe-catalogue';
import { stepAvailability } from '@/lib/assistant/reuse/recipe-availability';
import { startRecipe } from '@/lib/assistant/reuse/recipe-run';
import { assistantRecipeLibrary, exportRecipeBundle, importRecipeBundle, parseRecipeBundle, useAssistantRecipes,
  type BundleRefusal } from '@/lib/assistant/reuse/recipe-library';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { REQUIREMENT_KEY, useHostSnapshot, useStepLabel } from './recipe-steps';

const BUNDLE_REFUSAL: Record<BundleRefusal | 'flow-dirty', TranslationKey> = {
  credential: 'assistantRecipes.refusedCredential', invalid: 'assistantRecipes.refusedInvalid',
  'too-large': 'assistantRecipes.refusedTooLarge', empty: 'assistantRecipes.refusedEmpty', 'flow-dirty': 'assistantRecipes.refusedFlowDirty',
};

/** Curated and saved task recipes: availability on this host, start, export/import and delete. */
export function RecipeLibrary() {
  const { t } = useTranslation();
  const { entries, status } = useAssistantRecipes();
  const host = useHostSnapshot();
  const label = useStepLabel();
  const curated = useMemo(() => curatedRecipes(t), [t]);
  const [message, setMessage] = useState<{ alert: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const start = (recipe: AssistantRecipe) => {
    const result = startRecipe(recipe, host);
    setMessage(result.ok ? null : { alert: true, text: t('assistantRecipes.refused', {
      reasons: result.refusals.map(refusal => `${label(recipe.steps[refusal.stepIndex])}: ${t(REQUIREMENT_KEY[refusal.requirement])}`).join(' '),
    }) });
  };
  const exportRecipes = (recipes: readonly AssistantRecipe[], name: string) => {
    const result = exportRecipeBundle(recipes, useViewerStore.getState().savedFlows.map(flow => flow.doc));
    if (!result.ok) { setMessage({ alert: true, text: t(BUNDLE_REFUSAL[result.reason]) }); return; }
    downloadFile(result.json, `${sanitizeFilename(name, { fallback: 'recipes' })}.recipes.json`, 'application/json');
  };
  const importFile = async (file: File) => {
    const parsed = parseRecipeBundle(await file.text());
    if (!parsed.ok) { setMessage({ alert: true, text: t(BUNDLE_REFUSAL[parsed.reason]) }); return; }
    // The native Flow import opens each graph; never replace an unsaved open graph.
    if (parsed.bundle.flows.length && useViewerStore.getState().flowDirty) { setMessage({ alert: true, text: t(BUNDLE_REFUSAL['flow-dirty']) }); return; }
    const imported = await importRecipeBundle(parsed.bundle, doc => useViewerStore.getState().importFlow(doc));
    setMessage({ alert: false, text: t('assistantRecipes.imported', { count: imported.length }) });
  };
  const row = (recipe: AssistantRecipe) => {
    const available = recipe.steps.filter(step => stepAvailability(step, host).available).length;
    return <li key={recipe.id} className="rounded border border-border p-2 space-y-1">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <p className="font-semibold break-words">{recipe.title}</p>
          {recipe.description && <p className="text-muted-foreground break-words">{recipe.description}</p>}
          <p className="text-muted-foreground">{t('assistantRecipes.availableNow', { available, total: recipe.steps.length })}</p>
        </div>
        <IconButton label={t('assistantRecipes.exportOne', { title: recipe.title })} className="h-7 w-7" onClick={() => exportRecipes([recipe], recipe.title)}>
          <Download className="h-3.5 w-3.5" /></IconButton>
        {recipe.origin !== 'curated' && <IconButton label={t('assistantRecipes.delete', { title: recipe.title })} className="h-7 w-7"
          onClick={() => void assistantRecipeLibrary.put(recipe.id, null)}><Trash2 className="h-3.5 w-3.5" /></IconButton>}
      </div>
      <Button size="sm" className="h-7" aria-label={t('assistantRecipes.startLabel', { title: recipe.title })} onClick={() => start(recipe)}>
        <Play className="h-3 w-3 mr-1" />{t('assistantRecipes.start')}
      </Button>
    </li>;
  };
  return <section aria-label={t('assistantRecipes.title')} className="border-b border-border bg-muted/20 text-xs shrink-0">
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-1">
        <h3 className="font-semibold flex-1">{t('assistantRecipes.title')}</h3>
        <Button size="sm" variant="outline" className="h-7" onClick={() => input.current?.click()}><Upload className="h-3 w-3 mr-1" />{t('assistantRecipes.import')}</Button>
        <Button size="sm" variant="outline" className="h-7" disabled={!entries.length} onClick={() => exportRecipes(entries, 'assistant-recipes')}>
          <Download className="h-3 w-3 mr-1" />{t('assistantRecipes.exportSaved')}</Button>
      </div>
      <p className="text-muted-foreground">{t('assistantRecipes.hint')}</p>
      <input ref={input} type="file" accept=".json,application/json" className="hidden" aria-label={t('assistantRecipes.import')}
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
      {message && <p role={message.alert ? 'alert' : 'status'} className={message.alert ? 'rounded border border-amber-500/40 bg-amber-500/10 p-2' : 'text-muted-foreground'}>{message.text}</p>}
      {entries.length > 0 && <>
        <h4 className="font-medium text-muted-foreground">{t('assistantRecipes.saved')}</h4>
        <ul className="space-y-1.5">{entries.map(row)}</ul>
      </>}
      <h4 className="font-medium text-muted-foreground">{t('assistantRecipes.curatedHeading')}</h4>
      <ul className="space-y-1.5">{curated.map(row)}</ul>
    </div>
    <ContentStorageNotice status={status} retry={assistantRecipeLibrary.retry} restore={assistantRecipeLibrary.restore} />
  </section>;
}
