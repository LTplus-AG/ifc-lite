/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { beforeEach, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { ToolErrorCode } from '@ifc-lite/mcp/browser';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef, clearGlobalRefs } from '@/hooks/useBCF';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { resetFeaturesForTest } from '@/lib/features';
import { readBCF } from '@ifc-lite/bcf';
import { registerMountedFileHost } from '@/components/viewer/toolbar/mounted-file-host';
import { setCollabEnabledOverride } from '@/lib/collab/config';
import { useCollabShareReview } from '@/lib/collab/share-review';
import { connectPeer, reviewedBatch } from '@/test/bcf-publication-fixture';
import { deferred } from '@/test/race';
import { createElement } from 'react';
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
