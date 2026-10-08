/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Curated task recipes. Steps are data over native features only; titles and
 * prompts are resolved through the active catalogue so the recipe a user sees
 * (and exports) is in their language. Bump `revision` when a curated recipe's
 * steps change, so exported copies can be told apart from the shipped one.
 */

import type { TranslationKey } from '@/i18n';
import { RECIPE_VERSION, type AssistantRecipe, type RecipeStep } from './recipe';

type Translate = (key: TranslationKey) => string;
type CuratedStep = Exclude<RecipeStep, { kind: 'ask' }> | { kind: 'ask'; source: Extract<RecipeStep, { kind: 'ask' }>['source']; promptKey: TranslationKey };
interface CuratedRecipe { id: string; revision: number; titleKey: TranslationKey; descriptionKey: TranslationKey; steps: CuratedStep[] }

const CURATED: readonly CuratedRecipe[] = [
  { id: 'curated:delivery-check', revision: 1, titleKey: 'assistantRecipes.curated.delivery.title',
    descriptionKey: 'assistantRecipes.curated.delivery.description', steps: [
      { kind: 'analysis', source: 'validation' },
      { kind: 'ask', source: 'validation', promptKey: 'assistant.suggestValidationSummary' },
      { kind: 'ask', source: 'validation', promptKey: 'assistant.suggestValidationCorrections' },
      { kind: 'review', action: 'model.changes' },
      { kind: 'review', action: 'report.draft' },
    ] },
  { id: 'curated:clash-coordination', revision: 1, titleKey: 'assistantRecipes.curated.clash.title',
    descriptionKey: 'assistantRecipes.curated.clash.description', steps: [
      { kind: 'analysis', source: 'clash' },
      { kind: 'ask', source: 'clash', promptKey: 'assistant.suggestClashGroups' },
      { kind: 'review', action: 'clash.groups' },
      { kind: 'review', action: 'bcf.drafts' },
      { kind: 'publish', target: 'bcf' },
    ] },
  { id: 'curated:revision-review', revision: 1, titleKey: 'assistantRecipes.curated.revision.title',
    descriptionKey: 'assistantRecipes.curated.revision.description', steps: [
      { kind: 'analysis', source: 'compare' },
      { kind: 'ask', source: 'compare', promptKey: 'assistant.suggestCompareSummary' },
      { kind: 'review', action: 'report.draft' },
    ] },
  { id: 'curated:load-diagnosis', revision: 1, titleKey: 'assistantRecipes.curated.load.title',
    descriptionKey: 'assistantRecipes.curated.load.description', steps: [
      { kind: 'analysis', source: 'loadReport' },
      { kind: 'ask', source: 'loadReport', promptKey: 'assistant.suggestLoadReport' },
    ] },
];

/** Fixed creation stamp: curated recipes are shipped data, not user content. */
const SHIPPED_AT = '2026-10-05T00:00:00.000Z';

export function curatedRecipes(t: Translate): AssistantRecipe[] {
  return CURATED.map(recipe => ({
    version: RECIPE_VERSION, id: recipe.id, origin: 'curated', revision: recipe.revision,
    title: t(recipe.titleKey), description: t(recipe.descriptionKey), createdAt: SHIPPED_AT,
    steps: recipe.steps.map((step): RecipeStep => step.kind === 'ask'
      ? { kind: 'ask', source: step.source, prompt: t(step.promptKey) } : step),
  }));
}
