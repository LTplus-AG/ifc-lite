/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7070: native proposal -> review -> permission/current-value preflight -> export and undo.
 * Fixed provider output measures orchestration, not generation quality. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createRootBudget, runModelRequest } from '@ifc-lite/ai';
import { parseModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { MemoCache, type FlowDocument } from '@ifc-lite/flow';
import { createCheckpoint, parseCheckpoint, approveCheckpoint, claimCheckpoint, updateCheckpoint, resumeOutputs, graphDigest, finishCheckpoint } from '@ifc-lite/flow/checkpoint';
import { type FlowAiService } from '@ifc-lite/flow-nodes/ai';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { seedAuthoringSample, parseIfc, SAMPLE_MODEL } from '@/test/authoring-sample-fixture';
import { previewModelChanges } from '@/lib/actions/model-change-preview';
import { commitModelChanges } from '@/lib/actions/model-change-commit';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { flowRegistry, runFlowInViewer } from './runner';
import { browserCheckpointStore } from './checkpoint-store';
import { viewerSourceDigest } from './review-session';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
test('#7070 a SketchUp wall proposal stays portable and read-only until native approval; exported edits undo together', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 2000 });
  let requests = 0;
  const ai: FlowAiService = { model: 'fixture', request: call => runModelRequest({ model: 'fixture', route: 'test', budget,
    routeCeiling: 2000, maxOutputTokens: call.maxOutputTokens, timeoutMs: 1000, messages: [call.prompt], system: call.system,
    signal: call.signal, transport: async transport => {
      requests++;
      const rows = /<data>\n([\s\S]*)\n<\/data>/.exec(call.prompt)![1].split('\n').map(line => JSON.parse(line) as { key: string; values: { GlobalId: string; Name: string } });
      const row = rows[0];
      const text = JSON.stringify({ artifact: { version: 1, kind: 'model.changes', title: 'Reviewed rename', changes: [
        { op: 'attribute.set', target: { globalId: row.values.GlobalId }, name: 'Name', expected: row.values.Name, value: 'Reviewed wall' },
      ] }, citations: [row.key] });
      transport.onChunk(text); transport.onFinishReason('stop'); transport.onComplete(text);
    } }) };
  const doc: FlowDocument = { flowVersion: 2, id: 'real-wall-proposal', name: 'Real wall proposal', capabilities: ['model.read', 'network.ai'], inputs: [], outputs: [],
    nodes: [{ id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
      { id: 'findings', type: 'table.fromEntities', params: { columns: ['Name'] } },
      { id: 'draft', type: 'ai.propose', params: { instructions: 'Rename the first wall', columns: ['GlobalId', 'Name'], maxRows: 1,
        fields: [{ op: 'attribute.set', name: 'Name', expectedColumn: 'Name', allowedValues: ['Reviewed wall'] }] } }],
    edges: [{ from: ['walls', 'entities'], to: ['findings', 'entities'] }, { from: ['findings', 'table'], to: ['draft', 'table'] }] };
  const result = await runFlowInViewer({ doc, bim, pin: SAMPLE_MODEL, cache: new MemoCache(), ai });
  assert.equal(result.ok, true, JSON.stringify(result.reports));
  assert.deepEqual(result.review, ['draft']); assert.equal(requests, 1);
  assert.equal(useViewerStore.getState().dirtyModels.size, 0, 'drafting performs no mutations');
  const checkpoint = parseCheckpoint(JSON.parse(JSON.stringify(createCheckpoint({ doc, registry: flowRegistry(), result, sourceDigest: viewerSourceDigest(), budget }))));
  assert.equal(checkpoint.state, 'prepared');
  assert.deepEqual(checkpoint.budget, budget);
  assert.equal(await browserCheckpointStore.write(checkpoint, null), true);
  assert.throws(() => resumeOutputs(checkpoint), /actively claimed/);
  await updateCheckpoint(browserCheckpointStore, checkpoint.id, current => approveCheckpoint(current, checkpoint.proposalDigest));
  const reviewed = (await browserCheckpointStore.read(checkpoint.id))!;
  assert.throws(() => claimCheckpoint(reviewed.checkpoint, { owner: 'test', graphDigest: checkpoint.graphDigest,
    sourceDigest: 'changed-revision', leaseMs: 60_000 }), /changed after review/);
  const claim = await updateCheckpoint(browserCheckpointStore, checkpoint.id, current => claimCheckpoint(current, {
    owner: 'test', graphDigest: graphDigest(doc, {}, flowRegistry()), sourceDigest: viewerSourceDigest(), leaseMs: 60_000,
  }));
  const resume = resumeOutputs(claim);
  assert.throws(() => resumeOutputs(claim), /already supplied/);
  const continued = await runFlowInViewer({ doc, bim, pin: SAMPLE_MODEL, cache: new MemoCache(), resume });
  assert.equal(continued.ok, true, JSON.stringify(continued.reports));
  assert.equal(requests, 1, 'replaying the approved artifact spends no second request');
  await updateCheckpoint(browserCheckpointStore, checkpoint.id, current => finishCheckpoint(current, 'test', { ok: true }));
  await assert.rejects(() => updateCheckpoint(browserCheckpointStore, checkpoint.id, current => claimCheckpoint(current, {
    owner: 'again', graphDigest: checkpoint.graphDigest, sourceDigest: checkpoint.sourceDigest, leaseMs: 60_000,
  })), /reviewed/);
  const proposal = checkpoint.outputs.draft.proposal; assert.equal(proposal.kind, 'item');
  if (proposal.kind !== 'item') throw new Error('Missing native proposal');
  const batch = parseModelChangeBatch(JSON.stringify((proposal.value as { artifact: unknown }).artifact));
  const change = batch.changes[0]; assert.equal(change.op, 'attribute.set');
  if (change.op !== 'attribute.set') throw new Error('Wrong proposal operation');
  const wall = dataStore.entities.getExpressIdByGlobalId(change.target.globalId); assert.ok(wall);
  assert.equal(dataStore.entities.getName(wall), change.expected, 'captured expected value comes from the real IFC');
  useViewerStore.setState({ editEnabled: false });
  assert.equal(previewModelChanges(useViewerStore.getState(), batch).rows[0].status, 'denied');
  useViewerStore.setState({ editEnabled: true });
  const preview = previewModelChanges(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready');
  const committed = commitModelChanges(useViewerStore, preview, new Set([0]), 'test'); assert.ok(committed.ok);
  assert.equal(committed.receipt.applied.length, 1);
  assert.equal(previewModelChanges(useViewerStore.getState(), batch).rows[0].status, 'conflict', 'replaying captured old values is stale');
  const exported = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(exported.entities.getName(exported.entities.getExpressIdByGlobalId(change.target.globalId)!), 'Reviewed wall');
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const undone = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(undone.entities.getName(undone.entities.getExpressIdByGlobalId(change.target.globalId)!), change.expected);
});
