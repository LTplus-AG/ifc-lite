/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved and imported recipes, stored as the native content kind
 * `assistantRecipes` (backup, import, CAS and recovery like every other
 * library). Curated recipes are shipped data and never stored.
 *
 * Exchange format: a versioned bundle of recipes plus the Flow graphs their
 * `flow` steps reference, so a saved workflow survives export → reload →
 * import → rerun on another device. Imports get fresh identities; referenced
 * graphs go through the native Flow import, and steps are re-pointed at the
 * ids it assigns.
 */

import { create } from 'zustand';
import { migrateFlowDocument, validateFlowDocument, type FlowDocument } from '@ifc-lite/flow';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../../storage/content-library';
import type { ContentDefinition } from '../../storage/content-migration';
import { isFlowWithinSizeLimit } from '../../flow/persistence';
import { containsCredential } from './credentials';
import { decodeRecipe, recipeText, type AssistantRecipe } from './recipe';

export const assistantRecipesContent: ContentDefinition<AssistantRecipe> = {
  kind: 'assistantRecipes', legacyKey: 'ifc-lite-assistant-recipes-v1', decode: decodeRecipe,
};
export const useAssistantRecipes = create<{ entries: AssistantRecipe[]; status: ContentStatus }>(
  () => ({ entries: [], status: initialContentStatus() }));
export const assistantRecipeLibrary = createContentLibrary(assistantRecipesContent,
  () => useAssistantRecipes.getState().entries,
  (entries, status) => useAssistantRecipes.setState({ entries, status }));

export const RECIPE_BUNDLE_FORMAT = 'ifc-lite-assistant-recipes';
const BUNDLE_LIMITS = { bytes: 2_000_000, recipes: 50, flows: 20 } as const;
export interface RecipeBundle { format: typeof RECIPE_BUNDLE_FORMAT; version: 1; exportedAt: string; recipes: AssistantRecipe[]; flows: FlowDocument[] }
export type BundleRefusal = 'credential' | 'invalid' | 'too-large' | 'empty';

const flowIdsOf = (recipes: readonly AssistantRecipe[]) =>
  new Set(recipes.flatMap(recipe => recipe.steps.flatMap(step => step.kind === 'flow' ? [step.flowId] : [])));

/** Recipes plus the saved graphs they reference; refused if any text carries a credential. */
export function exportRecipeBundle(recipes: readonly AssistantRecipe[], savedFlows: readonly FlowDocument[], exportedAt = new Date().toISOString())
  : { ok: true; json: string } | { ok: false; reason: BundleRefusal } {
  if (!recipes.length) return { ok: false, reason: 'empty' };
  if (recipes.length > BUNDLE_LIMITS.recipes) return { ok: false, reason: 'too-large' };
  const referenced = flowIdsOf(recipes);
  const flows = savedFlows.filter(doc => referenced.has(doc.id));
  if (flows.length > BUNDLE_LIMITS.flows) return { ok: false, reason: 'too-large' };
  const bundle: RecipeBundle = { format: RECIPE_BUNDLE_FORMAT, version: 1, exportedAt, recipes: recipes.map(recipe => structuredClone(recipe)), flows };
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  if (containsCredential([...recipes.flatMap(recipeText), ...flows.map(doc => JSON.stringify(doc))])) return { ok: false, reason: 'credential' };
  if (json.length > BUNDLE_LIMITS.bytes) return { ok: false, reason: 'too-large' };
  return { ok: true, json };
}

/** Strict parse: bounded size and counts, exact recipe shape, valid native graphs that a recipe references. */
export function parseRecipeBundle(text: string): { ok: true; bundle: RecipeBundle } | { ok: false; reason: BundleRefusal } {
  if (text.length > BUNDLE_LIMITS.bytes) return { ok: false, reason: 'too-large' };
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { console.warn('[Assistant recipes] Import is not JSON', error); return { ok: false, reason: 'invalid' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid' };
  const raw = value as Record<string, unknown>;
  if (raw.format !== RECIPE_BUNDLE_FORMAT || raw.version !== 1 || !Array.isArray(raw.recipes) || !Array.isArray(raw.flows)
    || typeof raw.exportedAt !== 'string') return { ok: false, reason: 'invalid' };
  if (raw.recipes.length > BUNDLE_LIMITS.recipes || raw.flows.length > BUNDLE_LIMITS.flows) return { ok: false, reason: 'too-large' };
  const recipes = raw.recipes.map(decodeRecipe);
  if (!recipes.length) return { ok: false, reason: 'empty' };
  if (recipes.some(recipe => recipe === null)) return { ok: false, reason: 'invalid' };
  const valid = recipes as AssistantRecipe[];
  const referenced = flowIdsOf(valid);
  const flows: FlowDocument[] = [];
  for (const entry of raw.flows) {
    const doc = migrateFlowDocument(entry);
    if (validateFlowDocument(doc).length) return { ok: false, reason: 'invalid' };
    const flow = doc as FlowDocument;
    if (!isFlowWithinSizeLimit(flow) || !referenced.has(flow.id) || flows.some(other => other.id === flow.id)) return { ok: false, reason: 'invalid' };
    flows.push(flow);
  }
  if (containsCredential([...valid.flatMap(recipeText), ...flows.map(doc => JSON.stringify(doc))])) return { ok: false, reason: 'credential' };
  return { ok: true, bundle: { format: RECIPE_BUNDLE_FORMAT, version: 1, exportedAt: raw.exportedAt, recipes: valid, flows } };
}

/**
 * Imports referenced graphs through the native Flow library (`importFlow`
 * returns the id it assigned, or null when the library refused), then saves
 * fresh-identity recipe copies. A step whose graph could not be imported
 * gets a fresh unavailable reference rather than resolving a same-id graph on the destination.
 */
export async function importRecipeBundle(bundle: RecipeBundle, importFlow: (doc: FlowDocument) => string | null): Promise<{ recipes: AssistantRecipe[]; saved: boolean }> {
  const ids = new Map<string, string>([...flowIdsOf(bundle.recipes)].map(id => [id, crypto.randomUUID()]));
  let flowsSaved = true;
  for (const doc of bundle.flows) {
    const id = importFlow({ ...doc, id: crypto.randomUUID() });
    if (id) ids.set(doc.id, id);
    else flowsSaved = false;
  }
  const imported = bundle.recipes.map((recipe): AssistantRecipe => ({
    ...structuredClone(recipe), id: crypto.randomUUID(), origin: 'imported',
    steps: recipe.steps.map(step => step.kind === 'flow' ? { kind: 'flow', flowId: ids.get(step.flowId)! } : step),
  }));
  const saved = await Promise.all(imported.map(recipe => assistantRecipeLibrary.put(recipe.id, recipe)));
  return { recipes: imported, saved: flowsSaved && saved.every(Boolean) };
}
