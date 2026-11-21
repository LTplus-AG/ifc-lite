/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { wallFixture } from '@/test/ids-studio-fixture';
import { seedAuthoringSample, SAMPLE_MODEL } from '@/test/authoring-sample-fixture';
import { setFieldOp, setSpecTextOp } from '@/lib/ids-studio/ops';
import { loadIdsStudioRuntime } from '@/lib/ids-studio/runtime-loader';
import { IDS_DRAFT_MAX_MIB, type IdsStudioDraft } from '@/lib/ids-studio/draft-codec';
import { useIdsStudioDraftLibrary } from '@/lib/ids-studio/draft-library';
import { closeIdsDraft, switchIdsDraft } from '@/lib/ids-studio/draft-viewer';
import { readContentRows } from '@/lib/storage/content-database';
import { refuseContentWrites } from '@/test/content-fixture';
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
    useViewerStore.setState({ idsStudioState: fixture.state, idsStudioContexts: fixture.contexts, idsStudioRevision: 0, idsStudioDraftId: null, idsStudioRejection: null });
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
  it('refuses malformed IDSZ base64 as caller input (#10871)', async () => {
    const result = await dispatchMainViewerTool(host, 'viewer_operation_inspect', {
      operation_id: 'ids.document.prepare', input: { format: 'idsz', content: '!', document_revision: 0 },
    });
    assert.equal(result.errorCode, 'INVALID_INPUT', result.text);
    assert.equal((result.structured as { reason: string }).reason, 'invalid-value');
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
  it('rejects a validation.results continuation from a different specification population (#10877)', async () => {
    const { content } = await call<{ content: string }>('ids.document.xml');
    const spec = content.match(/<specification\s[^>]*>[\s\S]*?<\/specification>/)?.[0];
    assert.ok(spec);
    const second = spec.replace(/name="[^"]*"/, 'name="Second specification"');
    const xml = content.replace('</specifications>', `${second}</specifications>`);
    const run = (xml: string) => call<{ run_id: string }>('validation.ids.run', { xml, scope: 'whole', entity_ids: [] });
    const { run_id } = await run(xml);
    const first = await call<{ next_offset: number; page_revision: string }>('validation.results', { run_id, offset: 0, limit: 1 });
    assert.equal(first.next_offset, 1); assert.ok(first.page_revision);
    const cursor = { offset: first.next_offset, page_revision: first.page_revision, limit: 1 };
    await call('validation.results', { run_id, ...cursor });
    const changed = await run(content);
    const result = await dispatchMainViewerTool(host, 'viewer_operation_inspect',
      { model_id: SAMPLE_MODEL, operation_id: 'validation.results', input: { run_id: changed.run_id, ...cursor } });
    assert.equal(result.errorCode, 'STATE_CHANGED', result.text);
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
  it('refuses to close or replace an IDS whose draft storage refused, then closes once it saves (#11013)', async () => {
    useViewerStore.getState().idsStudioOpen(fixture.doc);
    const draftId = useViewerStore.getState().idsStudioDraftId!;
    const refusal = refuseContentWrites();
    const execute = (operation_id: string, input: unknown) => dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id, input }, { canEdit: () => true });
    try {
      useViewerStore.getState().idsStudioDispatch([setSpecTextOp(fixture.specId, 'name', 'Unsaved walls')]);
      const revision = useViewerStore.getState().idsStudioRevision;
      const closed = await execute('ids.document.close', { document_revision: revision });
      assert.equal(closed.isError, true); assert.match(closed.text, /storage refused the write/);
      const replacement = await call<{ token: string }>('ids.document.prepare', { format: 'new', content: 'Replacement', document_revision: revision });
      const replaced = await execute('ids.candidate.apply', { token: replacement.token });
      assert.equal(replaced.isError, true); assert.match(replaced.text, /storage refused the write/);
      // The same refusal and retry hint survive both agent operation paths (#10871).
      for (const result of [closed, replaced]) {
        assert.equal(result.errorCode, 'INTERNAL_ERROR');
        assert.deepEqual(result.structured, { reason: 'internal', save: 'refused' });
        assert.match(result.text, /Retry/);
      }
      const live = useViewerStore.getState();
      assert.equal(live.idsStudioDraftId, draftId); assert.equal(live.idsStudioState!.doc.ids.specifications[0].name, 'Unsaved walls');
      await closeIdsDraft(async () => true);
      assert.equal(useViewerStore.getState().idsStudioState, null);
      const unsavedDraft = useIdsStudioDraftLibrary.getState().entries.find(entry => entry.id === draftId);
      assert.ok(unsavedDraft);
      await switchIdsDraft(unsavedDraft);
      assert.equal(useViewerStore.getState().idsStudioState?.doc.ids.specifications[0].name, 'Unsaved walls');
      const closeAfterRestore = await execute('ids.document.close', { document_revision: useViewerStore.getState().idsStudioRevision });
      assert.equal(closeAfterRestore.isError, true);
      assert.match(closeAfterRestore.text, /storage refused the write/);
    } finally {
      refusal.mock.restore();
    }
    await call('ids.document.close', { document_revision: useViewerStore.getState().idsStudioRevision }, true);
    assert.equal(useViewerStore.getState().idsStudioState, null);
    const saved = (await readContentRows('idsStudioDrafts')).find(row => row.id === draftId)?.payload as IdsStudioDraft | undefined;
    assert.ok(saved?.document.includes('Unsaved walls'), 'close waited for the durable draft write');
  });
  it('refuses agent close without a retry hint when the draft can never be saved (#11013)', async () => {
    useViewerStore.getState().idsStudioOpen(fixture.doc);
    const outcome = useViewerStore.getState().idsStudioDispatch([setSpecTextOp(fixture.specId, 'name', 'x'.repeat(IDS_DRAFT_MAX_MIB * 1024 * 1024 + 1))]);
    assert.equal(outcome.ok, true);
    const closed = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'ids.document.close',
      input: { document_revision: useViewerStore.getState().idsStudioRevision } }, { canEdit: () => true });
    assert.equal(closed.isError, true); assert.match(closed.text, /too large/); assert.doesNotMatch(closed.text, /Retry/);
    assert.equal(closed.errorCode, 'INTERNAL_ERROR');
    assert.deepEqual(closed.structured, { reason: 'internal', save: 'tooLarge' });
    assert.notEqual(useViewerStore.getState().idsStudioState, null);
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
