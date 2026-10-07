/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Walking a recipe: session-only state for the active recipe. Starting is
 * refused when a grant is missing (`recipeRefusals`). Each step maps to one
 * native action — open a panel, attach evidence, prefill the composer, open a
 * saved graph. Nothing is sent, applied or published by the walk-through;
 * those remain the native, reviewed controls.
 */

import { create } from 'zustand';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import type { AssistantSource } from '../sources';
import type { AssistantRecipe, RecipeStep } from './recipe';
import { recipeRefusals, type HostSnapshot, type RecipeRefusal } from './recipe-availability';

interface RecipeRunState {
  recipe: AssistantRecipe | null;
  index: number;
  done: number[];
  /** Prompt a step placed in the Assistant composer; the panel takes it once. */
  draftPrompt: string | null;
}
export const useRecipeRun = create<RecipeRunState>(() => ({ recipe: null, index: 0, done: [], draftPrompt: null }));

export function startRecipe(recipe: AssistantRecipe, host: HostSnapshot): { ok: true } | { ok: false; refusals: RecipeRefusal[] } {
  const refusals = recipeRefusals(recipe, host);
  if (refusals.length) return { ok: false, refusals };
  useRecipeRun.setState({ recipe: structuredClone(recipe), index: 0, done: [], draftPrompt: null });
  return { ok: true };
}
export function stopRecipe(): void { useRecipeRun.setState({ recipe: null, index: 0, done: [], draftPrompt: null }); }
export function goToStep(index: number): void {
  const { recipe } = useRecipeRun.getState();
  if (recipe && index >= 0 && index < recipe.steps.length) useRecipeRun.setState({ index });
}
/** Records the step as done and moves to the next one that is not done yet. */
export function completeStep(index: number): void {
  const { recipe, done } = useRecipeRun.getState();
  if (!recipe || index < 0 || index >= recipe.steps.length) return;
  const next = [...new Set([...done, index])].sort((a, b) => a - b);
  const following = recipe.steps.findIndex((_step, i) => i > index && !next.includes(i));
  useRecipeRun.setState({ done: next, index: following === -1 ? index : following });
}
export function takeDraftPrompt(): string | null {
  const prompt = useRecipeRun.getState().draftPrompt;
  if (prompt !== null) useRecipeRun.setState({ draftPrompt: null });
  return prompt;
}

/** The native action behind a step. Review steps open where that proposal or draft is reviewed. */
export type StepAction =
  | { kind: 'panel'; panel: WorkspacePanelId }
  | { kind: 'ask'; source: AssistantSource; prompt: string }
  | { kind: 'flow'; flowId: string };
export function stepAction(step: RecipeStep): StepAction {
  switch (step.kind) {
    case 'analysis': return { kind: 'panel', panel: step.source };
    case 'ask': return { kind: 'ask', source: step.source, prompt: step.prompt };
    case 'review': return { kind: 'panel', panel: step.action === 'bcf.drafts' ? 'clash' : 'assistant' };
    case 'publish': return { kind: 'panel', panel: 'bcf' };
    case 'flow': return { kind: 'flow', flowId: step.flowId };
  }
}
