/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { beforeEach, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef, clearGlobalRefs } from '@/hooks/useBCF';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { resetFeaturesForTest } from '@/lib/features';
import { readBCF } from '@ifc-lite/bcf';
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
it('rejects undeclared parameters for every coordination operation (#10525)', () => {
  // Missing required fields would also throw, so check the closed schema itself.
  for (const op of coordinationOperations) assert.equal((op.inputSchema as { additionalProperties?: unknown }).additionalProperties, false, op.id);
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
