/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoCache, migrateFlowDocument, validateFlowDocument, type FlowDocument } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { columnGraph, openFlowSample, runOpenFlow, sampleColumns } from '@/test/flow-sample-fixture';
import { captureEvidence } from '../evidence';
import { useAssistant, replaceEvidence } from '../conversation';
import { applyFlowCreateProposal } from '../flow-create';
import { preflightOpenFlow } from '../flow-preflight';
import { flowToJson, loadSavedFlows } from '@/lib/flow/persistence';
import { assistantRecipeLibrary, useAssistantRecipes, exportRecipeBundle, parseRecipeBundle, importRecipeBundle } from './recipe-library';
import { projectScope, savePreferences } from './preferences';
import { captureWorkflowIntent, proposeWorkflowFlow, saveWorkflowRecipe } from './workflow-flow';

const initial = useViewerStore.getState();
const assistantInitial = useAssistant.getState();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; localStorage.clear(); useViewerStore.setState(initial, true); useAssistant.setState(assistantInitial, true); });
function conversation() {
  replaceEvidence(captureEvidence('loadReport'));
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-free' });
  useAssistant.setState({ messages: [{ role: 'user', content: 'Create three columns along X at 0, 4 and 8 metres using the first native storey.' },
    { role: 'assistant', content: 'We can draft that supported operation for review.', model: 'openai/gpt-free' }] });
}
const create = () => ({ version: 1, kind: 'flow.create', ...columnGraph([0, 4, 8]) });
function reply(value: unknown, finish = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } });
}

// Fixed provider output exercises the native compiler, storage and runner;
// it is an integration oracle, not a measurement of model generation quality.
test('#6924 a real-model workflow saves, exports, reloads and reruns through the native graph and tracking path', async () => {
  const model = await openFlowSample(); conversation();
  const existing = useViewerStore.getState().flowDoc!;
  const intent = captureWorkflowIntent('Repeat columns', ['model.authoring']);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return reply(create()); };
  const proposal = await proposeWorkflowFlow(intent, new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual(sampleColumns(model), [], 'generation never mutates the loaded IFC model');
  assert.equal(useViewerStore.getState().flowDoc, existing, 'generation never replaces the open graph');
  assert.equal(useAssistant.getState().budget.requests, 1);
  assert.throws(() => applyFlowCreateProposal(proposal, 'unreviewed'), /Reviewed proposal has changed/);
  const receipt = applyFlowCreateProposal(proposal, proposal.digest);
  assert.deepEqual(sampleColumns(model), [], 'saving never runs the graph');
  assert.equal(useViewerStore.getState().savedFlows.length, 2);
  const metadata = JSON.parse(receipt.created.description!);
  assert.equal(metadata.source, 'loadReport');
  assert.deepEqual(metadata.prompts, intent.prompts);
  assert.deepEqual(metadata.reviewedActionTypes, ['model.authoring']);
  assert.equal(Object.hasOwn(metadata, 'evidence'), false);
  const recipeResult = await saveWorkflowRecipe(intent, receipt.flowId);
  assert.equal(recipeResult.saved, true);
  await assistantRecipeLibrary.restore();
  const recipe = useAssistantRecipes.getState().entries.find(item => item.id === recipeResult.id); assert.ok(recipe);
  const bundle = exportRecipeBundle([recipe], useViewerStore.getState().savedFlows.map(flow => flow.doc)); assert.ok(bundle.ok);
  const parsedBundle = parseRecipeBundle(bundle.json); assert.ok(parsedBundle.ok);
  const exported = flowToJson(receipt.created);
  const persisted = loadSavedFlows().find(flow => flow.doc.id === receipt.flowId); assert.ok(persisted);
  assert.deepEqual(persisted.doc, JSON.parse(exported));
  useViewerStore.setState({ editEnabled: false });
  assert.ok((await preflightOpenFlow()).problems.some(problem => problem.labelKey === 'flowAssistant.preflightDeniedEditMode'), 'missing native edit permission denies the run');
  assert.deepEqual(sampleColumns(model), []);
  useViewerStore.setState({ editEnabled: true, flowDoc: persisted.doc, activeFlowId: persisted.doc.id });
  assert.deepEqual((await preflightOpenFlow()).problems, []);
  assert.equal((await runOpenFlow(model, new MemoCache())).ok, true);
  assert.equal(sampleColumns(model).length, 3, 'native builder materializes the described columns');
  const owned = sampleColumns(model);
  useViewerStore.setState({ flowDoc: persisted.doc, flowDirty: false, flowRunning: false });
  assert.equal((await runOpenFlow(model, new MemoCache())).ok, true);
  assert.deepEqual(sampleColumns(model), owned, 'reload and rerun preserve tracking instead of duplicating columns');
  const imported = migrateFlowDocument(JSON.parse(exported));
  assert.deepEqual(validateFlowDocument(imported), []);
  const importedId = useViewerStore.getState().importFlow(imported as FlowDocument);
  assert.ok(importedId); assert.notEqual(importedId, receipt.flowId, 'native import gives a collided workflow its own identity');
  assert.equal(useViewerStore.getState().flowDoc?.description, receipt.created.description);
  const recipeImport = await importRecipeBundle(parsedBundle.bundle, doc => useViewerStore.getState().importFlow(doc));
  assert.equal(recipeImport.saved, true);
  const step = recipeImport.recipes[0].steps[0]; assert.equal(step.kind, 'flow');
  if (step.kind !== 'flow') throw new Error('Expected native graph step');
  assert.notEqual(step.flowId, receipt.flowId);
  assert.equal(useViewerStore.getState().savedFlows.find(flow => flow.doc.id === step.flowId)?.doc.description, receipt.created.description);
});

test('#6924 workflow compilation refuses unsupported or truncated replies and unselected model effects', async () => {
  await openFlowSample(); conversation();
  const intent = captureWorkflowIntent('Review columns', []);
  globalThis.fetch = async () => reply({ kind: 'clarification', message: 'This action needs a native contract.' });
  await assert.rejects(proposeWorkflowFlow(intent, new AbortController().signal), /needs a native contract/);
  globalThis.fetch = async () => reply(create());
  await assert.rejects(proposeWorkflowFlow(intent, new AbortController().signal), /no model action type/);
  globalThis.fetch = async () => reply(create(), 'length');
  await assert.rejects(proposeWorkflowFlow(intent, new AbortController().signal), /truncated/);
  assert.deepEqual(sampleColumns(await openFlowSample()), []);
});

test('#6924 workflow generation cannot obtain a fresh request pool after its conversation budget is exhausted', async () => {
  await openFlowSample(); conversation();
  const intent = captureWorkflowIntent('Columns', ['model.authoring']);
  const budget = useAssistant.getState().budget;
  budget.requests = budget.maxRequests;
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('An exhausted budget must refuse before the provider'); };
  await assert.rejects(proposeWorkflowFlow(intent, new AbortController().signal), /refused/);
  assert.equal(calls, 0);
});

test('#6924 credential-bearing workflow prompts are refused before they can be exported as a graph', () => {
  conversation();
  useAssistant.setState({ messages: [{ role: 'user', content: 'Use sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' },
    { role: 'assistant', content: 'Ready', model: 'openai/gpt-free' }] });
  assert.throws(() => captureWorkflowIntent('Secret workflow', []), /Remove credentials/);
});

test('#6924 workflow compilation respects the project request ceiling in the shared conversation pool', async () => {
  await openFlowSample(); conversation();
  const scope = projectScope(useViewerStore.getState().models.values()); assert.ok(scope);
  assert.deepEqual(await savePreferences(scope, { maxRequests: 1, outputTokens: 1024 }), { ok: true, saved: true });
  const intent = captureWorkflowIntent('Project columns', ['model.authoring']);
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).maxOutputTokens, 1024);
    return reply(create());
  };
  await proposeWorkflowFlow(intent, new AbortController().signal);
  await assert.rejects(proposeWorkflowFlow(intent, new AbortController().signal), /project.*request budget is exhausted/);
  assert.equal(calls, 1);
});
