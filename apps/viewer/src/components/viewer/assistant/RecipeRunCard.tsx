/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Check, Circle, CircleDot, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { completeStep, goToStep, stopRecipe, useRecipeRun } from '@/lib/assistant/reuse/recipe-run';
import { stepAvailability, stepProduced } from '@/lib/assistant/reuse/recipe-availability';
import { REQUIREMENT_KEY, useHostSnapshot, useRunStep, useStepLabel } from './recipe-steps';

/** The active recipe: every step with its host availability; the current one has the native action. */
export function RecipeRunCard() {
  const { t } = useTranslation();
  const { recipe, index, done } = useRecipeRun();
  const host = useHostSnapshot();
  const label = useStepLabel();
  const runStep = useRunStep();
  if (!recipe) return null;
  return <section aria-label={t('assistantRecipes.runLabel', { title: recipe.title })} className="mx-3 mt-2 rounded border border-primary/30 bg-primary/5 p-2 text-xs space-y-1.5">
    <div className="flex items-center gap-1">
      <p className="font-semibold min-w-0 flex-1 truncate">{recipe.title}</p>
      <span className="text-muted-foreground">{t('assistantRecipes.progress', { done: done.length, total: recipe.steps.length })}</span>
      <IconButton label={t('assistantRecipes.stop')} className="h-6 w-6" onClick={stopRecipe}><X className="h-3.5 w-3.5" /></IconButton>
    </div>
    <ol className="space-y-1">
      {recipe.steps.map((step, i) => {
        const availability = stepAvailability(step, host);
        const finished = done.includes(i);
        const current = i === index;
        const Icon = finished ? Check : current ? CircleDot : Circle;
        return <li key={i} aria-current={current ? 'step' : undefined} className="space-y-1">
          <button type="button" onClick={() => goToStep(i)}
            className="flex w-full items-start gap-1.5 rounded text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Icon className={finished ? 'mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600' : 'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground'} aria-hidden="true" />
            <span className={current ? 'font-medium break-words' : 'break-words'}>{label(step)}</span>
          </button>
          {current && <div className="ml-5 space-y-1">
            {!availability.available && <p className="text-amber-700 dark:text-amber-400">
              {t('assistantRecipes.unavailable', { reasons: availability.missing.map(requirement => t(REQUIREMENT_KEY[requirement])).join(' ') })}
            </p>}
            {stepProduced(step, host) && <p className="text-emerald-700 dark:text-emerald-400">{t('assistantRecipes.resultReady')}</p>}
            <div className="flex flex-wrap gap-1">
              <Button size="sm" className="h-7" disabled={!availability.available} onClick={() => runStep(step)}>{t('assistantRecipes.doStep')}</Button>
              <Button size="sm" variant="outline" className="h-7" onClick={() => completeStep(i)}>{t('assistantRecipes.markDone')}</Button>
            </div>
          </div>}
        </li>;
      })}
    </ol>
  </section>;
}
