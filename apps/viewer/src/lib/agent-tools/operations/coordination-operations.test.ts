/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
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
  allowed = true; await seedCoincidentWalls(1, 4);
  useViewerStore.setState({ bcfProject: null, mutationVersion: 0, mutationViews: new Map() });
  const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  const model = host.models()[0]; if (!model?.store) throw new Error('Fixture IFC store missing.');
  context = { host, model: { ...model, store: model.store }, commit, commitAsync: async write => { checkpoint(); return write(); }, checkpoint, artifacts: operationArtifacts(host, commit) };
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
  useViewerStore.getState().setFlowDoc({ ...doc, nodes: [...doc.nodes, { id: 'write', type: 'script.run', pos: [600, 0] }] });
  await assert.rejects(execute('flow.analyze'), /only core\/model\/table reads/);
});
it('exports real per-model diagnostic evidence and preserves explicit unknown coverage (#10525)', async () => {
  const artifact = await execute<ArtifactMetadata>('loadReport.export');
  const read = await readArtifact(context.host, artifact.artifact_id, 0, 65536);
  const report = JSON.parse(atob(read.data)) as { models: Array<{ modelId: string; diagnosticsAvailable: boolean }> };
  assert.equal(report.models.length, 1); assert.equal(report.models[0].modelId, 'A');
  assert.equal(typeof report.models[0].diagnosticsAvailable, 'boolean');
});
it('rejects undeclared parameters for every coordination operation (#10525)', () => {
  for (const op of coordinationOperations) assert.throws(() => op.validate({ __unexpected: true }), /Invalid/);
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
