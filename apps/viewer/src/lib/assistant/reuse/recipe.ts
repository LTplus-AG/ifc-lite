/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Task recipes (viewer AI P20): versioned data describing a walk through
 * native steps — run or open an analysis, ask the assistant about its frozen
 * evidence, review a typed proposal, publish through the native outbox, or
 * open a saved Flow graph. A recipe never carries credentials, model data or
 * captured evidence: only source names, prompts, action kinds and references.
 *
 * Requirements are derived from step kinds (`recipe-availability.ts`), never
 * read from the file, so an imported recipe cannot claim fewer grants.
 */

import { isAssistantSource, type AssistantSource } from '../sources';

export const RECIPE_VERSION = 1;
/** Typed proposals and native drafts a recipe may ask the user to review. */
export const REVIEWED_ACTIONS = ['model.changes', 'model.authoring', 'clash.groups', 'flow.patch', 'bcf.drafts', 'report.draft'] as const;
export type ReviewedAction = typeof REVIEWED_ACTIONS[number];
export const isReviewedAction = (value: unknown): value is ReviewedAction =>
  typeof value === 'string' && (REVIEWED_ACTIONS as readonly string[]).includes(value);

export type RecipeStep =
  /** Run or open the native analysis that produces this evidence source. */
  | { kind: 'analysis'; source: AssistantSource }
  /** Attach the source's frozen evidence and prefill the prompt; the user sends it. */
  | { kind: 'ask'; source: AssistantSource; prompt: string }
  /** Review a typed proposal or native draft; nothing is applied without approval. */
  | { kind: 'review'; action: ReviewedAction }
  /** Publish reviewed BCF drafts through the native publication outbox. */
  | { kind: 'publish'; target: 'bcf' }
  /** Open a saved native Flow graph by reference. */
  | { kind: 'flow'; flowId: string };

export interface AssistantRecipe {
  version: typeof RECIPE_VERSION;
  id: string;
  /** Curated recipes ship with the viewer; others were saved from a conversation or imported. */
  origin: 'curated' | 'conversation' | 'imported';
  /** Curated content revision, so an exported copy can be compared with the shipped one. */
  revision: number;
  title: string;
  description: string;
  createdAt: string;
  steps: RecipeStep[];
}

export const RECIPE_LIMITS = { title: 200, description: 2000, prompt: 8000, steps: 24, id: 200 } as const;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);

/** Exact-shape step decode: unknown fields are dropped, unknown kinds refuse the recipe. */
export function decodeRecipeStep(value: unknown): RecipeStep | null {
  if (!record(value)) return null;
  switch (value.kind) {
    case 'analysis': return isAssistantSource(value.source) ? { kind: 'analysis', source: value.source } : null;
    case 'ask': return isAssistantSource(value.source) && text(value.prompt, RECIPE_LIMITS.prompt)
      ? { kind: 'ask', source: value.source, prompt: value.prompt } : null;
    case 'review': return isReviewedAction(value.action) ? { kind: 'review', action: value.action } : null;
    case 'publish': return value.target === 'bcf' ? { kind: 'publish', target: 'bcf' } : null;
    case 'flow': return text(value.flowId, RECIPE_LIMITS.id) ? { kind: 'flow', flowId: value.flowId } : null;
    default: return null;
  }
}

/** Bounded, exact-shape decode of an untrusted recipe; returns a fresh object. */
export function decodeRecipe(value: unknown): AssistantRecipe | null {
  if (!record(value) || value.version !== RECIPE_VERSION || !text(value.id, RECIPE_LIMITS.id)
    || (value.origin !== 'curated' && value.origin !== 'conversation' && value.origin !== 'imported')
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !text(value.title, RECIPE_LIMITS.title) || !text(value.description, RECIPE_LIMITS.description, true)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > RECIPE_LIMITS.steps) return null;
  const steps: RecipeStep[] = [];
  for (const raw of value.steps) {
    const step = decodeRecipeStep(raw);
    if (!step) return null;
    steps.push(step);
  }
  return { version: RECIPE_VERSION, id: value.id, origin: value.origin, revision: value.revision as number,
    title: value.title, description: value.description, createdAt: value.createdAt, steps };
}

/** Every user-authored string in a recipe, for credential scanning before save or export. */
export function recipeText(recipe: AssistantRecipe): string[] {
  return [recipe.title, recipe.description, ...recipe.steps.flatMap(step => step.kind === 'ask' ? [step.prompt] : [])];
}
