/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_VERSION } from '@ifc-lite/flow';
import { assistantRecipeLibrary, exportRecipeBundle, importRecipeBundle, parseRecipeBundle, useAssistantRecipes, type RecipeBundle } from './recipe-library';
import type { AssistantRecipe } from './recipe';

const recipe: AssistantRecipe = { version: 1, id: 'original-recipe', origin: 'conversation', revision: 1, title: 'Check delivery',
  description: '', createdAt: '2026-10-07T00:00:00Z', steps: [{ kind: 'flow', flowId: 'same-id-on-destination' }] };
const bundle: RecipeBundle = { format: 'ifc-lite-assistant-recipes', version: 1, exportedAt: '2026-10-07T00:00:00Z', recipes: [recipe],
  flows: [{ flowVersion: FLOW_VERSION, id: 'same-id-on-destination', name: 'Delivery', nodes: [], edges: [], inputs: [], outputs: [], capabilities: [] }] };

test('#6924 an import refusal cannot bind a recipe to an unrelated same-id destination graph', async () => {
  const exported = exportRecipeBundle(bundle.recipes, bundle.flows); assert.ok(exported.ok);
  const parsed = parseRecipeBundle(exported.json); assert.ok(parsed.ok);
  const result = await importRecipeBundle(parsed.bundle, () => null);
  assert.equal(result.saved, false);
  const imported = result.recipes[0];
  assert.notEqual(imported.id, recipe.id);
  assert.equal(imported.steps[0].kind, 'flow');
  assert.notEqual(imported.steps[0].kind === 'flow' && imported.steps[0].flowId, 'same-id-on-destination');
  assert.equal(imported.origin, 'imported');
  assert.equal(await assistantRecipeLibrary.put(imported.id, null), true);
});

test('#6924 recipe import reports refused persistent writes and retains the recoverable session copy', async () => {
  await assistantRecipeLibrary.initialize();
  const refusal = mock.method(IDBDatabase.prototype, 'transaction', () => { throw new DOMException('Storage refused', 'SecurityError'); });
  try {
    const result = await importRecipeBundle(bundle, () => 'fresh-native-graph');
    assert.equal(result.saved, false);
    assert.deepEqual(result.recipes[0].steps, [{ kind: 'flow', flowId: 'fresh-native-graph' }]);
    assert.ok(useAssistantRecipes.getState().entries.some(entry => entry.id === result.recipes[0].id));
    assert.equal(useAssistantRecipes.getState().status.items[result.recipes[0].id], 'unavailable');
  } finally { refusal.mock.restore(); }
});

// #7055: every successful export must fit the native importer count limits.
test('#7055 recipe export enforces the importable recipe and graph boundaries', () => {
  const recipes = Array.from({ length: 51 }, (_, i) => ({ ...recipe, id: `recipe-${i}` }));
  const acceptedRecipes = exportRecipeBundle(recipes.slice(0, 50), bundle.flows);
  assert.ok(acceptedRecipes.ok); assert.ok(parseRecipeBundle(acceptedRecipes.json).ok);
  assert.deepEqual(exportRecipeBundle(recipes, bundle.flows), { ok: false, reason: 'too-large' });
  const flows = Array.from({ length: 21 }, (_, i) => ({ ...bundle.flows[0], id: `flow-${i}` }));
  const linked = flows.map(flow => ({ ...recipe, id: `recipe-${flow.id}`, steps: [{ kind: 'flow' as const, flowId: flow.id }] }));
  const acceptedFlows = exportRecipeBundle(linked.slice(0, 20), flows);
  assert.ok(acceptedFlows.ok); assert.ok(parseRecipeBundle(acceptedFlows.json).ok);
  assert.deepEqual(exportRecipeBundle(linked, flows), { ok: false, reason: 'too-large' });
});
