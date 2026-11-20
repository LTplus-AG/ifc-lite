/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { buildLoadReport } from '@/lib/loadReport';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { beforeEach, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef, clearGlobalRefs } from '@/hooks/useBCF';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { attachCoordinationModelAdder } from '@/services/coordination-loader';
import { flowToJson } from '@/lib/flow/persistence';
import { resetFeaturesForTest } from '@/lib/features';
import { readBCF } from '@ifc-lite/bcf';
import type { FlowDocument, RunResult } from '@ifc-lite/flow';
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
  context = { host, model: { ...model, store: model.store }, commit, commitAsync: async write => { checkpoint(); return write(); }, ownGeometry: async work => work(), checkpoint, artifacts: operationArtifacts(host, commit) };
});
it('round-trips authored BCF topics/comments through native ZIP writer and reader (#10525)', async () => {
  await execute('bcf.createProject', { value: 'Coordination evidence' });
  const topic = await execute<{ guid: string }>('bcf.createTopic', { title: 'Wall coordination', description: 'Review the four fixture walls', status: 'Open' });
  const comment = await execute<{ guid: string }>('bcf.comment', { id: topic.guid, comment: 'Initial observation' });
  await execute('bcf.updateComment', { topic_id: topic.guid, comment_id: comment.guid, expected_comment: 'Initial observation', comment: 'Verify physical separation' });
  await assert.rejects(execute('bcf.updateComment', { topic_id: topic.guid, comment_id: comment.guid, expected_comment: 'Initial observation', comment: 'Stale overwrite' }), /comment changed/);
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
  await assert.rejects(execute('bcf.comment', { id: 'missing', comment: 'No phantom issue' }), /does not exist/);
});
it('refuses a revoked native BCF commit and duplicate project replacement (#10525)', async () => {
  allowed = false;
  await assert.rejects(execute('bcf.createProject', { value: 'Forbidden' }), /grant revoked/);
  assert.equal(useViewerStore.getState().bcfProject, null);
  allowed = true; await execute('bcf.createProject', { value: 'Preserve' });
  await assert.rejects(execute('bcf.createProject', { value: 'Replace' }), /already open/);
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
    const saved = await execute<{ storage: { ok: boolean } }>('script.save'); assert.equal(saved.storage.ok, false);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
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
function largeBcfScreenshot() {
  const width = 1024, height = 1024, raw = Buffer.alloc((width * 3 + 1) * height); let seed = 8191;
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
  const imageViewpointId = crypto.randomUUID(), secondImageViewpointId = crypto.randomUUID(); const png = largeBcfScreenshot(); assert.ok(png.byteLength > 1024 * 1024); const screenshot = `data:image/png;base64,${png.toString('base64')}`;
  try {
    await execute('bcf.createProject', { value: 'Screenshot transport fixture' });
    const created = await execute<{ guid: string }>('bcf.createTopic', { title: 'Inspect native screenshots', description: 'Exact description for editing', status: 'Open' });
    useViewerStore.getState().setSelectedEntityIds([1, 2]);
    const captured = await execute<{ viewpoint: { guid: string } }>('bcf.captureViewpoint', { topic_id: created.guid, snapshot: false, selection: true, visibility: false });
    const native = useViewerStore.getState().bcfProject!.topics.get(created.guid)!.viewpoints.find(viewpoint => viewpoint.guid === captured.viewpoint.guid)!;
    useViewerStore.getState().addViewpoint(created.guid, { ...native, guid: imageViewpointId, snapshot: screenshot, snapshotData: png });
    useViewerStore.getState().addViewpoint(created.guid, { ...native, guid: secondImageViewpointId, snapshot: screenshot, snapshotData: png });
    const comment = createBCFComment({ author: 'native fixture', comment: 'Exact reviewed comment '.repeat(200) }); useViewerStore.getState().addComment(created.guid, comment);
    for (let index = 0; index < 21; index++) await execute('bcf.createTopic', { title: `Paged native topic ${index}`, description: '', status: 'Open' });
    const request = async <T>(operation_id: string, input: unknown = {}) => {
      const response = await dispatchMainViewerTool(context.host, 'viewer_operation_execute', { operation_id, input }, { canEdit: () => true }); assert.equal(response.isError, false, response.text);
      assert.ok(new TextEncoder().encode(response.text).byteLength < 1024 * 1024); return (response.structured as { result: T }).result;
    };
    const discovery = await dispatchMainViewerTool(context.host, 'viewer_operations', { operation_id: 'bcf.read' }); assert.equal(discovery.isError, false, discovery.text);
    const first = await request<{ project: { topic_count: number; snapshot_count: number; topics: Array<{ guid: string }> }; page: { next_offset: number | null } }>('bcf.read');
    assert.equal(first.project.topic_count, 22); assert.equal(first.project.snapshot_count, 2); assert.equal(first.project.topics.length, 20); assert.equal(first.page.next_offset, 20);
    const next = await request<{ project: { topics: unknown[] } }>('bcf.read', { offset: first.page.next_offset, limit: 20 }); assert.equal(next.project.topics.length, 2);
    const selected = await request<{ project: { topics: Array<{ guid: string; description: string; expected_modified: string }> } }>('bcf.read', { topic_id: created.guid }); assert.equal(selected.project.topics[0].description, 'Exact description for editing');
    const viewpoints = await request<{ viewpoints: Array<{ guid: string; snapshot_available: boolean; snapshot_data_bytes: number; selection_count: number }>; page: { next_offset: number | null } }>('bcf.viewpoints', { topic_id: created.guid, offset: 1, limit: 1, viewpoint_id: '' });
    assert.equal(viewpoints.viewpoints[0].snapshot_available, true); assert.equal(viewpoints.viewpoints[0].snapshot_data_bytes, png.byteLength); assert.equal(viewpoints.viewpoints[0].selection_count, 2); assert.equal(viewpoints.page.next_offset, 2);
    assert.equal(JSON.stringify(viewpoints).includes('data:image'), false); assert.equal('snapshotData' in viewpoints.viewpoints[0], false);
    const comments = await request<{ comments: Array<{ expected_comment: string }> }>('bcf.comments', { topic_id: created.guid, offset: 0, limit: 20, comment_id: comment.guid }); assert.equal(comments.comments[0].expected_comment, comment.comment);
    await request('bcf.updateComment', { topic_id: created.guid, comment_id: comment.guid, expected_comment: comments.comments[0].expected_comment, comment: 'Native comment updated with its exact inspected value.' });
    const freshTopic = await request<{ project: { topics: Array<{ expected_modified: string }> } }>('bcf.read', { topic_id: created.guid });
    await request('bcf.updateTopic', { id: created.guid, expected_modified: freshTopic.project.topics[0].expected_modified, title: 'Updated issue with unchanged native screenshots', description: 'Edited description', status: 'Open', priority: '', assigned_to: '' });
    await request('bcf.selectTopic', { id: created.guid });
    useViewerStore.getState().clearEntitySelection(); camera.setPosition(1, 1, 1); await request('bcf.applyViewpoint', { topic_id: created.guid, viewpoint_id: imageViewpointId, animate: false });
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([1, 2])); assert.ok(Math.abs(camera.getPosition().x - 12) < 0.001);
    const exported = await request<ArtifactMetadata>('bcf.export'), bytes = new Uint8Array(exported.bytes);
    for (let offset = 0; offset < bytes.length; offset += 65536) { const chunk = await readArtifact(context.host, exported.artifact_id, offset, Math.min(65536, bytes.length - offset)); bytes.set(Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0)), offset); }
    const restored = await readBCF(bytes), restoredViewpoint = restored.topics.get(created.guid)!.viewpoints.find(viewpoint => viewpoint.guid === imageViewpointId); assert.ok(restoredViewpoint?.snapshotData);
    assert.deepEqual(Buffer.from(restoredViewpoint.snapshotData), png); assert.equal(restored.topics.get(created.guid)?.comments[0].comment, 'Native comment updated with its exact inspected value.');
  } finally { clearGlobalRefs(); }
});
it('compare.run and collab.prepareRoom refuse what the native panel and dialog would refuse (#10589)', async () => {
  const model = context.model?.id; assert.ok(model);
  await assert.rejects(execute('compare.run', { head_model_id: model, scope: 'both', excluded_types: [], match_by_content: false, key_property: '' }), /two different models/);
  assert.equal(useViewerStore.getState().compareResult, null);
  const state = useViewerStore.getState();
  await assert.rejects(execute('collab.prepareRoom', { scope: 'all', role: 'viewer', expected_mutation_version: state.mutationVersion, expected_geometry_version: state.geometryContentVersion }), /not enabled/);
});
