/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import { viewerOperation } from './registry';
import type { ToolHost } from '../types';
import { BACK_WALL, BACK_WALL_NAME, GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { resetFeaturesForTest } from '@/lib/features';
import { setGlobalRendererRef } from '@/hooks/useBCF';
let host: ToolHost;
async function seed() {
  resetFeaturesForTest(); await seedAuthoringSample();
  const state = useViewerStore.getState(), model = state.models.get(SAMPLE_MODEL)!;
  let maxExpressId = 0; for (const id of model.ifcDataStore!.entities.expressId) maxExpressId = Math.max(maxExpressId, id);
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, maxExpressId }]]) });
  useViewerStore.setState({ zoneSets: [], zoneAssignments: new Map(), changeSets: new Map(), activeChangeSetId: null });
  host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
}
const invoke = (id: string, input: unknown = {}, write = false, canEdit = true) => dispatchMainViewerTool(host, write ? 'viewer_operation_execute' : 'viewer_operation_inspect', {
  ...(viewerOperation(id).needs === 'model' ? { model_id: SAMPLE_MODEL } : {}), operation_id: id, input,
}, { canEdit: () => canEdit });
function answer<T>(result: AgentToolResult): T {
  assert.equal(result.isError, false, result.text);
  const value = (result.structured as { result: { native_json?: string } }).result;
  return (value?.native_json === undefined || Object.keys(value).length > 1 ? value : JSON.parse(value.native_json)) as T;
}
const zoneRevision = async () => answer<{ configuration_revision: string }>(await invoke('zones.read')).configuration_revision;
const proposal = () => JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Numerical annex', units: 'm', frame: 'storey-local', operations: [
  { op: 'element.create', ref: 'wall-a', ifcClass: 'IfcWall', storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }, name: 'Numerical wall', params: { start: [10, 10, 0], end: [14, 10, 0], thickness: 0.2, height: 3 } },
] });
describe('native reviewed authoring operations (full automation follow-up #10525)', () => {
  beforeEach(seed);
  it('requires write admission before publishing zone calculations (#11215)', async () => {
    const timing = { elapsedMs: 0, elementCount: 0, zoneSetCount: 0, computedAt: 1 };
    useViewerStore.setState({ zoneAssignmentTiming: timing, zoneApportionment: new Map() });
    setGlobalRendererRef({ current: { getScene: () => ({ getBounds: () => null, getMeshDataPieces: () => [] }) } } as never);
    try {
      const rejected = await invoke('zones.assign', {}, false, false);
      assert.equal(rejected.isError, true, rejected.text);
      assert.equal(useViewerStore.getState().zoneAssignmentTiming, timing);
      answer(await invoke('zones.assign', {}, true));
      assert.notEqual(useViewerStore.getState().zoneAssignmentTiming, timing);

      const set_id = useViewerStore.getState().createZoneSet('Admission');
      const refused = await invoke('zones.apportion', { set_id }, true, false);
      assert.equal(refused.errorCode, 'READ_ONLY', refused.text);
      assert.equal(useViewerStore.getState().zoneApportionment.has(set_id), false);
      answer(await invoke('zones.apportion', { set_id }, true));
      assert.equal(useViewerStore.getState().zoneApportionment.has(set_id), true);
    } finally {
      setGlobalRendererRef({ current: null });
    }
  });

  it('exports.modelIfcx refuses a changes-only export when the model has no pending changes', async () => {
    useViewerStore.setState({ mutationViews: new Map() });
    const result = await invoke('exports.modelIfcx', { changes_only: true, include_geometry: false, apply_mutations: true, visible_only: false, only_known_properties: false }, true);
    assert.equal(result.isError, true);
    assert.match(result.text, /no pending changes/);
  });
  it('previews a real authoring model without writes, commits one native batch and exports a referentially valid IFC graph', async () => {
    const view = useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!, before = view.getNewEntities().length;
    const prepared = answer<{ token: string; preview_json: string }>(await invoke('authoring.prepare', { proposal_json: proposal() }));
    const preview = JSON.parse(prepared.preview_json) as { rows: Array<{ status: string }> };
    assert.deepEqual(preview.rows.map(row => row.status), ['ready']); assert.equal(view.getNewEntities().length, before);
    const applied = answer<{ receipt_json: string }>(await invoke('authoring.apply', { token: prepared.token }, true));
    const receipt = JSON.parse(applied.receipt_json) as { batches: Array<{ batchId: string }>; applied: unknown[] };
    assert.equal(receipt.batches.length, 1); assert.ok(receipt.applied.length > 0);
    const stack = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)!;
    assert.ok(stack.length > 0); assert.ok(stack.every(row => useViewerStore.getState().mutationBatchTags.get(row.id) === receipt.batches[0].batchId));
    const source = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!;
    const bytes = editedModelBytes(source, view); assert.equal(danglingReferences(new TextDecoder().decode(bytes)).length, 0);
    const count = view.getNewEntities().length;
    answer(await invoke('authoring.apply', { token: prepared.token }, true)); assert.equal(view.getNewEntities().length, count, 'apply token is idempotent');
    answer(await invoke('changes.history', { direction: 'undo' }, true));
    assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0, 0);
  });
  it('refuses revoked grants and stale preview revisions without creating elements', async () => {
    const prepared = answer<{ token: string }>(await invoke('authoring.prepare', { proposal_json: proposal() }));
    const view = useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!, before = view.getNewEntities().length;
    assert.equal((await invoke('authoring.apply', { token: prepared.token }, true, false)).isError, true);
    const source = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!, id = source.entities.getExpressIdByGlobalId(BACK_WALL);
    useViewerStore.getState().setAttribute(SAMPLE_MODEL, id, 'Name', 'Concurrent edit');
    assert.equal((await invoke('authoring.apply', { token: prepared.token }, true)).isError, true);
    assert.equal(view.getNewEntities().length, before);
  });
  it('binds prepared authoring tokens to their host and model source', async () => {
    const prepared = answer<{ token: string }>(await invoke('authoring.prepare', { proposal_json: proposal() }));
    const oldHost = host; host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    assert.equal((await invoke('authoring.apply', { token: prepared.token }, true)).isError, true); host = oldHost;
    await seedAuthoringSample();
    assert.equal((await invoke('authoring.apply', { token: prepared.token }, true)).isError, true);
  });
  it('routes scalar attributes through the native expected-value review and conflict-aware revert', async () => {
    const json = JSON.stringify({ version: 1, kind: 'model.changes', title: 'Exact name', changes: [
      { op: 'attribute.set', target: { globalId: BACK_WALL, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: BACK_WALL_NAME }, name: 'Name', expected: BACK_WALL_NAME, value: 'Reviewed name' },
    ] });
    const prepared = answer<{ token: string }>(await invoke('properties.prepare', { proposal_json: json }));
    answer(await invoke('authoring.apply', { token: prepared.token }, true));
    const rows = answer<Array<{ id: string }>>(await invoke('changes.read')); assert.equal(rows.length, 1);
    const revert = answer<{ token: string }>(await invoke('changes.revert.prepare', { id: rows[0].id }));
    answer(await invoke('changes.revert.apply', { token: revert.token }, true));
    const id = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!.entities.getExpressIdByGlobalId(BACK_WALL);
    assert.equal(useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)?.getAttributeMutationsForEntity(id).find(row => row.name === 'Name')?.value ?? BACK_WALL_NAME, BACK_WALL_NAME);
  });
  it('captures exact native Group membership evidence and applies its native reviewed graph', async () => {
    const store = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!, expressId = store.entities.getExpressIdByGlobalId(BACK_WALL);
    const evidence = answer<{ elements: Array<{ nativeGroup: { status: string; snapshot: unknown } }> }>(await invoke('authoring.nativeEvidence', { express_ids: [expressId] }));
    assert.equal(evidence.elements[0].nativeGroup.status, 'available');
    const proposal_json = JSON.stringify({ version: 1, kind: 'group.lifecycle', title: 'Exact group', modelId: SAMPLE_MODEL, expected: evidence.elements[0].nativeGroup.snapshot,
      operations: [{ op: 'group.create', params: { Name: 'Operation group', RelatedObjects: [{ expressId, GlobalId: BACK_WALL }] } }] });
    const prepared = answer<{ token: string }>(await invoke('authoring.group.prepare', { proposal_json }));
    const result = answer<{ receipt: { applied: Array<{ expressId: number; globalId: string }> } }>(await invoke('authoring.graph.apply', { token: prepared.token }, true));
    const group = result.receipt.applied[0];
    const read = host.models()[0].bim.store.readGroup({ modelId: SAMPLE_MODEL, expressId: group.expressId, GlobalId: group.globalId });
    assert.equal(read.Name, 'Operation group'); assert.ok(read.memberships.length > 0);
    const bytes = editedModelBytes(store, useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!); assert.equal(danglingReferences(new TextDecoder().decode(bytes)).length, 0);
  });
  it('keeps change-set import staging distinct from applying model edits (#10796)', async () => {
    const made = answer<{ id: string }>(await invoke('changeSets.create', { name: 'Native staging' }, true));
    const store = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!;
    const expressId = store.entities.getExpressIdByGlobalId(BACK_WALL);
    const edit = useViewerStore.getState().setAttribute(SAMPLE_MODEL, expressId, 'Name', 'Staged wall', BACK_WALL_NAME);
    assert.ok(edit);

    const { artifact_id } = answer<{ artifact_id: string }>(await invoke('changeSets.export', { id: made.id }, true));
    const read = await dispatchMainViewerTool(host, 'viewer_artifact_read', { artifact_id });
    assert.equal(read.isError, false, read.text);
    const chunk = read.structured as { data: string; next_offset: number | null };
    assert.equal(chunk.next_offset, null);
    const json = Buffer.from(chunk.data, 'base64').toString('utf8');

    assert.equal(answer<{ changed: boolean }>(await invoke('changes.history', { direction: 'undo' }, true)).changed, true);
    answer(await invoke('changeSets.discard', { id: made.id }, true));
    assert.equal(useViewerStore.getState().changeSets.has(made.id), false);
    const before = useViewerStore.getState().mutationVersion;
    const imported = answer<{ id: string; applied: boolean }>(await invoke('changeSets.import', { json }, true));
    assert.equal(imported.applied, false);
    const state = useViewerStore.getState();
    assert.deepEqual(state.changeSets.get(imported.id)?.mutations, [edit]);
    assert.equal(state.mutationVersion, before);
    const name = state.getMutationView(SAMPLE_MODEL)?.getAttributeMutationsForEntity(expressId).find(row => row.name === 'Name')?.value;
    assert.equal(name ?? store.entities.getName(expressId), BACK_WALL_NAME);
  });
  it('refuses malformed mutation rows before staging a change set (#10795 item 31)', async () => {
    const common = { id: 'wrong', timestamp: 0, modelId: SAMPLE_MODEL, entityId: 1 };
    for (const mutation of [
      null, 17, { ...common, type: 'constructor' }, { ...common, type: '__proto__' },
      { ...common, type: 'UPDATE_ATTRIBUTE' },
      { ...common, type: 'UPDATE_ATTRIBUTE', attributeName: 'Name' },
    ]) {
      const result = await invoke('changeSets.import', { json: JSON.stringify({ changeSet: { name: 'Malformed', mutations: [mutation] } }) }, true);
      assert.equal(result.isError, true);
      assert.match(result.text, /Invalid native change-set file/);
    }
    assert.equal(useViewerStore.getState().changeSets.size, 0);
  });
  it('exports an imported change set with a long title and preserves its file extension (#10795 item 61)', async () => {
    const name = 'Imported building review '.repeat(35);
    const { id } = answer<{ id: string }>(await invoke('changeSets.import', { json: JSON.stringify({ changeSet: { name, mutations: [] } }) }, true));
    const result = answer<{ filename: string }>(await invoke('changeSets.export', { id }, true));
    assert.match(result.filename, /^Imported-building-review.*\.changeset\.json$/);
    assert.ok(result.filename.length <= 60, 'the artifact filename must fit the 60-character limit');
    assert.equal(useViewerStore.getState().changeSets.get(id)?.name, name);
  });
  it('reports the failed native property transaction reason (#10795 item 54)', async () => {
    const store = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!;
    const express_id = store.entities.getExpressIdByGlobalId(BACK_WALL);
    useViewerStore.setState({ mutationViews: new Map() });
    const result = await invoke('properties.reassignClass', { express_id, IfcClass: 'IfcSlab',
      PredefinedType: '', expected_class: store.entities.getTypeName(express_id) }, true);
    assert.equal(result.isError, true);
    assert.match(result.text, /Native retype refused/);
  });
  it('configures zones and stages change sets with no IFC model loaded', async () => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, activeModelId: null });
    const made = answer<{ set_id: string }>(await invoke('zones.set.create', { name: 'Planning boxes', expected_configuration: await zoneRevision() }, true));
    assert.ok(made.set_id);
    const changeSet = answer<{ id: string }>(await invoke('changeSets.create', { name: 'Future changes' }, true));
    assert.equal(useViewerStore.getState().activeChangeSetId, changeSet.id);
  });
  it('uses native zone configuration validation and refuses stale configuration writes', async () => {
    const made = answer<{ set_id: string }>(await invoke('zones.set.create', { name: 'Sections', expected_configuration: await zoneRevision() }, true));
    const snapshot = await zoneRevision();
    answer(await invoke('zones.box.write', { set_id: made.set_id, zone_id: '', name: 'A', center: [0, 1, 0], size: [3, 2, 3], rotationY: 0, expected_configuration: snapshot }, true));
    assert.equal(useViewerStore.getState().zoneSets[0].zones.length, 1);
    assert.equal((await invoke('zones.set.edit', { set_id: made.set_id, action: 'rename', name: 'Changed', visible: true, expected_configuration: snapshot }, true)).isError, true);
    assert.equal((await invoke('zones.assign', {}, true)).isError, true, 'a missing renderer must not be an empty successful evaluation');
  });
  it('adds native inspector properties transactionally and refuses a stale inherited-property snapshot', async () => {
    const state = useViewerStore.getState(), store = state.models.get(SAMPLE_MODEL)!.ifcDataStore!, express_id = store.entities.getExpressIdByGlobalId(BACK_WALL);
    const snapshot = answer<{ expected_properties: string }>(await invoke('properties.inherited.read', { express_id }));
    const input = { express_id, pset: 'Pset_AutomationReview', properties: [{ name: 'Reviewed', type: 3, value: true }], expected_properties: snapshot.expected_properties };
    answer(await invoke('properties.add', input, true));
    assert.equal(state.mutationViews.get(SAMPLE_MODEL)!.getForEntity(express_id).find(pset => pset.name === input.pset)?.properties.find(property => property.name === 'Reviewed')?.value, true);
    assert.equal((await invoke('properties.add', input, true)).isError, true);
    answer(await invoke('changes.history', { direction: 'undo' }, true));
    assert.equal(state.mutationViews.get(SAMPLE_MODEL)!.getForEntity(express_id).some(pset => pset.name === input.pset), false);
  });

  it('enforces network effect admission and suppresses a bSDD result after host disposal', async () => {
    const lifetime = new AbortController(); let requests = 0;
    let release: (() => void) | undefined, started: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }), {
      lifetimeSignal: lifetime.signal,
      bsdd: { search: async () => { requests++; started!(); await pending; return []; },
        fetchClassInfo: async () => assert.fail('Unexpected class request'), getPropertySets: async () => assert.fail('Unexpected property request'), searchRelatedClasses: async () => assert.fail('Unexpected related request') },
    });
    const refused = await invoke('properties.bsdd.search', { query: 'IfcWall' });
    assert.equal(refused.isError, true); assert.equal(requests, 0);
    const running = invoke('properties.bsdd.search', { query: 'IfcWall' }, true);
    await Promise.race([ready, running]); assert.equal(requests, 1); lifetime.abort(); release!();
    const result = await running; assert.equal(result.isError, true);
  });

});
