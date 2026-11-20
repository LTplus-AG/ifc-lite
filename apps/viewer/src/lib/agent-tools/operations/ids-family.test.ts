/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { wallFixture } from '@/test/ids-studio-fixture';
import { seedAuthoringSample, SAMPLE_MODEL } from '@/test/authoring-sample-fixture';
import { setFieldOp, setSpecTextOp } from '@/lib/ids-studio/ops';
import { loadIdsStudioRuntime } from '@/lib/ids-studio/runtime-loader';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { viewerOperation } from './registry';
import type { ToolHost } from '../types';
let host: ToolHost;
let fixture: Awaited<ReturnType<typeof wallFixture>>;
async function call<T>(id: string, input: unknown = {}, write = false): Promise<T> {
  const result = await dispatchMainViewerTool(host, write ? 'viewer_operation_execute' : 'viewer_operation_inspect', { ...(viewerOperation(id).needs === 'model' ? { model_id: SAMPLE_MODEL } : {}), operation_id: id, input }, { canEdit: () => true });
  assert.equal(result.isError, false, result.text);
  const output = (result.structured as { result: { native_json?: string } }).result;
  return (output.native_json === undefined ? output : JSON.parse(output.native_json)) as T;
}
describe('complete native IDS Studio operation vocabulary (#10525 follow-up)', () => {
  beforeEach(async () => {
    await seedAuthoringSample(); fixture = await wallFixture(); await loadIdsStudioRuntime();
    useViewerStore.setState({ idsStudioState: fixture.state, idsStudioContexts: fixture.contexts, idsStudioRevision: 0, idsStudioRejection: null });
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  });
  it('previews every op through the authoritative gate, applies once and uses one native Undo entry', async () => {
    const ops = [setSpecTextOp(fixture.specId, 'name', 'Reviewed walls'), setFieldOp(fixture.propertyId, 'property.value', { kind: 'oneOf', values: ['EI60', 'EI90'] })];
    const original = useViewerStore.getState().idsStudioState!.doc;
    const preview = await call<{ token: string; accepted: boolean }>('ids.operations.prepare', { document_revision: 0, ops_json: JSON.stringify(ops) });
    assert.equal(preview.accepted, true); assert.equal(useViewerStore.getState().idsStudioState!.doc, original);
    await call('ids.candidate.apply', { token: preview.token }, true);
    assert.equal(useViewerStore.getState().idsStudioState!.history.past.length, 1);
    assert.equal(useViewerStore.getState().idsStudioState!.doc.ids.specifications[0].name, 'Reviewed walls');
    await call('ids.candidate.apply', { token: preview.token }, true); assert.equal(useViewerStore.getState().idsStudioState!.history.past.length, 1);
    await call('ids.history', { document_revision: 1, direction: 'undo' }, true);
    assert.deepEqual(useViewerStore.getState().idsStudioState!.doc, original);
  });
  it('reports grounded typo diagnostics without mutating the open document', async () => {
    const original = useViewerStore.getState().idsStudioState;
    const refused = await call<{ accepted: boolean; issues: Array<{ code: string }> }>('ids.operations.prepare', {
      document_revision: 0, ops_json: JSON.stringify([setFieldOp(fixture.propertyId, 'property.baseName', { kind: 'equals', value: 'FireRatng' })]),
    });
    assert.equal(refused.accepted, false); assert.ok(refused.issues.some(row => row.code === 'GATE-PROP-001')); assert.equal(useViewerStore.getState().idsStudioState, original);
  });
  it('refuses stale prepared document edits and malformed native ops', async () => {
    const prepared = await call<{ token: string }>('ids.operations.prepare', { document_revision: 0, ops_json: JSON.stringify([setSpecTextOp(fixture.specId, 'name', 'A')]) });
    useViewerStore.getState().idsStudioDispatch([setSpecTextOp(fixture.specId, 'name', 'Concurrent')]);
    const result = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'ids.candidate.apply', input: { token: prepared.token } }, { canEdit: () => true });
    assert.equal(result.isError, true); assert.equal(useViewerStore.getState().idsStudioState!.doc.ids.specifications[0].name, 'Concurrent');
    const malformed = await dispatchMainViewerTool(host, 'viewer_operation_inspect', { operation_id: 'ids.operations.prepare', input: { document_revision: 1, ops_json: '[{"kind":"constructor"}]' } });
    assert.equal(malformed.isError, true);
  });
  it('authors, lints and exports IDS with no IFC model loaded', async () => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, activeModelId: null });
    const prepared = await call<{ token: string }>('ids.document.prepare', { format: 'new', content: 'Model-free IDS', document_revision: 0 });
    await call('ids.candidate.apply', { token: prepared.token }, true);
    assert.equal(useViewerStore.getState().idsStudioState!.doc.ids.info.title, 'Model-free IDS');
    const written = await call<{ content: string }>('ids.document.xml'); assert.match(written.content, /Model-free IDS/);
    const lint = await call<{ diagnostics: object }>('ids.lint'); assert.ok(lint.diagnostics);
  });
  it('uses the same native writer for XML and host-owned artifact bytes, and runs real model validation (#10796)', async () => {
    const written = await call<{ content: string }>('ids.document.xml'); assert.match(written.content, /FireRating/);
    const artifact = await call<{ artifact_id: string; bytes: number; mime_type: string }>('ids.document.export', { format: 'ids' }, true);
    assert.equal(artifact.mime_type, 'application/xml');
    const read = await dispatchMainViewerTool(host, 'viewer_artifact_read', { artifact_id: artifact.artifact_id, length: 65536 });
    assert.equal(read.isError, false, read.text);
    const chunk = read.structured as { data: string; next_offset: number | null };
    assert.equal(chunk.next_offset, null);
    assert.equal(Buffer.from(chunk.data, 'base64').toString('utf8'), written.content);
    const validation = await call<{ report: { summary: object } }>('ids.document.validate'); assert.ok(validation.report.summary);
    const lint = await call<{ diagnostics: object }>('ids.lint'); assert.ok(lint.diagnostics);
  });
  it('reports when a saved validation report is memory-only (#10795 item 35)', async () => {
    assert.equal(typeof indexedDB, 'undefined', 'this fixture has no browser persistence');
    const { content } = await call<{ content: string }>('ids.document.xml');
    const { run_id } = await call<{ run_id: string }>('validation.ids.run', { xml: content, scope: 'whole', entity_ids: [] });
    const saved = await call<{ id: string; storage: string }>('validation.report.save', { run_id, name: 'In-memory report' }, true);
    assert.equal(saved.storage, 'unavailable');
    assert.ok(useViewerStore.getState().savedValidationReports.some(report => report.id === saved.id));
  });
  it('awaits the real BCF artifact sink and refuses publication after cancellation', async () => {
    const { runIdsBcfExport } = await import('@/hooks/ids/idsBcfExport');
    const { content } = await call<{ content: string }>('ids.document.xml');
    const { run_id } = await call<{ run_id: string }>('validation.ids.run', { xml: content, scope: 'whole', entity_ids: [] });
    await call('validation.publish', { run_id }, true);
    const state = useViewerStore.getState(), report = state.idsValidationReport!;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let emitted: Blob | undefined, complete = false;
    const controller = new AbortController();
    const params = { report, settings: { topicGrouping: 'per-entity' as const, includePassingEntities: false, includeCamera: false, includeSnapshots: false, loadIntoBcfPanel: false },
      models: state.models, legacyGeometryResult: null, toViewerGlobalId: () => undefined, bcfAuthor: undefined,
      setBcfExportProgress: () => undefined, setBcfProject: () => assert.fail('Artifact export must not install a BCF project'), setBcfPanelVisible: () => assert.fail('Artifact export must not open the BCF panel') };
    const pending = runIdsBcfExport({ ...params, emit: async blob => { emitted = blob; entered!(); await blocked; } }).then(() => { complete = true; });
    await Promise.race([ready, pending]); assert.equal(complete, false); assert.ok(emitted && emitted.size > 0); release!(); await pending; assert.equal(complete, true);
    let cancelledEmits = 0;
    await assert.rejects(runIdsBcfExport({ ...params, signal: controller.signal,
      setBcfExportProgress: progress => { if (progress?.phase === 'writing') controller.abort(); }, emit: () => { cancelledEmits++; } }), { name: 'AbortError' });
    assert.equal(cancelledEmits, 0);
  });
  it('authors an independent Manual checklist without a model and rejects stale library edits', async () => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, activeModelId: null });
    const read = () => call<{ expected_library: string }>('validation.manual.read');
    const initial = await read();
    const edit = { action: 'new', id: '', group_id: '', item_id: '', text: '', description: '', delta: 0, expected_library: initial.expected_library };
    await call('validation.manual.edit', edit, true);
    const current = await read();
    await call('validation.manual.edit', { ...edit, action: 'group.add', text: 'Site inspection', expected_library: current.expected_library }, true);
    const template = useViewerStore.getState().manualChecklist!; assert.equal(template.groups[0].name, 'Site inspection');
    const result = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'validation.manual.edit', input: { ...edit, action: 'rename', text: 'Stale' } }, { canEdit: () => true });
    assert.equal(result.isError, true); assert.notEqual(useViewerStore.getState().manualChecklist!.name, 'Stale');
  });

});
