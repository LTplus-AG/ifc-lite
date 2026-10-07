/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, type, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { useAssistant, replaceEvidence } from '@/lib/assistant/conversation';
import { captureEvidence } from '@/lib/assistant/evidence';
import { useAssistantRecipes } from '@/lib/assistant/reuse/recipe-library';
import { useRequestReceipts } from '@/lib/llm/request-receipts';
import { loadSavedFlows } from '@/lib/flow/persistence';
import { ConversationLibrary } from './ConversationLibrary';
import { WorkflowFlowSave, useWorkflowFlowSave } from './WorkflowFlowSave';

const initial = useViewerStore.getState();
const assistantInitial = useAssistant.getState();
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup(); globalThis.fetch = originalFetch; localStorage.clear();
  useWorkflowFlowSave.setState({ intent: null, proposal: null, receipt: null, error: null });
  useViewerStore.setState(initial, true); useAssistant.setState(assistantInitial, true);
});
const graph = (left = 7) => ({ version: 1, kind: 'flow.create', name: 'Sum', nodes: [
  { id: 'a', type: 'core.number', params: { value: left } }, { id: 'b', type: 'core.number', params: { value: 5 } },
  { id: 'sum', type: 'core.math', params: { op: 'add' } },
], edges: [{ from: ['a', 'value'], to: ['sum', 'a'] }, { from: ['b', 'value'], to: ['sum', 'b'] }], outputs: [{ nodeId: 'sum', port: 'result', label: 'Total' }] });
function seed() {
  replaceEvidence(captureEvidence('loadReport'));
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-free' });
  useAssistant.setState({ messages: [{ role: 'user', content: 'Add seven and five in a reusable graph.' },
    { role: 'assistant', content: 'A native math graph can express that.', model: 'openai/gpt-free' }] });
}
const button = (text: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
  assert.ok(found, `button ${text}`); return found;
};
function provider(value = graph()) {
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
}
function approve() {
  const label = [...document.querySelectorAll('label')].find(item => item.textContent?.startsWith('I reviewed the new graph'));
  const input = label?.querySelector('input'); assert.ok(input); click(input);
}

test('#6924 the native conversation library drafts a graph and requires fresh approval after redrafting', async () => {
  seed(); provider();
  render(<ConversationLibrary />);
  const name = document.querySelector<HTMLInputElement>('#assistant-conversation-name'); assert.ok(name); type(name, 'Reusable sum');
  click(button('Save workflow as Flow'));
  await waitFor(() => document.body.textContent?.includes('Draft workflow graph') === true, 'lazy native workflow review');
  click(button('Draft workflow graph'));
  await waitFor(() => document.body.textContent?.includes('Save reviewed workflow') === true, 'validated graph preview');
  assert.ok(document.body.textContent?.includes('core.math'));
  assert.equal(useViewerStore.getState().savedFlows.length, initial.savedFlows.length);
  assert.equal(button('Save reviewed workflow').disabled, true);
  approve(); assert.equal(button('Save reviewed workflow').disabled, false);
  click(button('Redraft')); provider(graph(8)); click(button('Draft workflow graph'));
  await waitFor(() => document.body.textContent?.includes('Save reviewed workflow') === true, 'second graph preview');
  assert.equal(button('Save reviewed workflow').disabled, true, 'approval cannot carry over to a different graph');
  approve(); click(button('Save reviewed workflow'));
  assert.equal(useViewerStore.getState().flowDoc?.name, 'Reusable sum');
  assert.equal(useViewerStore.getState().flowLastRun, null);
  assert.ok(loadSavedFlows().some(flow => flow.doc.name === 'Reusable sum'));
  await waitFor(() => useAssistantRecipes.getState().entries.some(recipe => recipe.title === 'Reusable sum' && useAssistantRecipes.getState().status.items[recipe.id] === 'saved'), 'native recipe saved for Ideas');
});

test('#6924 a refused native graph save stays visibly in memory and Retry commits it', async () => {
  seed(); provider(); render(<WorkflowFlowSave name="Recoverable workflow" />);
  click(button('Draft workflow graph'));
  await waitFor(() => document.body.textContent?.includes('Save reviewed workflow') === true, 'graph preview');
  approve();
  const refusal = mock.method(localStorage, 'setItem', () => { throw new DOMException('Quota refused', 'QuotaExceededError'); });
  try { click(button('Save reviewed workflow')); }
  finally { refusal.mock.restore(); }
  const id = useViewerStore.getState().activeFlowId; assert.ok(id);
  assert.ok(document.body.textContent?.includes('durable save was refused'));
  assert.equal(loadSavedFlows().some(flow => flow.doc.id === id), false);
  click(button('Retry save'));
  assert.equal(loadSavedFlows().some(flow => flow.doc.id === id), true);
  assert.equal(useViewerStore.getState().flowStorageError, null);
  assert.ok(!document.body.textContent?.includes('durable save was refused'));
  await waitFor(() => useAssistantRecipes.getState().entries.some(recipe => recipe.title === 'Recoverable workflow' && useAssistantRecipes.getState().status.items[recipe.id] === 'saved'), 'reusable library save settled');
});

test('#6924 cancelling a workflow request leaves no graph or late review candidate', async () => {
  seed(); let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  render(<WorkflowFlowSave name="Cancelled graph" />);
  click(button('Draft workflow graph'));
  await waitFor(() => calls === 1, 'request started');
  click(button('Cancel'));
  await waitFor(() => document.body.textContent?.includes('Workflow generation cancelled.') === true, 'cancelled request');
  await act(async () => { await Promise.resolve(); });
  assert.equal(useWorkflowFlowSave.getState().proposal, null);
  assert.equal(useViewerStore.getState().savedFlows.length, initial.savedFlows.length);
});

test('#6924 a refused Ideas recipe write remains recoverable while its native graph is saved', async () => {
  seed(); provider(); render(<WorkflowFlowSave name="Recipe recovery" />);
  click(button('Draft workflow graph'));
  await waitFor(() => document.body.textContent?.includes('Save reviewed workflow') === true, 'graph preview');
  approve();
  const refusal = mock.method(IDBDatabase.prototype, 'transaction', () => { throw new DOMException('Storage refused', 'SecurityError'); });
  try {
    click(button('Save reviewed workflow'));
    await waitFor(() => document.body.textContent?.includes('recipe for Ideas remains in memory') === true, 'refused recipe status');
  } finally { refusal.mock.restore(); }
  const id = useWorkflowFlowSave.getState().recipeId; assert.ok(id);
  assert.equal(useAssistantRecipes.getState().status.items[id], 'unavailable');
  assert.ok(loadSavedFlows().some(flow => flow.doc.name === 'Recipe recovery'), 'graph storage is independently durable');
  click(button('Retry recipe save'));
  await waitFor(() => useAssistantRecipes.getState().status.items[id] === 'saved', 'native recipe retry committed');
  assert.ok(!document.body.textContent?.includes('recipe for Ideas remains in memory'));
});

test('#6924 a cancelled request from an earlier host cannot overwrite a later workflow review', async () => {
  seed();
  let resolveFirst: ((response: Response) => void) | undefined;
  let calls = 0;
  const response = (left: number) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(graph(left)) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return await new Promise<Response>(resolve => { resolveFirst = resolve; });
    return response(8);
  };
  render(<WorkflowFlowSave name="Earlier host" />); click(button('Draft workflow graph'));
  await waitFor(() => resolveFirst !== undefined, 'earlier request started');
  cleanup();
  render(<WorkflowFlowSave name="Later host" />); click(button('Draft workflow graph'));
  await waitFor(() => useWorkflowFlowSave.getState().proposal !== null, 'later graph review');
  const later = useWorkflowFlowSave.getState().proposal;
  await act(async () => { resolveFirst!(response(7)); });
  await waitFor(() => useRequestReceipts.getState().inFlight.length === 0, 'both requests settled');
  assert.equal(useWorkflowFlowSave.getState().proposal, later);
  assert.equal(useWorkflowFlowSave.getState().error, null);
  assert.equal(JSON.parse(later!.docJson).name, 'Later host');
});
