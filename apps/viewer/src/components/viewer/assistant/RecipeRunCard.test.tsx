/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_VERSION } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { useAssistant } from '@/lib/assistant/conversation';
import type { AssistantRecipe } from '@/lib/assistant/reuse/recipe';
// #6924: deleting the new production modules must fail native assertions,
// rather than prevent the regression file from loading in the revert oracle.
let recipeRun: typeof import('@/lib/assistant/reuse/recipe-run') | undefined;
let availability: typeof import('@/lib/assistant/reuse/recipe-availability') | undefined;
let RecipeRunCard: typeof import('./RecipeRunCard')['RecipeRunCard'] | undefined;
try {
  const component = await import('./RecipeRunCard');
  recipeRun = await import('@/lib/assistant/reuse/recipe-run');
  availability = await import('@/lib/assistant/reuse/recipe-availability');
  RecipeRunCard = component.RecipeRunCard;
} catch (error) { console.error('[RecipeRunCard.test] native recipe entry point unavailable', error); }

const initial = useViewerStore.getState();
const assistantInitial = useAssistant.getState();
const nativeFetch = globalThis.fetch;
afterEach(() => { cleanup(); recipeRun?.stopRecipe(); globalThis.fetch = nativeFetch; useViewerStore.setState(initial, true); useAssistant.setState(assistantInitial, true); });
const recipe: AssistantRecipe = { version: 1, id: 'recorded-native-workflow', origin: 'imported', revision: 1,
  title: 'Discuss the native graph', description: '', createdAt: '2026-10-07T00:00:00Z',
  steps: [{ kind: 'ask', source: 'flow', prompt: 'Explain this native graph without executing it' }] };
const button = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === 'Do this step');

test('#6924 a mounted imported recipe captures native evidence and prefills without requesting or executing', () => {
  assert.ok(recipeRun && availability && RecipeRunCard, 'the native recipe entry point must exist');
  useViewerStore.setState({ chatActiveModel: 'recorded-test-model', flowDoc: { flowVersion: FLOW_VERSION,
    id: 'native-graph', name: 'Native graph', capabilities: [], nodes: [], edges: [], inputs: [], outputs: [] } });
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('Recipe navigation must not contact a provider'); };
  assert.equal(recipeRun.startRecipe(recipe, availability.readHostSnapshot(useViewerStore.getState())).ok, true);
  render(<RecipeRunCard />);
  const open = button(); assert.ok(open); assert.equal(open.disabled, false);
  click(open);
  assert.equal(useAssistant.getState().snapshot?.source, 'flow');
  assert.equal(recipeRun.useRecipeRun.getState().draftPrompt, recipe.steps[0].kind === 'ask' ? recipe.steps[0].prompt : '');
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'assistant');
  assert.equal(useViewerStore.getState().flowDoc?.id, 'native-graph');
  assert.equal(useAssistant.getState().controller, null);
  assert.equal(requests, 0);
});

test('#6924 a mounted recipe becomes unavailable when its native evidence source disappears', () => {
  assert.ok(recipeRun && availability && RecipeRunCard, 'the native recipe entry point must exist');
  useViewerStore.setState({ chatActiveModel: 'recorded-test-model', flowDoc: null });
  assert.equal(recipeRun.startRecipe({ ...recipe, steps: [{ kind: 'ask', source: 'validation', prompt: 'Explain the native check' }] }, availability.readHostSnapshot(useViewerStore.getState())).ok, true);
  render(<RecipeRunCard />);
  const open = button(); assert.ok(open); assert.equal(open.disabled, true);
  assert.ok(document.body.textContent?.includes('Capture the native evidence'));
  assert.equal(useAssistant.getState().controller, null);
});

test('#6924 a recipe asks before replacing an unsaved discussion and cancellation preserves it', async () => {
  assert.ok(recipeRun && availability && RecipeRunCard, 'the native recipe entry point must exist');
  useViewerStore.setState({ chatActiveModel: 'recorded-test-model', flowDoc: null });
  const messages = [{ role: 'user' as const, content: 'Unsaved discussion' }];
  useAssistant.setState({ snapshot: null, messages, status: 'idle', controller: null });
  assert.equal(recipeRun.startRecipe(recipe, availability.readHostSnapshot(useViewerStore.getState())).ok, true);
  render(<><ConfirmDialogHost /><RecipeRunCard /></>);
  const open = button(); assert.ok(open); click(open);
  await waitFor(() => document.querySelector('[role="alertdialog"]') !== null, 'native switch confirmation');
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(e => e.textContent === 'Cancel');
  assert.ok(cancel); click(cancel);
  assert.equal(useAssistant.getState().messages, messages);
  assert.equal(recipeRun.useRecipeRun.getState().draftPrompt, null);
});

test('#6924 an imported graph step cannot replace a dirty native graph', () => {
  assert.ok(recipeRun && availability && RecipeRunCard, 'the native recipe entry point must exist');
  const graph = { flowVersion: FLOW_VERSION, id: 'saved-recipe-graph', name: 'Saved graph', capabilities: [], nodes: [], edges: [], inputs: [], outputs: [] };
  useViewerStore.setState({ flowDirty: true, savedFlows: [{ doc: graph, updatedAt: Date.now() }] });
  const runRecipe: AssistantRecipe = { ...recipe, steps: [{ kind: 'flow', flowId: graph.id }] };
  assert.equal(recipeRun.startRecipe(runRecipe, availability.readHostSnapshot(useViewerStore.getState())).ok, true);
  render(<RecipeRunCard />);
  const open = button(); assert.ok(open); assert.equal(open.disabled, true);
  assert.ok(document.body.textContent?.includes('Save or close the open Flow graph'));
});
