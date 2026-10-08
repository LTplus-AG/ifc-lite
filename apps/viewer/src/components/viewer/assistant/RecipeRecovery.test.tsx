/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { FLOW_VERSION } from '@ifc-lite/flow';
import { cleanup, click, render, type, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog';
import { AssistantRecipeIdeas } from '@/components/extensions/AssistantRecipeIdeas';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { AssistantPanel } from './AssistantPanel';
import { ProjectPreferences } from './ProjectPreferences';
import { initialContentStatus } from '@/lib/storage/content-library';
import { useAssistantRecipes } from '@/lib/assistant/reuse/recipe-library';
import { useAssistantPreferences, projectScope, preferencesFor } from '@/lib/assistant/reuse/preferences';
import { useRecipeRun, stopRecipe } from '@/lib/assistant/reuse/recipe-run';
import { useAssistantDraft, setAssistantDraft } from '@/lib/assistant/composer-draft';
import { useAssistant } from '@/lib/assistant/conversation';
import { RecipeLibrary } from './RecipeLibrary';
import { usePreferredModel } from '@/lib/assistant/reuse/preference-hooks';
import { savePreferences } from '@/lib/assistant/reuse/preferences';
import { assistantLibrary } from '@/lib/assistant/library';

const initial = useViewerStore.getState();
const assistantInitial = useAssistant.getState();
afterEach(() => {
  cleanup(); stopRecipe(); setAssistantDraft('');
  useViewerStore.setState(initial, true); useAssistant.setState(assistantInitial, true);
});
const button = (text: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text);
  assert.ok(found, `button ${text}`); return found;
};

test('#7055 Ideas cannot discard a dirty or running graph through its saved-workflow shortcut', () => {
  const saved = { flowVersion: FLOW_VERSION, id: 'saved', name: 'Saved', nodes: [], edges: [], inputs: [], outputs: [], capabilities: [] };
  const edited = { ...saved, id: 'edited', name: 'Unsaved edits' };
  useViewerStore.setState({ flowDoc: edited, activeFlowId: edited.id, flowDirty: true, savedFlows: [{ doc: saved, updatedAt: 1 }] });
  useAssistantRecipes.setState({ entries: [{ version: 1, id: 'recipe', origin: 'imported', revision: 1,
    title: 'Saved workflow', description: '', createdAt: '2026-10-07T00:00:00Z', steps: [{ kind: 'flow', flowId: saved.id }] }] });
  render(<AssistantRecipeIdeas />);
  assert.equal(button('Open in Flow').disabled, true);
  click(button('Open in Flow'));
  assert.equal(useViewerStore.getState().flowDoc, edited);
  act(() => useViewerStore.setState({ flowDirty: false, flowRunning: true }));
  assert.equal(button('Open in Flow').disabled, true);
  act(() => useViewerStore.setState({ flowRunning: false }));
  assert.equal(button('Open in Flow').disabled, false);
  click(button('Open in Flow'));
  assert.equal(useViewerStore.getState().flowDoc?.id, saved.id);
});

test('#7055 backup waits for both new libraries instead of exporting an apparently empty library', async () => {
  await assistantLibrary.initialize();
  useAssistantRecipes.setState({ status: { ...initialContentStatus(), phase: 'loading' } });
  useAssistantPreferences.setState({ status: { ...initialContentStatus(), phase: 'ready' } });
  render(<ContentStorageNotice status={{ ...initialContentStatus(), phase: 'ready' }} retry={async () => true} restore={async () => true} />);
  const backup = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === 'Download library backup');
  assert.ok(backup); assert.equal(backup.disabled, true);
  act(() => {
    useAssistantRecipes.setState({ status: { ...initialContentStatus(), phase: 'ready' } });
    useAssistantPreferences.setState({ status: { ...initialContentStatus(), phase: 'loading' } });
  });
  assert.equal(backup.disabled, true);
  act(() => useAssistantPreferences.setState({ status: { ...initialContentStatus(), phase: 'ready' } }));
  assert.equal(backup.disabled, false);
});

test('#7055 changing between unsaved project scopes clears edits before a native preference save', async () => {
  const first = { ...fixtureModel('first'), sourceFingerprint: 'first-source' };
  const second = { ...fixtureModel('second'), sourceFingerprint: 'second-source' };
  useViewerStore.setState(fixtureModels(first));
  render(<ProjectPreferences />);
  const field = document.querySelector<HTMLTextAreaElement>('textarea'); assert.ok(field);
  type(field, 'Terminology for the first project only');
  assert.equal(field.value, 'Terminology for the first project only');
  act(() => useViewerStore.setState(fixtureModels(second)));
  assert.equal(field.value, '');
  click(button('Save preferences'));
  const scope = projectScope([second]); assert.ok(scope);
  await waitFor(() => preferencesFor(scope) !== null, 'second scope saved natively');
  assert.equal(preferencesFor(scope)?.houseRules, undefined);
  assert.equal(preferencesFor(projectScope([first])), null);
});

test('#7055 a recipe prompt asks before replacing an unsent question and cancellation preserves it', async () => {
  setAssistantDraft('My unsent question');
  useRecipeRun.setState({ draftPrompt: 'Recipe prompt' });
  render(<><ConfirmDialogHost /><AssistantPanel /></>);
  await waitFor(() => document.querySelector('[role="alertdialog"]') !== null, 'replace composer confirmation');
  assert.equal(useAssistantDraft.getState().text, 'My unsent question');
  click(button('Cancel'));
  assert.equal(useAssistantDraft.getState().text, 'My unsent question');
  act(() => useRecipeRun.setState({ draftPrompt: 'Approved recipe prompt' }));
  await waitFor(() => document.querySelector('[role="alertdialog"]') !== null, 'second confirmation');
  click(button('Confirm'));
  await waitFor(() => useAssistantDraft.getState().text === 'Approved recipe prompt', 'approved composer replacement');
});

test('#7055 confirming an earlier recipe prompt cannot overwrite a newer composer edit', async () => {
  setAssistantDraft('Original unsent question');
  useRecipeRun.setState({ draftPrompt: 'Earlier recipe prompt' });
  render(<><ConfirmDialogHost /><AssistantPanel /></>);
  await waitFor(() => document.querySelector('[role="alertdialog"]') !== null, 'composer confirmation');
  act(() => setAssistantDraft('Newer composer edit'));
  click(button('Confirm'));
  await act(async () => { await Promise.resolve(); });
  assert.equal(useAssistantDraft.getState().text, 'Newer composer edit');
});

function PreferredModelHost() { usePreferredModel(); return <span>Project model preference active</span>; }
test('#7055 returning through an unconfigured project reapplies its saved model once', async () => {
  const first = { ...fixtureModel('preferred'), sourceFingerprint: 'preferred-source' };
  const second = { ...fixtureModel('unconfigured'), sourceFingerprint: 'unconfigured-source' };
  const scope = projectScope([first]); assert.ok(scope);
  assert.ok((await savePreferences(scope, { model: 'gpt-6.1-sol' })).ok);
  useViewerStore.setState({ ...fixtureModels(first), chatActiveModel: 'gpt-6-astra' });
  render(<PreferredModelHost />);
  assert.equal(useViewerStore.getState().chatActiveModel, 'gpt-6.1-sol');
  act(() => useViewerStore.getState().setChatActiveModel('gpt-6-astra'));
  assert.equal(useViewerStore.getState().chatActiveModel, 'gpt-6-astra', 'manual selection remains within this visit');
  act(() => useViewerStore.setState(fixtureModels(second)));
  act(() => useViewerStore.setState(fixtureModels(first)));
  assert.equal(useViewerStore.getState().chatActiveModel, 'gpt-6.1-sol', 'native scope change reapplies the saved preference');
});

test('#7055 recipe file import refuses to replace a clean graph while its execution is running', async () => {
  const running = { flowVersion: FLOW_VERSION, id: 'running', name: 'Executing graph', nodes: [], edges: [], inputs: [], outputs: [], capabilities: [] };
  const imported = { ...running, id: 'imported', name: 'Imported graph' };
  const bundle = { format: 'ifc-lite-assistant-recipes', version: 1, exportedAt: '2026-10-07T00:00:00Z', flows: [imported],
    recipes: [{ version: 1, id: 'imported-recipe', origin: 'imported', revision: 1, title: 'Imported recipe', description: '',
      createdAt: '2026-10-07T00:00:00Z', steps: [{ kind: 'flow', flowId: imported.id }] }] };
  useViewerStore.setState({ flowDoc: running, activeFlowId: running.id, flowRunning: true, flowDirty: false });
  render(<RecipeLibrary />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  const file = new File([JSON.stringify(bundle)], 'recipe.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await Promise.resolve(); });
  await waitFor(() => !!document.querySelector('[role="alert"]'), 'running graph import refusal');
  assert.equal(useViewerStore.getState().flowDoc, running);
  assert.equal(useViewerStore.getState().activeFlowId, running.id);
  act(() => useViewerStore.setState({ flowRunning: false }));
  await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await Promise.resolve(); });
  await waitFor(() => useViewerStore.getState().flowDoc?.name === imported.name, 'native import after execution finishes');
  assert.notEqual(useViewerStore.getState().flowDoc?.id, imported.id, 'native import assigns a fresh graph identity');
});
