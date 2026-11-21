/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { buildLoadReport } from '@/lib/loadReport';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { beforeEach, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { ToolErrorCode } from '@ifc-lite/mcp/browser';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef, clearGlobalRefs } from '@/hooks/useBCF';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { attachCoordinationModelAdder } from '@/services/coordination-loader';
import { flowToJson } from '@/lib/flow/persistence';
import { resetFeaturesForTest } from '@/lib/features';
import { readBCF } from '@ifc-lite/bcf';
import type { FlowDocument, RunResult } from '@ifc-lite/flow';
import { registerMountedFileHost } from '@/components/viewer/toolbar/mounted-file-host';
import { setCollabEnabledOverride } from '@/lib/collab/config';
import { useCollabShareReview } from '@/lib/collab/share-review';
import { connectPeer, reviewedBatch } from '@/test/bcf-publication-fixture';
import { deferred } from '@/test/race';
import { act, createElement } from 'react';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { BCFPublicationPanel } from '@/components/viewer/bcf/BCFPublicationPanel';
import { bcfDraftLibrary, saveDraftBatch } from '@/lib/bcf-drafts/draft-library';
import { initializeBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import { useBcfPublicationReview, type BcfPublicationReview } from '@/lib/bcf-publication/review-candidate';
import { loadBcfServerConfig, saveBcfServerConfig } from '@/services/bcf-server';
import { LocalBackend } from '@/sdk/local-backend';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { useViewerStore } from '@/store';
import { createMainViewerToolHost } from '../main-viewer-host';
import type { OperationContext } from './contract';
import { coordinationOperations } from './coordination-index';
import { operationArtifacts, readArtifact, type ArtifactMetadata } from './artifacts';
let context: OperationContext;
let allowed = true;
const checkpoint = () => { if (!allowed) throw new Error('Operation grant revoked'); };
const commit = <T>(write: () => T) => { checkpoint(); return write(); };
async function execute<T>(id: string, input: unknown = {}): Promise<T> {
  const op = coordinationOperations.find(op => op.id === id); assert.ok(op, id);
  op.validate(input); const result = await op.execute(input, context); op.validateResult(result); return result as T;
}
beforeEach(async () => {
  allowed = true; resetFeaturesForTest(); clearGlobalRefs(); await seedCoincidentWalls(1, 4);
  useViewerStore.setState({ bcfProject: null, mutationVersion: 0, mutationViews: new Map() });
  const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  const model = host.models()[0]; if (!model?.store) throw new Error('Fixture IFC store missing.');
  context = { host, model: { ...model, store: model.store }, commit, commitAsync: async write => { checkpoint(); return write(); }, ownGeometry: async work => work(), retain: () => {}, checkpoint, artifacts: operationArtifacts(host, commit) };
});
it('round-trips authored BCF topics/comments through native ZIP writer and reader (#10525)', async () => {
  await execute('bcf.createProject', { value: 'Coordination evidence' });
  const topic = await execute<{ guid: string }>('bcf.createTopic', { title: 'Wall coordination', description: 'Review the four fixture walls', status: 'Open' });
  const comment = await execute<{ guid: string }>('bcf.comment', { id: topic.guid, comment: 'Initial observation' });
  await execute('bcf.updateComment', { topic_id: topic.guid, comment_id: comment.guid, expected_comment: 'Initial observation', comment: 'Verify physical separation' });
  await assert.rejects(execute('bcf.updateComment', { topic_id: topic.guid, comment_id: comment.guid, expected_comment: 'Initial observation', comment: 'Stale overwrite' }), {
    code: ToolErrorCode.STATE_CHANGED, details: { reason: 'stale' }, message: /comment changed/,
  });
  const exported = await execute<ArtifactMetadata>('bcf.export');
  assert.ok(exported.bytes > 0);
  const chunk = await readArtifact(context.host, exported.artifact_id, 0, 65536);
  const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0));
  const restored = await readBCF(bytes);
  assert.equal(restored.topics.size, 1);
  assert.equal(restored.topics.get(topic.guid)?.title, 'Wall coordination');
  assert.equal(restored.topics.get(topic.guid)?.comments[0].comment, 'Verify physical separation');
  const currentId = useViewerStore.getState().bcfProject?.projectId ?? '';
  await execute('bcf.import', { base64: chunk.data, replace_project_id: currentId });
  assert.equal(useViewerStore.getState().bcfProject?.topics.get(topic.guid)?.comments[0].comment, 'Verify physical separation');
  await assert.rejects(execute('bcf.import', { base64: chunk.data, replace_project_id: 'stale-project' }), /project changed/);
  await assert.rejects(execute('bcf.comment', { id: 'missing', comment: 'No phantom issue' }), {
    code: ToolErrorCode.INVALID_INPUT, details: { reason: 'unknown-target' }, message: /does not exist/,
  });
  // A base64-looking string may still fail to decode (#10871).
  await assert.rejects(execute('bcf.import', { base64: 'a', replace_project_id: currentId }), {
    code: ToolErrorCode.INVALID_INPUT, details: { reason: 'invalid-value' },
  });
});
it('refuses a revoked native BCF commit and duplicate project replacement (#10525)', async () => {
  allowed = false;
  await assert.rejects(execute('bcf.createProject', { value: 'Forbidden' }), /grant revoked/);
  assert.equal(useViewerStore.getState().bcfProject, null);
  allowed = true; await execute('bcf.createProject', { value: 'Preserve' });
  await assert.rejects(execute('bcf.createProject', { value: 'Replace' }), {
    code: ToolErrorCode.UNSUPPORTED_OPERATION, details: { reason: 'unavailable' }, message: /already open/,
  });
  assert.equal(useViewerStore.getState().bcfProject?.name, 'Preserve');
});
it('runs the native count graph against real parsed IFC walls and refuses side-effect nodes (#10525)', async () => {
  const doc: FlowDocument = { flowVersion: 1, id: 'count-walls', name: 'Count walls', inputs: [], capabilities: ['model.read'],
    outputs: [{ nodeId: 'count', port: 'count', label: 'Walls' }], nodes: [
      { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' }, pos: [0, 0] },
      { id: 'count', type: 'core.count', pos: [300, 0] },
    ], edges: [{ from: ['walls', 'entities'], to: ['count', 'items'] }] };
  useViewerStore.getState().setFlowDoc(doc);
  const { result } = await execute<{ result: RunResult }>('flow.analyze');
  assert.equal(result.ok, true); assert.equal(result.writes, 0);
  const count = result.graphOutputs[0].data; assert.equal(count?.kind, 'item');
  assert.ok(count && count.kind === 'item'); assert.equal(count.value, 4);
  assert.ok(result.reports.every(report => report.status === 'ok'));
  const detach = attachCoordinationModelAdder(async () => { throw new Error('Count graph must not load another model.'); });
  try {
    const outcome = await execute<{ state: string; result: RunResult }>('flow.run', { expected_json: flowToJson(doc), inputs_json: '{}', resume_checkpoint_id: '', target_model_id: useViewerStore.getState().activeModelId ?? '', expected_mutation_version: useViewerStore.getState().mutationVersion, expected_geometry_version: useViewerStore.getState().geometryContentVersion });
    assert.equal(outcome.state, 'completed'); assert.equal(outcome.result.writes, 0);
    const count = outcome.result.graphOutputs[0].data; assert.ok(count && count.kind === 'item'); assert.equal(count.value, 4);
  } finally { detach(); }

  useViewerStore.getState().setFlowDoc({ ...doc, nodes: [...doc.nodes, { id: 'write', type: 'script.run', pos: [600, 0] }] });
  await assert.rejects(execute('flow.analyze'), /only core\/model\/table reads/);
});
it('delivers Flow node outputs and group branches through the JSON boundary (#10591 r4653276103)', async () => {
  const doc: FlowDocument = { flowVersion: 1, id: 'wire-outputs', name: 'Grouped outputs', inputs: [], capabilities: ['model.read'],
    outputs: [{ nodeId: 'group', port: 'group', label: 'By type' }], nodes: [
      { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' }, pos: [0, 0] },
      { id: 'group', type: 'model.groupByType', pos: [300, 0] },
      { id: 'number', type: 'core.number', params: { value: 42 }, pos: [0, 200] },
    ], edges: [{ from: ['walls', 'entities'], to: ['group', 'entities'] }] };
  useViewerStore.getState().setFlowDoc(doc);
  const detach = attachCoordinationModelAdder(async () => null);
  try {
    const s = useViewerStore.getState();
    const replies = [await execute('flow.analyze'), await execute('flow.run', {
      expected_json: flowToJson(doc), inputs_json: '{}', resume_checkpoint_id: '', target_model_id: s.activeModelId,
      expected_mutation_version: s.mutationVersion, expected_geometry_version: s.geometryContentVersion,
    }), await execute('flow.read')];
    for (const reply of replies) {
      const { result } = JSON.parse(JSON.stringify(reply));
      assert.equal(result.ok, true);
      assert.deepEqual(result.outputs.number.value, { kind: 'item', value: 42 });
      const grouped = result.outputs.group.group;
      assert.equal(grouped.kind, 'group');
      assert.equal(grouped.branches[0][0], 'IfcWall');
      assert.equal(grouped.branches[0][1].length, 4);
      assert.deepEqual(result.graphOutputs[0].data, grouped);
    }
  } finally { detach(); }
});

it('refuses replacement of the exact open extension contribution (#10591 r4653276107)', async () => {
  const doc: FlowDocument = { flowVersion: 1, id: 'ext:example:review', name: 'Contributed', nodes: [], edges: [], inputs: [], outputs: [], capabilities: [] };
  useViewerStore.getState().openContributedFlow(doc);
  await assert.rejects(execute('flow.replaceDocument', {
    expected_json: flowToJson(doc), document_json: flowToJson({ ...doc, name: 'Modified' }),
  }), /read-only/);
  assert.equal(useViewerStore.getState().flowDoc, doc);
});

it('refuses a Flow run if its admitted default changes during preflight (#10591 r4653276133)', async () => {
  await seedCoincidentWalls(2, 4);
  const doc: FlowDocument = { flowVersion: 1, id: 'default-model', name: 'Find walls', inputs: [], outputs: [], capabilities: ['model.read'],
    nodes: [{ id: 'walls', type: 'model.byType', params: { type: 'IfcWall' }, pos: [0, 0] }], edges: [] };
  useViewerStore.getState().setFlowDoc(doc);
  const s = useViewerStore.getState();
  const detach = attachCoordinationModelAdder(async () => null);
  const unsubscribe = useViewerStore.subscribe((state, previous) => {
    if (state.flowRunning && !previous.flowRunning) queueMicrotask(() => useViewerStore.getState().setActiveModel('B'));
  });
  try {
    const outcome = await execute<{ state: string; error: string; result: unknown }>('flow.run', {
      expected_json: flowToJson(doc), inputs_json: '{}', resume_checkpoint_id: '', target_model_id: s.activeModelId,
      expected_mutation_version: s.mutationVersion, expected_geometry_version: s.geometryContentVersion,
    });
    assert.equal(outcome.state, 'failed');
    assert.match(outcome.error, /default model changed/);
    assert.equal(outcome.result, null);
  } finally { unsubscribe(); detach(); }
});

it('keeps Flow approval resumable if the default model changes during the claim (#10591)', async t => {
  const { NativeFlowRunner } = await import('@/lib/flow/native-runner');
  const { approveReview, useFlowReview } = await import('@/lib/flow/review-session');
  const { browserCheckpointStore } = await import('@/lib/flow/checkpoint-store');
  const { flowRegistry } = await import('@/lib/flow/runner');
  await seedCoincidentWalls(2, 4);
  const before = useFlowReview.getState();
  const modelId = useViewerStore.getState().activeModelId;
  assert.equal(modelId, 'A');
  const bim = context.host.bim;
  assert.ok(bim);
  const runner = new NativeFlowRunner(bim, async () => null);
  const scalar = { kind: 'scalar', access: 'item' } as const;
  const consumed: unknown[] = [];
  flowRegistry().registerAll([
    { type: 'test.reviewClaim', title: 'Proposal', category: 'test', inputs: [], outputs: [{ name: 'value', type: scalar }],
      params: [], capabilities: [], review: 'required', run: () => ({ value: 42 }) },
    { type: 'test.consumeClaim', title: 'Consume proposal', category: 'test', inputs: [{ name: 'value', type: scalar }], outputs: [],
      params: [], capabilities: [], run: (_context, input) => { consumed.push(input.value); return {}; } },
  ]);
  const doc: FlowDocument = { flowVersion: 1, id: 'interrupted-review-claim', name: 'Review before consuming', inputs: [], outputs: [], capabilities: [],
    nodes: [{ id: 'proposal', type: 'test.reviewClaim', pos: [0, 0] }, { id: 'sink', type: 'test.consumeClaim', pos: [300, 0] }],
    edges: [{ from: ['proposal', 'value'], to: ['sink', 'value'] }] };
  useViewerStore.getState().setFlowDoc(doc);
  try {
    const paused = await runner.run();
    assert.equal(paused.state, 'paused', paused.error ?? 'the workflow pauses for approval');
    assert.ok(paused.checkpoint);
    const reviewed = await approveReview(paused.checkpoint.proposalDigest, doc);
    assert.ok(reviewed);
    const write = browserCheckpointStore.write;
    const switchDuringClaim = t.mock.method(browserCheckpointStore, 'write', async (...args: Parameters<typeof write>) => {
      const saved = await write(...args);
      if (saved && args[0].state === 'applying') useViewerStore.getState().setActiveModel('B');
      return saved;
    });
    const refused = await runner.run({}, { resume: reviewed, expectedDefaultModelId: modelId });
    switchDuringClaim.mock.restore();
    assert.equal(refused.state, 'failed');
    assert.match(refused.error ?? '', /default model changed while claiming/);
    assert.deepEqual(consumed, []);
    assert.equal(useFlowReview.getState().checkpoint?.state, 'reviewed');
    const stored = (await browserCheckpointStore.read(reviewed.id))?.checkpoint;
    assert.equal(stored?.state, 'reviewed');
    assert.deepEqual(stored.review, reviewed.review);
    assert.equal(stored.claim, undefined);

    useViewerStore.getState().setActiveModel(modelId);
    const resumed = await runner.run({}, { resume: stored, expectedDefaultModelId: modelId });
    assert.equal(resumed.state, 'completed', resumed.error ?? 'the workflow resumes after restoring the default model');
    assert.deepEqual(consumed, [42]);
  } finally {
    useViewerStore.getState().setActiveModel(modelId);
    useFlowReview.setState(before, true);
  }
});

it('restores a codec-exported semantic workspace beyond the graph input limit (#10591 r4653276123)', async t => {
  const { useSemanticSession } = await import('@/lib/semantic/session');
  const before = useSemanticSession.getState();
  const storageKey = 'ifc-lite.semantic.workspace.v1';
  const savedWorkspace = localStorage.getItem(storageKey);
  t.after(() => assert.ok(localStorage.getItem(storageKey) === savedWorkspace, 'the test restores the persisted workspace'));
  const graph = '#' + 'x'.repeat(999_999);
  try {
    await execute('semantic.graph', { value: graph });
    const workspace = useSemanticSession.getState().save();
    assert.ok(workspace.length > 1_000_000);
    await execute('semantic.graph', { value: '' });
    await execute('semantic.restoreWorkspace', { value: workspace });
    assert.equal(useSemanticSession.getState().graph, graph);
  } finally {
    useSemanticSession.setState(before, true);
    if (savedWorkspace === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, savedWorkspace);
  }
});

it('refuses georeference realignment before clearing a workflow-owned federation (#10591 r4653276144)', async () => {
  const { startWorkflowRun } = await import('@/lib/flow/run-session');
  await seedCoincidentWalls(2);
  const s = useViewerStore.getState();
  const models = new Map([...s.models].map(([id, model]) => [id, { ...model, sourceFile: new File(['ifc'], model.name) }]));
  useViewerStore.setState({ models });
  let reloads = 0;
  const detach = attachCoordinationModelAdder(async () => { reloads++; return null; });
  const workflow = startWorkflowRun();
  try {
    await assert.rejects(execute('georeference.realign', {
      expected_model_ids: [...models.keys()], expected_mutation_version: s.mutationVersion, expected_geometry_version: s.geometryContentVersion,
    }), /workflow is running/);
    assert.equal(useViewerStore.getState().models, models);
    assert.equal(reloads, 0);
  } finally { workflow.release(); detach(); }
});

it('posts a staged layer comment to its original entity after selection changes (#10591 r4653276099)', async () => {
  const { LayerReviewSection } = await import('@/components/viewer/layers/LayerReviewSection');
  const { useLayerAutomationReview } = await import('@/lib/layers/automation-review');
  const before = useViewerStore.getState();
  useViewerStore.setState({ selectedEntityId: 1, layerStackPathToId: new Map([['entity-A', 1], ['entity-B', 2]]) });
  useLayerAutomationReview.setState({ candidate: {
    id: 'staged-layer-comment-test', candidateId: 'candidate', refName: 'main', action: 'comment', entity: 'entity-A',
    title: 'Check wall A', description: 'Review note', withViewpoint: false,
  } });
  const posted: string[] = [];
  const client = {
    listReviews: async () => ({ reviews: [{ id: 'review', layerId: 'candidate', into: 'main', status: 'open', topics: [] }] }),
    postTopic: async (_review: string, topic: { entity: string }) => { posted.push(topic.entity); return { guid: 'topic' }; },
  } as unknown as Parameters<typeof LayerReviewSection>[0]['client'];
  try {
    const container = render(createElement(LayerReviewSection, { client, candidateId: 'candidate', refName: 'main' }));
    const commentButton = () => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Comment');
    await waitFor(() => commentButton()?.disabled === false, 'staged comment is ready');
    act(() => useViewerStore.setState({ selectedEntityId: 2 }));
    click(commentButton()!);
    await waitFor(() => posted.length > 0, 'comment reaches the registry');
    assert.deepEqual(posted, ['entity-A']);
  } finally {
    cleanup();
    useLayerAutomationReview.setState({ candidate: null });
    useViewerStore.setState({ selectedEntityId: before.selectedEntityId, layerStackPathToId: before.layerStackPathToId });
  }
});

it('exports real per-model diagnostic evidence and preserves explicit unknown coverage (#10525)', async () => {
  const artifact = await execute<ArtifactMetadata>('loadReport.export');
  const read = await readArtifact(context.host, artifact.artifact_id, 0, 65536);
  const report = JSON.parse(atob(read.data)) as { models: Array<{ modelId: string; diagnosticsAvailable: boolean }> };
  assert.equal(report.models.length, 1); assert.equal(report.models[0].modelId, 'A');
  // The export carries the native report's own value; a fixture without diagnostics stays false, never rounded up to true.
  const native = buildLoadReport(useViewerStore.getState().models.get('A')!);
  assert.equal(native.diagnosticsAvailable, false); assert.equal(report.models[0].diagnosticsAvailable, false);
});
it('rejects undeclared parameters for every coordination operation (#10525)', () => {
  // Missing required fields would also throw, so check the closed schema itself.
  for (const op of coordinationOperations) assert.equal((op.inputSchema as { additionalProperties?: unknown }).additionalProperties, false, op.id);
});

it('script operations expose native storage failure instead of claiming durability (#10525)', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } } });
  try {
    const created = await execute<{ id: string; storage: { ok: boolean; reason: string } }>('script.create', { name: 'Quota fixture', source: 'console.log(1)' });
    assert.ok(created.id); assert.equal(created.storage.ok, false); assert.equal(created.storage.reason, 'quota_exceeded');
    const saved = await execute<{ dirty: boolean; storage: { ok: boolean } }>('script.save'); assert.equal(saved.storage.ok, false);
    assert.equal(saved.dirty, true, 'a refused save leaves the edits unsaved');
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

it('script create and delete refuse to drop the active script\'s unsaved edits (#10591 review)', async () => {
  useViewerStore.setState({ scriptEditorDirty: false });
  const first = await execute<{ id: string }>('script.create', { name: 'Dirty fixture', source: '1' });
  useViewerStore.setState({ scriptEditorContent: 'edited', scriptEditorDirty: true });
  await assert.rejects(execute('script.create', { name: 'Second', source: '2' }), /unsaved edits/);
  useViewerStore.setState({ scriptEditorDirty: false });
  const second = await execute<{ id: string }>('script.create', { name: 'Second', source: '2' });
  useViewerStore.setState({ scriptEditorContent: 'edited 2', scriptEditorDirty: true });
  await assert.rejects(execute('script.delete', { id: first.id }), /unsaved edits/);
  assert.equal(useViewerStore.getState().scriptEditorDirty, true);
  await execute('script.delete', { id: second.id });
  assert.ok(!useViewerStore.getState().savedScripts.some(script => script.id === second.id));
});

it('an unsaved draft with no saved script can be kept through script.create (#10591 review)', async () => {
  useViewerStore.setState({ activeScriptId: null, scriptEditorContent: 'draft', scriptEditorDirty: true });
  await assert.rejects(execute('script.create', { name: 'Other', source: 'other' }), /unsaved draft/);
  const kept = await execute<{ id: string }>('script.create', { name: 'Kept draft', source: 'draft' });
  assert.equal(useViewerStore.getState().savedScripts.find(script => script.id === kept.id)?.code, 'draft');
});

it('viewer contracts create and export BCF/Flow without any IFC model (#10525)', async () => {
  useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null, geometryResult: null });
  const call = (operation_id: string, input: unknown = {}) => dispatchMainViewerTool(context.host, 'viewer_operation_execute', { operation_id, input }, { canEdit: () => true });
  const created = await call('bcf.createProject', { value: 'Before loading IFC' }); assert.equal(created.isError, false, created.text);
  const exported = await call('bcf.export'); assert.equal(exported.isError, false, exported.text);
  const reports = await call('loadReport.read'); assert.equal(reports.isError, false, reports.text);
  const flow = await call('flow.create', { value: 'Empty workflow' }); assert.equal(flow.isError, false, flow.text);
  assert.equal(context.host.models().length, 0);
  const describe = await dispatchMainViewerTool(context.host, 'viewer_operations', { operation_id: 'bcf.createProject' });
  assert.equal(describe.isError, false, describe.text);
  const description = describe.structured as { operations: Array<{ needs: string }> }; assert.equal(description.operations[0].needs, 'viewer');
  const incorrectlyTargeted = await dispatchMainViewerTool(context.host, 'viewer_operation_execute', { model_id: 'A', operation_id: 'bcf.read', input: {} });
  assert.equal(incorrectlyTargeted.isError, true);
});
it('native viewpoint operations restore real parsed entity selection and camera without a mounted panel (#10525)', async () => {
  const camera = new Camera(); camera.setPosition(12, 8, 20); camera.setTarget(0, 0, 0); camera.setAspect(16 / 9);
  const renderer = { getCamera: () => camera } as unknown as Renderer; setGlobalRendererRef({ current: renderer });
  try {
    await execute('bcf.createProject', { value: 'Viewpoints' });
    const topic = await execute<{ guid: string }>('bcf.createTopic', { title: 'Selected walls', description: '', status: 'Open' });
    useViewerStore.getState().setSelectedEntityIds([1, 2]);
    const captured = await execute<{ viewpoint: { guid: string } }>('bcf.captureViewpoint', { topic_id: topic.guid, snapshot: false, selection: true, visibility: false });
    useViewerStore.getState().clearEntitySelection(); camera.setPosition(1, 1, 1);
    await execute('bcf.applyViewpoint', { topic_id: topic.guid, viewpoint_id: captured.viewpoint.guid, animate: false });
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([1, 2]));
    assert.equal(useViewerStore.getState().selectedEntitiesSet.size, 2);
    assert.ok(Math.abs(camera.getPosition().x - 12) < 0.001);
    await execute('bcf.deleteViewpoint', { topic_id: topic.guid, viewpoint_id: captured.viewpoint.guid });
    assert.equal(useViewerStore.getState().bcfProject?.topics.get(topic.guid)?.viewpoints.length, 0);
  } finally { clearGlobalRefs(); }
});
it('native query-only sandbox computes fixture results and denies model loading (#10525)', async () => {
  const result = await execute<{ value: unknown }>('script.analyze', { source: "bim.query.byType('IfcWall').length", timeout_ms: 1000, memory_bytes: 16777216 });
  assert.equal(result.value, 4);
  await assert.rejects(execute('script.analyze', { source: "bim.model.loadIfc('bad', 'bad.ifc')", timeout_ms: 1000, memory_bytes: 16777216 }));
});

it('native assistant send awaits the configured stream and preserves native evidence/budget (#10525)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Native response [E1]"},"finish_reason":"stop"}]}\n\n');
  try {
    const evidence = await execute<{ evidence_id: string }>('assistant.captureEvidence', { source: 'loadReport' });
    await execute('assistant.model', { value: 'openai/gpt-free' });
    const result = await execute<{ completed: boolean; messages: Array<{ role: string; content: string }>; status: string }>('assistant.send', { prompt: 'Explain the available diagnostics', evidence_id: evidence.evidence_id });
    assert.equal(result.completed, true); assert.equal(result.status, 'idle');
    assert.equal(result.messages.at(-1)?.role, 'assistant'); assert.equal(result.messages.at(-1)?.content, 'Native response [E1]');
    await assert.rejects(execute('assistant.send', { prompt: 'Wrong evidence', evidence_id: 'stale' }), /evidence changed/);
  } finally { globalThis.fetch = originalFetch; }
});

it('full native editor execution reports terminal results before an IFC model exists (#10525)', async () => {
  useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null, geometryResult: null });
  await execute('script.create', { name: 'Native arithmetic', source: '2 + 2' });
  const result = await execute<{ state: string; result: { value: unknown } }>('script.execute', { expected_revision: useViewerStore.getState().scriptEditorRevision });
  assert.equal(result.state, 'completed'); assert.equal(result.result.value, 4);
});

it('a preflight failure settles the editor so the corrected source can run (#10591 review)', async () => {
  useViewerStore.setState({ scriptEditorDirty: false });
  await execute('script.create', { name: 'Preflight fixture', source: 'bim.nonexistent.call()' });
  const refused = await execute<{ state: string }>('script.execute', { expected_revision: useViewerStore.getState().scriptEditorRevision });
  assert.equal(refused.state, 'failed'); assert.equal(useViewerStore.getState().scriptExecutionState, 'error');
  useViewerStore.getState().setScriptEditorContent('2 + 2');
  const result = await execute<{ state: string; result: { value: unknown } }>('script.execute', { expected_revision: useViewerStore.getState().scriptEditorRevision });
  assert.equal(result.state, 'completed'); assert.equal(result.result.value, 4);
});

it('script.open refuses to drop an unsaved draft that no saved script holds (#10591 review)', async () => {
  useViewerStore.setState({ scriptEditorDirty: false });
  const saved = await execute<{ id: string }>('script.create', { name: 'Target', source: '1' });
  useViewerStore.setState({ activeScriptId: null, scriptEditorContent: 'draft', scriptEditorDirty: true });
  await assert.rejects(execute('script.open', { id: saved.id }), /unsaved draft/);
  assert.equal(useViewerStore.getState().scriptEditorContent, 'draft');
});

it('script.open keeps a dirty script open when its save fails (#10591 review)', async () => {
  useViewerStore.setState({ scriptEditorDirty: false });
  const target = await execute<{ id: string }>('script.create', { name: 'Target', source: '1' });
  const active = await execute<{ id: string }>('script.create', { name: 'Active', source: '2' });
  useViewerStore.setState({ scriptEditorContent: 'edited', scriptEditorDirty: true });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } } });
  try {
    await assert.rejects(execute('script.open', { id: target.id }), /could not be saved/);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
  const state = useViewerStore.getState();
  assert.equal(state.activeScriptId, active.id); assert.equal(state.scriptEditorContent, 'edited'); assert.equal(state.scriptEditorDirty, true);
});

it('script.create keeps the unnamed draft when required storage refuses the write (#10591 r4653276119)', async () => {
  const before = useViewerStore.getState();
  const source = '21 * 2';
  useViewerStore.setState({ activeScriptId: null, scriptEditorDirty: true, scriptEditorContent: source });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } } });
  try {
    await assert.rejects(execute('script.create', { name: 'Draft', source }), /could not be saved/);
    const state = useViewerStore.getState();
    assert.equal(state.activeScriptId, null);
    assert.equal(state.scriptEditorDirty, true);
    assert.equal(state.scriptEditorContent, source);
    assert.equal(state.savedScripts, before.savedScripts);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    useViewerStore.setState(before);
  }
});

it('script.open refuses to switch a running editor to a different saved script (#10591 r4653276121)', async () => {
  const before = useViewerStore.getState();
  useViewerStore.setState({ scriptEditorDirty: false });
  const target = await execute<{ id: string }>('script.create', { name: 'Target script', source: '1' });
  const active = await execute<{ id: string }>('script.create', { name: 'Running script', source: '2' });
  useViewerStore.setState({ scriptExecutionState: 'running' });
  try {
    await assert.rejects(execute('script.open', { id: target.id }), /active script run/);
    assert.equal(useViewerStore.getState().activeScriptId, active.id);
    assert.equal(useViewerStore.getState().scriptExecutionState, 'running');
  } finally { useViewerStore.setState(before); }
});

for (const action of ['create', 'delete'] as const) {
  it(`script.${action} refuses to replace the active editor during a run (#10591)`, async () => {
    const before = useViewerStore.getState();
    const storageKey = 'ifc-lite-scripts';
    const persisted = localStorage.getItem(storageKey);
    useViewerStore.setState({ scriptEditorDirty: false, scriptExecutionState: 'idle' });
    try {
      const other = await execute<{ id: string }>('script.create', { name: 'Other script', source: '1' });
      const active = await execute<{ id: string }>('script.create', { name: 'Running script', source: '2' });
      useViewerStore.setState({ scriptExecutionState: 'running' });
      const { savedScripts, scriptEditorRevision } = useViewerStore.getState();
      const input = action === 'create' ? { name: 'Replacement', source: '3' } : { id: active.id };
      await assert.rejects(execute(`script.${action}`, input), {
        code: ToolErrorCode.UNSUPPORTED_OPERATION, details: { reason: 'unavailable' }, message: /active script run/,
      });
      assert.equal(useViewerStore.getState().activeScriptId, active.id);
      assert.equal(useViewerStore.getState().scriptExecutionState, 'running');
      assert.equal(useViewerStore.getState().scriptEditorRevision, scriptEditorRevision);
      assert.equal(useViewerStore.getState().savedScripts, savedScripts);
      if (action === 'delete') {
        await execute('script.delete', { id: other.id });
        assert.equal(useViewerStore.getState().activeScriptId, active.id);
        assert.ok(!useViewerStore.getState().savedScripts.some(script => script.id === other.id));
      }
    } finally {
      useViewerStore.setState(before);
      if (persisted === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, persisted);
    }
  });
}

it('a refused panel save keeps the editor dirty, so script.open still guards the edits (#10591 review)', async () => {
  useViewerStore.setState({ scriptEditorDirty: false, scriptExecutionState: 'idle' });
  const target = await execute<{ id: string }>('script.create', { name: 'Panel target', source: '1' });
  await execute('script.create', { name: 'Panel active', source: '2' });
  useViewerStore.setState({ scriptEditorContent: 'panel edit', scriptEditorDirty: true });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } } });
  try {
    assert.equal(useViewerStore.getState().saveActiveScript()?.ok, false);
    assert.equal(useViewerStore.getState().scriptEditorDirty, true);
    await assert.rejects(execute('script.open', { id: target.id }), /could not be saved/);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

it('flow.validate reports node availability with the native run features (#10591 review)', async () => {
  const doc: FlowDocument = { flowVersion: 1, id: 'validate-automation', name: 'Validate automation', inputs: [], outputs: [], nodes: [{ id: 'pdf', type: 'report.exportPdf', pos: [0, 0] }], edges: [], capabilities: [] };
  useViewerStore.getState().setFlowDoc(doc);
  const result = await execute<{ availability: Array<{ nodeId?: string; status: string }> }>('flow.validate');
  assert.ok(result.availability.length > 0, 'the automation node is inspected');
  assert.ok(result.availability.every(entry => entry.status !== 'unavailable'), JSON.stringify(result.availability));
});

it('Flow effect admission refuses future remote nodes and detects native HTTP Player POST overrides before any effect (#10525)', async () => {
  const { flowRegistry } = await import('@/lib/flow/runner'); let ran = false;
  flowRegistry().register({ type: 'future.remotePublication', title: 'Unreviewed future provider', category: 'test', inputs: [], outputs: [], params: [], capabilities: ['network.fetch:*'], requires: { network: true }, run() { ran = true; throw new Error('Unknown effect must never run'); } });
  const doc: FlowDocument = { flowVersion: 1, id: 'unknown-effects', name: 'Unknown effects', inputs: [], outputs: [], nodes: [{ id: 'unknown', type: 'future.remotePublication', pos: [0, 0] }], edges: [], capabilities: ['network.fetch:example.test'] };
  useViewerStore.getState().setFlowDoc(doc);
  const input = () => ({ expected_json: flowToJson(useViewerStore.getState().flowDoc!), inputs_json: '{}', resume_checkpoint_id: '', target_model_id: useViewerStore.getState().activeModelId ?? '', expected_mutation_version: useViewerStore.getState().mutationVersion, expected_geometry_version: useViewerStore.getState().geometryContentVersion });
  const unknown = await execute<{ state: string; error: string }>('flow.run', input());
  assert.equal(unknown.state, 'failed'); assert.match(unknown.error, /effect contract/); assert.equal(ran, false);
  useViewerStore.getState().setFlowDoc({ ...doc, nodes: [{ id: 'http', type: 'http.request', params: { url: 'https://example.test/data', method: 'GET' }, pos: [0, 0] }], inputs: [{ nodeId: 'http', param: 'method', label: 'Method', kind: 'scalar' }] });
  // A GET waits too: its URL can carry model data out.
  const get = await execute<{ state: string }>('flow.run', input());
  assert.equal(get.state, 'waiting-for-approval'); assert.equal(ran, false);
  const requested = await execute<{ state: string }>('flow.run', { ...input(), inputs_json: '{"http.method":"POST"}' });
  assert.equal(requested.state, 'waiting-for-approval'); assert.equal(ran, false);
});

it('local layer operations use the native merge engine and reject stale refs without model prerequisites (#10525)', async () => {
  const { computeLayerId, createProvenanceManifest, setProvenance, computeStackHash } = await import('@ifc-lite/ifcx');
  const { getBrowserLayerStore } = await import('@/lib/layers/browser-store');
  const { extractStackState } = await import('@ifc-lite/merge');
  const makeLayer = (data: import('@ifc-lite/ifcx').IfcxNode[], base: string[] | null) => {
    const file = setProvenance({ header: { id: '', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 'fixture', timestamp: '2026-07-11T00:00:00Z' }, imports: [], schemas: {}, data }, createProvenanceManifest({ author: { kind: 'human', principal: 'fixture' }, intent: 'Native merge fixture', base: base ? { kind: 'stack', id: computeStackHash(base) } : null, created: '2026-07-11T00:00:00Z' }));
    return { ...file, header: { ...file.header, id: computeLayerId(file) } };
  };
  const store = await getBrowserLayerStore(), base = makeLayer([{ path: 'wall-native', attributes: { rating: 'REI60' } }], null);
  store.storeLayer(base); const candidate = makeLayer([{ path: 'wall-native', attributes: { rating: 'REI90' } }], [base.header.id]); store.storeLayer(candidate);
  const ref = `operation-fixture-${crypto.randomUUID()}`; store.setRef(ref, { layers: [base.header.id] });
  useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null, geometryResult: null });
  const input = { candidate_id: candidate.header.id, ref_name: ref, expected_ref_json: JSON.stringify(store.getRef(ref)) };
  const preview = await execute<{ outcome: { status: string; conflicts: unknown[] } }>('layers.previewLocalMerge', input);
  assert.equal(preview.outcome.status, 'preview'); assert.equal(preview.outcome.conflicts.length, 0);
  const merged = await execute<{ outcome: { status: string } }>('layers.mergeLocal', { ...input, resolver: 'fixture', resolutions: [], waivers: [] });
  assert.ok(['merged', 'fast-forward'].includes(merged.outcome.status));
  const files = store.getRef(ref)!.layers.map(id => store.loadLayer(id));
  assert.equal(extractStackState(files).get('wall-native')?.components.get('attr:rating')?.rating, 'REI90');
  await assert.rejects(execute('layers.mergeLocal', { ...input, resolver: 'stale', resolutions: [], waivers: [] }), /ref changed/);
  const exported = await execute<ArtifactMetadata>('layers.export', { id: candidate.header.id }); assert.ok(exported.bytes > 0);
});

it('native assistant attachment handles transmit real selection grounding once and stay bound to exact evidence (#10525)', async () => {
  const { createSelectionAdapter } = await import('@/sdk/adapters/selection-adapter');
  const { createQueryAdapter } = await import('@/sdk/adapters/query-adapter');
  const wall = createQueryAdapter(useViewerStore).entities({ types: ['IfcWall'] })[0]; assert.ok(wall);
  createSelectionAdapter(useViewerStore).set([wall.ref]);
  const evidence = await execute<{ evidence_id: string }>('assistant.captureEvidence', { source: 'loadReport' });
  const capture = await execute<{ attachment_id: string; selection_count: number }>('assistant.captureAttachments', { evidence_id: evidence.evidence_id, selection: true, screenshot: false, room_candidate_id: '', room_model_id: '' });
  assert.equal(capture.selection_count, 1);
  const originalFetch = globalThis.fetch; let transmitted = '';
  globalThis.fetch = async (_url, init) => { transmitted = String(init?.body ?? ''); return new Response('data: {"choices":[{"delta":{"content":"Attached selection reviewed"},"finish_reason":"stop"}]}\n\n'); };
  try {
    const outcome = await execute<{ completed: boolean }>('assistant.send', { prompt: 'Review the explicitly attached wall', evidence_id: evidence.evidence_id, attachment_id: capture.attachment_id });
    assert.equal(outcome.completed, true); assert.ok(transmitted.includes(wall.globalId), 'the native request carries the captured real IFC identity');
    await assert.rejects(execute('assistant.send', { prompt: 'Do not reuse consumed attachment', evidence_id: evidence.evidence_id, attachment_id: capture.attachment_id }), /attachment capture is absent/);
  } finally { globalThis.fetch = originalFetch; }
});

/** Valid 1024×1024 RGB PNG: ordinary screenshot dimensions with incompressible image detail. */
function largeBcfScreenshot(seed: number) {
  const width = 1024, height = 1024, raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) for (let col = 1; col <= width * 3; col++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; raw[row * (width * 3 + 1) + col] = seed >>> 24; }
  const chunk = (kind: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(kind), data]), output = Buffer.alloc(body.length + 8); output.writeUInt32BE(data.byteLength); body.copy(output, 4);
    let crc = 0xffffffff; for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4); return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}
it('BCF metadata stays below the executor limit with >1 MiB native screenshot media; native apply and ZIP export retain full bytes (#10525)', async () => {
  const { createBCFComment } = await import('@ifc-lite/bcf');
  const camera = new Camera(); camera.setPosition(12, 8, 20); camera.setTarget(0, 0, 0); camera.setAspect(16 / 9);
  const renderer = { getCamera: () => camera } as unknown as Renderer; setGlobalRendererRef({ current: renderer });
  const imageViewpointId = crypto.randomUUID(), secondImageViewpointId = crypto.randomUUID();
  const png = largeBcfScreenshot(8191), secondPng = largeBcfScreenshot(65521);
  assert.ok(png.byteLength > 1024 * 1024);
  assert.ok(!png.equals(secondPng), 'the two viewpoints have distinct screenshot bytes');
  const screenshots = [[imageViewpointId, png], [secondImageViewpointId, secondPng]] as const;
  try {
    await execute('bcf.createProject', { value: 'Screenshot transport fixture' });
    const created = await execute<{ guid: string }>('bcf.createTopic', { title: 'Inspect native screenshots', description: 'Exact description for editing', status: 'Open' });
    useViewerStore.getState().setSelectedEntityIds([1, 2]);
    const captured = await execute<{ viewpoint: { guid: string } }>('bcf.captureViewpoint', { topic_id: created.guid, snapshot: false, selection: true, visibility: false });
    const native = useViewerStore.getState().bcfProject!.topics.get(created.guid)!.viewpoints.find(viewpoint => viewpoint.guid === captured.viewpoint.guid)!;
    for (const [guid, snapshotData] of screenshots) {
      const snapshot = `data:image/png;base64,${snapshotData.toString('base64')}`;
      useViewerStore.getState().addViewpoint(created.guid, { ...native, guid, snapshot, snapshotData });
    }
    const comment = createBCFComment({ author: 'native fixture', comment: 'Exact reviewed comment '.repeat(200) }); useViewerStore.getState().addComment(created.guid, comment);
    for (let index = 0; index < 21; index++) await execute('bcf.createTopic', { title: `Paged native topic ${index}`, description: '', status: 'Open' });
    const request = async <T>(operation_id: string, input: unknown = {}) => {
      const response = await dispatchMainViewerTool(context.host, 'viewer_operation_execute', { operation_id, input }, { canEdit: () => true }); assert.equal(response.isError, false, response.text);
      assert.ok(new TextEncoder().encode(response.text).byteLength < 1024 * 1024); return (response.structured as { result: T }).result;
    };
    const discovery = await dispatchMainViewerTool(context.host, 'viewer_operations', { operation_id: 'bcf.read' }); assert.equal(discovery.isError, false, discovery.text);
    const first = await request<{ project: { topic_count: number; snapshot_count: number; topics: Array<{ guid: string }> }; page: { next_offset: number | null; page_revision: string } }>('bcf.read');
    assert.equal(first.project.topic_count, 22); assert.equal(first.project.snapshot_count, 2); assert.equal(first.project.topics.length, 20); assert.equal(first.page.next_offset, 20);
    const next = await request<{ project: { topics: unknown[] } }>('bcf.read', { offset: first.page.next_offset, page_revision: first.page.page_revision, limit: 20 }); assert.equal(next.project.topics.length, 2);
    const selected = await request<{ project: { topics: Array<{ guid: string; description: string; expected_modified: string }> } }>('bcf.read', { topic_id: created.guid }); assert.equal(selected.project.topics[0].description, 'Exact description for editing');
    const firstViewpoint = await request<{ page: { next_offset: number; page_revision: string } }>('bcf.viewpoints', { topic_id: created.guid, offset: 0, limit: 1, viewpoint_id: '' });
    const viewpoints = await request<{ viewpoints: Array<{ guid: string; snapshot_available: boolean; snapshot_data_bytes: number; selection_count: number }>; page: { next_offset: number | null; page_revision: string } }>('bcf.viewpoints', { topic_id: created.guid, offset: firstViewpoint.page.next_offset, page_revision: firstViewpoint.page.page_revision, limit: 1, viewpoint_id: '' });
    assert.equal(viewpoints.viewpoints[0].snapshot_available, true); assert.equal(viewpoints.viewpoints[0].snapshot_data_bytes, png.byteLength); assert.equal(viewpoints.viewpoints[0].selection_count, 2); assert.equal(viewpoints.page.next_offset, 2);
    assert.equal(JSON.stringify(viewpoints).includes('data:image'), false); assert.equal('snapshotData' in viewpoints.viewpoints[0], false);
    const comments = await request<{ comments: Array<{ expected_comment: string }> }>('bcf.comments', { topic_id: created.guid, offset: 0, limit: 20, comment_id: comment.guid }); assert.equal(comments.comments[0].expected_comment, comment.comment);
    // #10589: a continuation must refer to the same ordered metadata or exact native text.
    const missingRevision = await dispatchMainViewerTool(context.host, 'viewer_operation_execute', {
      operation_id: 'bcf.read', input: { offset: first.page.next_offset },
    }, { canEdit: () => true });
    assert.equal(missingRevision.isError, true);
    assert.match(missingRevision.text, /page_revision is required/);
    const textInput = { topic_id: created.guid, field: 'comment', comment_id: comment.guid, length: 16 };
    const firstText = await request<{ text: string; next_offset: number; page_revision: string }>('bcf.readText', { ...textInput, offset: 0 });
    const continuation = { ...textInput, offset: firstText.next_offset, page_revision: firstText.page_revision };
    const secondText = await request<{ text: string }>('bcf.readText', continuation);
    assert.equal(firstText.text + secondText.text, comment.comment.slice(0, 32));
    await request('bcf.updateComment', { topic_id: created.guid, comment_id: comment.guid, expected_comment: comments.comments[0].expected_comment, comment: 'Native comment updated with its exact inspected value.' });
    const staleText = await dispatchMainViewerTool(context.host, 'viewer_operation_execute', {
      operation_id: 'bcf.readText', input: continuation,
    }, { canEdit: () => true });
    assert.equal(staleText.isError, true);
    assert.match(staleText.text, /read again from offset 0/);
    await request('bcf.createTopic', { title: 'Added after reading page one', description: '', status: 'Open' });
    const staleTopics = await dispatchMainViewerTool(context.host, 'viewer_operation_execute', {
      operation_id: 'bcf.read', input: { offset: first.page.next_offset, page_revision: first.page.page_revision },
    }, { canEdit: () => true });
    assert.equal(staleTopics.isError, true);
    assert.match(staleTopics.text, /read again from offset 0/);
    const freshTopic = await request<{ project: { topics: Array<{ expected_modified: string }> } }>('bcf.read', { topic_id: created.guid });
    const omittedPriority = await dispatchMainViewerTool(context.host, 'viewer_operation_execute', {
      operation_id: 'bcf.updateTopic',
      input: { id: created.guid, expected_modified: freshTopic.project.topics[0].expected_modified, title: 'Incomplete edit', description: '', status: 'Open', assigned_to: '' },
    }, { canEdit: () => true });
    assert.equal(omittedPriority.isError, true);
    assert.match(omittedPriority.text, /priority/);
    await request('bcf.updateTopic', { id: created.guid, expected_modified: freshTopic.project.topics[0].expected_modified, title: 'Updated issue with unchanged native screenshots', description: 'Edited description', status: 'Open', priority: '', assigned_to: '' });
    await request('bcf.selectTopic', { id: created.guid });
    useViewerStore.getState().clearEntitySelection(); camera.setPosition(1, 1, 1); await request('bcf.applyViewpoint', { topic_id: created.guid, viewpoint_id: imageViewpointId, animate: false });
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([1, 2])); assert.ok(Math.abs(camera.getPosition().x - 12) < 0.001);
    const exported = await request<ArtifactMetadata>('bcf.export'), bytes = new Uint8Array(exported.bytes);
    for (let offset = 0; offset < bytes.length; offset += 65536) { const chunk = await readArtifact(context.host, exported.artifact_id, offset, Math.min(65536, bytes.length - offset)); bytes.set(Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0)), offset); }
    const restored = (await readBCF(bytes)).topics.get(created.guid);
    assert.ok(restored);
    for (const [guid, expected] of screenshots) {
      const snapshot: Uint8Array | undefined = restored.viewpoints.find(viewpoint => viewpoint.guid === guid)?.snapshotData;
      assert.ok(snapshot, `snapshot data for viewpoint ${guid}`);
      assert.deepEqual(Buffer.from(snapshot), expected, `screenshot bytes for viewpoint ${guid}`);
    }
    assert.equal(restored.comments[0].comment, 'Native comment updated with its exact inspected value.');
  } finally { clearGlobalRefs(); }
});
it('compare.run and collab.prepareRoom refuse what the native panel and dialog would refuse (#10589)', async () => {
  const model = context.model?.id; assert.ok(model);
  await assert.rejects(execute('compare.run', { head_model_id: model, scope: 'both', excluded_types: [], match_by_content: false, key_property: '' }), /two different models/);
  assert.equal(useViewerStore.getState().compareResult, null);
  const state = useViewerStore.getState();
  await assert.rejects(execute('collab.prepareRoom', { scope: 'all', role: 'viewer', expected_mutation_version: state.mutationVersion, expected_geometry_version: state.geometryContentVersion }), {
    code: ToolErrorCode.PERMISSION_DENIED, details: { reason: 'disabled' }, message: /not enabled/,
  });
});

it('#10589 refuses to stage a share when the mounted consent dialog cannot load', async t => {
  setCollabEnabledOverride(true);
  t.after(() => setCollabEnabledOverride(null));
  const previous = useViewerStore.getState();
  useViewerStore.setState({ models: new Map(), activeModelId: null, collabRoomId: null, collabRole: null });
  t.after(() => useViewerStore.setState(previous));
  const retire = registerMountedFileHost({
    openFiles() {},
    addModel() {},
    async refreshModels() {},
    openShareDialog() { assert.fail('cannot open a failed Share chunk'); },
    async preloadShareDialog() { throw new TypeError('Failed to fetch dynamically imported module'); },
  });
  t.after(retire);
  const initial = useCollabShareReview.getState();
  await assert.rejects(execute('collab.prepareRoom', {
    scope: 'all', role: 'viewer', expected_mutation_version: previous.mutationVersion,
    expected_geometry_version: previous.geometryContentVersion,
  }), {
    code: ToolErrorCode.INTERNAL_ERROR,
    details: { reason: 'internal', cause: 'Failed to fetch dynamically imported module' },
    message: /Share consent dialog could not load/,
  });
  assert.equal(useCollabShareReview.getState().candidate, initial.candidate);
  assert.equal(useCollabShareReview.getState().dialogOpen, false);
});

it('#10589 refuses an active-model share when the active model changes during preparation', async t => {
  const previous = useViewerStore.getState();
  const initial = useCollabShareReview.getState();
  setCollabEnabledOverride(true);
  t.after(() => {
    setCollabEnabledOverride(null);
    useViewerStore.setState(previous);
    useCollabShareReview.setState(initial);
  });
  await seedCoincidentWalls(2, 4);
  const state = useViewerStore.getState();
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const openShareDialog = t.mock.fn();
  const retire = registerMountedFileHost({
    openFiles() {},
    addModel() {},
    async refreshModels() {},
    openShareDialog,
    async preloadShareDialog() { entered.resolve(); await release.promise; },
  });
  t.after(retire);
  const preparing = assert.rejects(execute('collab.prepareRoom', {
    scope: 'active', role: 'viewer', expected_mutation_version: state.mutationVersion,
    expected_geometry_version: state.geometryContentVersion,
  }), { code: ToolErrorCode.STATE_CHANGED, message: /active model changed/ });
  await waitFor(() => entered.settled(), 'Share preparation reached the async consent load');
  useViewerStore.setState({ activeModelId: 'B' });
  release.resolve();
  await preparing;
  assert.equal(openShareDialog.mock.callCount(), 0);
  assert.equal(useCollabShareReview.getState().candidate, initial.candidate);
});

it('#10589 refuses agent joins that would share local annotations without starting a room session', async t => {
  const { annotations, startCollab } = useViewerStore.getState();
  const note = { id: 'local-pin', note: 'Local note', position: { x: 0, y: 0, z: 0 }, entityExpressId: null,
    modelId: null, createdAt: 0, updatedAt: 0 };
  const start = t.mock.fn(async () => assert.fail('a refused join must not start a room session'));
  useViewerStore.setState({ annotations: new Map([[note.id, note]]), startCollab: start });
  t.after(() => useViewerStore.setState({ annotations, startCollab }));

  for (const role of ['commenter', 'editor'] as const) {
    const roomId = 'room';
    const token = Buffer.from(JSON.stringify({ dev: true, room: roomId, role })).toString('base64url');
    const response = await dispatchMainViewerTool(context.host, 'viewer_operation_execute', {
      operation_id: 'collab.join', input: { room_id: roomId, token },
    }, { canEdit: () => true });
    assert.equal(response.isError, true);
    assert.equal(response.errorCode, ToolErrorCode.PERMISSION_DENIED);
    assert.match(response.text, /open the room invite link themselves/);
  }
  assert.equal(start.mock.callCount(), 0);
});

it('#10589 stages a publishable plan with the native default for an unsupported BCF topic type', async t => {
  const peer = await connectPeer(t, { topicTypes: ['Task', 'Model Issue'], topicStatuses: ['Draft', 'Open', 'Closed'] });
  const batch = await reviewedBatch();
  await bcfDraftLibrary.initialize();
  await initializeBcfOutbox();
  assert.equal(await saveDraftBatch(batch), true);
  t.after(() => useBcfPublicationReview.setState({ candidate: null }));

  const { state, candidate } = await execute<{ state: string; candidate: BcfPublicationReview }>('bcf.preparePublication', {
    batch_id: batch.id, project_id: peer.target.projectId, topic_types: [],
  });
  assert.equal(state, 'waiting-for-approval');
  assert.deepEqual(candidate.topicTypes, { Clash: 'Model Issue' });
  assert.equal(candidate.preflight.ok, true);
  const creates = candidate.plan.record.entries.filter(entry => entry.operation === 'createTopic');
  assert.equal(creates.length, batch.topics.length);
  assert.ok(creates.every(entry => entry.payload.topic_type === 'Model Issue' && entry.topicTypeFrom === 'Clash'));
  assert.equal(peer.state.receivedWrites, 0, 'preparing the plan does not write remotely');
  const ui = render(createElement(BCFPublicationPanel, { batch, onRecordId: () => undefined, onUsers: () => undefined }));
  try {
    const publish = () => [...ui.querySelectorAll('button')].find(item => item.textContent?.startsWith('Publish '));
    await waitFor(() => publish()?.disabled === false, 'native Publish is ready');
    const picker = [...ui.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'Model Issue'));
    assert.equal(picker?.value, 'Model Issue', 'the staged mapping is visible on the native picker');
    click(publish()!);
    await waitFor(() => publish()?.disabled === false && peer.state.topics.size === batch.topics.length, 'the first approval publishes the staged plan');
  } finally {
    cleanup();
  }
});

it('#10589 refuses to install a fetched BCF project after switching accounts', async t => {
  const peer = await connectPeer(t);
  const config = loadBcfServerConfig();
  assert.ok(config);
  const ready = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    const input = args[0];
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith('/topics')) {
      ready.resolve();
      await release.promise;
    }
    return response;
  });

  const local = await execute<{ project_id: string }>('bcf.createProject', { value: 'Keep local project' });
  const before = useViewerStore.getState().bcfProject;
  const pull = assert.rejects(execute('bcf.pullProject', {
    project_id: peer.target.projectId, project_name: peer.target.projectName, replace_project_id: local.project_id,
  }), { code: ToolErrorCode.STATE_CHANGED, message: /account changed during synchronization/ });
  await waitFor(() => ready.settled(), 'the old account response is in flight');
  saveBcfServerConfig({ ...config, userId: 'other-coordinator@example.test' });
  release.resolve();
  await pull;
  assert.equal(useViewerStore.getState().bcfProject, before);
});
