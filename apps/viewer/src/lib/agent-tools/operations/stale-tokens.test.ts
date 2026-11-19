/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #10792: operation tokens and candidates must not go stale, leak capacity, or replay over newer state. */
import '@/test/setup-dom.js';
import { refuseContentWrites } from '@/test/content-fixture';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { modelChangeLibrary, useModelChangeReceipts } from '@/lib/actions/receipts';
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { resetFeaturesForTest } from '@/lib/features';
import type { ZoneSet } from '@/lib/zones';
import { BACK_WALL, BACK_WALL_NAME, SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { wallFixture } from '@/test/ids-studio-fixture';
import { loadIdsStudioRuntime } from '@/lib/ids-studio/runtime-loader';
import { setSpecTextOp } from '@/lib/ids-studio/ops';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { model, parseStep, seed } from '@/test/agent-tools-fixture';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import type { ToolHost } from '../types';
import { viewerOperation } from './registry';
import { idsOperations } from './ids-studio';
import { clashSettings } from './clash-native';

let host: ToolHost;
let modelId = SAMPLE_MODEL;
const newHost = () => { host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) })); };
const invoke = (id: string, input: unknown = {}, write = false, canEdit: () => boolean = () => true) =>
  dispatchMainViewerTool(host, write ? 'viewer_operation_execute' : 'viewer_operation_inspect', {
    ...(viewerOperation(id).needs === 'model' ? { model_id: modelId } : {}), operation_id: id, input,
  }, { canEdit });
function answer<T>(result: AgentToolResult): T {
  assert.equal(result.isError, false, result.text);
  const value = (result.structured as { result: { native_json?: string } }).result;
  return (value?.native_json === undefined || Object.keys(value).length > 1 ? value : JSON.parse(value.native_json)) as T;
}
const rename = (value: string) => JSON.stringify({ version: 1, kind: 'model.changes', title: 'Exact name', changes: [
  { op: 'attribute.set', target: { globalId: BACK_WALL, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: BACK_WALL_NAME }, name: 'Name', expected: BACK_WALL_NAME, value },
] });
const prepareRename = async (value = 'Reviewed name') => answer<{ token: string }>(await invoke('properties.prepare', { proposal_json: rename(value) })).token;
const storedReceipt = (id: string) => useModelChangeReceipts.getState().entries.find(row => row.id === id);
async function markUndone(receipt: ModelChangeReceipt) {
  assert.equal(await modelChangeLibrary.put(receipt.id, { ...receipt, status: 'undone', undoneAt: new Date(0).toISOString() }), true);
  assert.equal(storedReceipt(receipt.id)?.status, 'undone');
}
async function groupProposal() {
  const store = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!, expressId = store.entities.getExpressIdByGlobalId(BACK_WALL);
  const evidence = answer<{ elements: Array<{ nativeGroup: { snapshot: unknown } }> }>(await invoke('authoring.nativeEvidence', { express_ids: [expressId] }));
  return JSON.stringify({ version: 1, kind: 'group.lifecycle', title: 'Exact group', modelId: SAMPLE_MODEL, expected: evidence.elements[0].nativeGroup.snapshot,
    operations: [{ op: 'group.create', params: { Name: 'Operation group', RelatedObjects: [{ expressId, GlobalId: BACK_WALL }] } }] });
}

describe('reviewed model candidates (#10792)', () => {
  beforeEach(async () => {
    resetFeaturesForTest(); modelId = SAMPLE_MODEL; await seedAuthoringSample();
    // The evidence capture bounds ids by the model's watermark, as the loader sets it.
    const sample = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    let maxExpressId = 0; for (const id of sample.ifcDataStore!.entities.expressId) maxExpressId = Math.max(maxExpressId, id);
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...sample, maxExpressId }]]),
      zoneSets: [], zoneAssignments: new Map(), changeSets: new Map(), activeChangeSetId: null });
    newHost();
  });

  it('#19: a stale candidate can be discarded, and candidates of a replaced model free their capacity', async () => {
    const token = await prepareRename();
    const store = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!;
    useViewerStore.getState().setAttribute(SAMPLE_MODEL, store.entities.getExpressIdByGlobalId(BACK_WALL), 'Description', 'Concurrent edit');
    answer(await invoke('authoring.discard', { token }));
    for (let i = 0; i < 64; i++) await prepareRename(`Name ${i}`);
    assert.equal((await invoke('properties.prepare', { proposal_json: rename('One too many') })).isError, true, 'a host of 64 pending candidates is full');
    await seedAuthoringSample(); // the same model id, a new store: the 64 can never apply
    await prepareRename('After reload');
  });

  it('#20: replaying an applied token keeps the receipt the Changes panel marked undone', async () => {
    const token = await prepareRename();
    const applied = answer<{ receipt_json: string; persisted: boolean }>(await invoke('authoring.apply', { token }, true));
    assert.equal(applied.persisted, true);
    const receipt = JSON.parse(applied.receipt_json) as ModelChangeReceipt;
    await markUndone(receipt);
    const replay = answer<{ receipt_json: string; persisted: boolean }>(await invoke('authoring.apply', { token }, true));
    assert.equal(replay.persisted, true);
    assert.equal(storedReceipt(receipt.id)?.status, 'undone');
  });

  it('#20: replaying an applied graph token keeps its undone receipt too', async () => {
    const { token } = answer<{ token: string }>(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
    const { receipt } = answer<{ receipt: ModelChangeReceipt }>(await invoke('authoring.graph.apply', { token }, true));
    await markUndone(receipt);
    answer(await invoke('authoring.graph.apply', { token }, true));
    assert.equal(storedReceipt(receipt.id)?.status, 'undone');
  });

  it('#32: revert candidates never lock the host out', async () => {
    answer(await invoke('authoring.apply', { token: await prepareRename() }, true));
    const [change] = answer<Array<{ id: string }>>(await invoke('changes.read'));
    for (let i = 0; i < 65; i++) answer(await invoke('changes.revert.prepare', { id: change.id }));
  });

  it('#52: two concurrent graph prepares cannot both take the last place', async () => {
    const proposal_json = await groupProposal();
    for (let i = 0; i < 31; i++) answer(await invoke('authoring.group.prepare', { proposal_json }));
    const results = await Promise.all([invoke('authoring.group.prepare', { proposal_json }), invoke('authoring.group.prepare', { proposal_json })]);
    assert.deepEqual(results.map(result => result.isError).sort(), [false, true]);
  });

});

describe('multi-batch IDS corrections (#10792)', () => {
  const WALLS = 501; // one past MODEL_CHANGE_LIMIT: two change batches
  const guid = (id: number) => `0${String(id).padStart(4, '0')}`.padEnd(22, 'w');
  beforeEach(async () => {
    resetFeaturesForTest(); modelId = 'walls';
    const body = Array.from({ length: WALLS }, (_, i) => `#${i + 1}=IFCWALL('${guid(i + 1)}',$,'Wall ${i + 1}',$,$,$,$,$,.STANDARD.);`).join('\n');
    const step = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${body}\nENDSEC;\nEND-ISO-10303-21;\n`;
    seed([model('walls', await parseStep(new TextEncoder().encode(step)))]);
    newHost();
  });

  it('#68: a correction whose later batch fails stages none of its batches', async () => {
    const renameWall = (value: string) => JSON.stringify({ version: 1, kind: 'model.changes', title: 'Name', changes: [
      { op: 'attribute.set', target: { globalId: guid(1), modelId: 'walls', ifcClass: 'IfcWall', name: 'Wall 1' }, name: 'Name', expected: 'Wall 1', value }] });
    for (let i = 0; i < 63; i++) answer(await invoke('properties.prepare', { proposal_json: renameWall(`Name ${i}`) }));
    // The first batch takes the 64th place and the second is refused.
    const express_ids = Array.from({ length: WALLS }, (_, i) => i + 1);
    const fix = await invoke('validation.fix.prepare', { express_ids, pset: 'Pset_Review', name: 'Checked', facet_data_type: '', raw_value: 'yes', title: 'Mark reviewed' });
    assert.equal(fix.isError, true);
    assert.match(fix.text, /At most 64/);
    answer(await invoke('properties.prepare', { proposal_json: renameWall('After the refused correction') }));
  });
});

describe('IDS candidates and validation runs (#10792)', () => {
  beforeEach(async () => {
    resetFeaturesForTest(); modelId = SAMPLE_MODEL; await seedAuthoringSample();
    const fixture = await wallFixture(); await loadIdsStudioRuntime();
    useViewerStore.setState({ idsStudioState: fixture.state, idsStudioContexts: fixture.contexts, idsStudioRevision: 0, idsStudioRejection: null });
    newHost();
  });
  const specId = () => useViewerStore.getState().idsStudioState!.doc.ids.specifications[0].id;
  const prepareOps = async (name: string) => answer<{ token: string }>(await invoke('ids.operations.prepare', {
    document_revision: useViewerStore.getState().idsStudioRevision, ops_json: JSON.stringify([setSpecTextOp(specId(), 'name', name)]) })).token;

  it('#38: concurrent applies dispatch once, and a discard during apply wins', async () => {
    const token = await prepareOps('Once');
    const [a, b] = await Promise.all([invoke('ids.candidate.apply', { token }, true), invoke('ids.candidate.apply', { token }, true)]);
    answer(a); answer(b);
    assert.equal(useViewerStore.getState().idsStudioState!.history.past.length, 1);
    const discarded = await prepareOps('Discarded');
    // A dispatched discard settles only after apply's short await, so run the discard operation's own
    // handler, which removes the candidate synchronously, from apply's grant check right after that await.
    const discardOperation = idsOperations.find(row => row.id === 'ids.candidate.discard')!;
    let discard: Promise<unknown> | undefined;
    const canEdit = () => {
      if (!discard && new Error().stack?.includes('writeGuard')) {
        discard = discardOperation.execute({ token: discarded }, { host, canEdit: () => true } as Parameters<typeof discardOperation.execute>[1]);
      }
      return true;
    };
    const apply = await invoke('ids.candidate.apply', { token: discarded }, true, canEdit);
    assert.ok(discard, 'the discard ran during the apply');
    await discard;
    assert.equal(apply.isError, true, apply.text);
    assert.equal(useViewerStore.getState().idsStudioState!.doc.ids.specifications[0].name, 'Once');
  });

  it('#63: applied candidates do not use up pending capacity', async () => {
    for (let i = 0; i < 64; i++) answer(await invoke('ids.candidate.apply', { token: await prepareOps(`Name ${i}`) }, true));
    await prepareOps('Still room');
  });

  it('#36: re-tagging models between run and publish refuses the run', async () => {
    const { content } = answer<{ content: string }>(await invoke('ids.document.xml'));
    const { run_id } = answer<{ run_id: string }>(await invoke('validation.ids.run', { xml: content, scope: 'whole', entity_ids: [] }));
    useViewerStore.setState(s => ({ modelTagAssignments: new Map(s.modelTagAssignments) }));
    const published = await invoke('validation.publish', { run_id }, true);
    assert.equal(published.isError, true);
    assert.match(published.text, /inputs changed/);
  });
});

describe('saved clash report deletion (#10792)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await seedCoincidentWalls(2);
    const s = useViewerStore.getState();
    s.clearClashExclusions(); s.setClashMode('hard'); s.setClashTolerance(0.002); s.setClashReportTouch(false);
    newHost();
  });
  async function savedReport(): Promise<string> {
    const input = { kind: 'all', preset_id: '', expected_model_ids: [...useViewerStore.getState().models.keys()], expected_settings: JSON.stringify(clashSettings()) };
    answer(await invoke('clash.run', input, true));
    answer(await invoke('clash.reports.save', { name: 'Coordination', run_seq: useViewerStore.getState().clashRunSeq }, true));
    return useViewerStore.getState().savedClashReports[0].id;
  }

  it('#2: deletion prepare refuses while dashboards cannot be read', async () => {
    const id = await savedReport();
    localStorage.setItem('ifc-lite-dashboards', '{}');
    const prepared = await invoke('clash.reports.delete.prepare', { id });
    assert.equal(prepared.isError, true);
    assert.match(prepared.text, /could not all be read/);
  });

  it('#1: a storage retry after the deleting call lost its grant restores the report', async () => {
    const id = await savedReport();
    const { token } = answer<{ token: string }>(await invoke('clash.reports.delete.prepare', { id }));
    let grant = true;
    const refused = refuseContentWrites();
    try { assert.equal((await invoke('clash.reports.delete.apply', { token }, true, () => grant)).isError, true); }
    finally { refused.mock.restore(); }
    assert.equal(useViewerStore.getState().savedClashReports.some(row => row.id === id), false, 'the staged deletion hides the report');
    grant = false;
    await useViewerStore.getState().retrySaveClashReports();
    assert.equal(useViewerStore.getState().savedClashReports.some(row => row.id === id), true, 'the refused guard restored it');
    assert.notEqual(useViewerStore.getState().savedClashReportsStorage.items[id], 'saving');
  });
});

describe('zone writeback and table export (#10792)', () => {
  const WALL_ID = 42;
  const STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('zones','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#5),$);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#${WALL_ID}=IFCWALL('0Wall00000000000000042',$,'Wall A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;
  const ZONE_SET: ZoneSet = { id: 'set-1', name: 'Takt areas', zones: [{ id: 'z-a', name: 'Takt A', center: [0, 0, 0], size: [10, 10, 10], rotationY: 0 }],
    visible: true, createdAt: 0, updatedAt: 0 };
  const mesh = (): MeshData => ({ expressId: WALL_ID, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] });
  const geometry = (meshes: MeshData[]): GeometryResult => ({ meshes, totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, hasLargeCoordinates: false } });
  const assignments = () => new Map([[WALL_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: false, touchedZoneIds: ['z-a'] } }]]) as never;
  const initial = useViewerStore.getState();
  beforeEach(async () => {
    resetFeaturesForTest(); modelId = 'm1';
    const result = geometry([mesh()]);
    seed([model('m1', await parseStep(new TextEncoder().encode(STEP)), { geometryResult: result })]);
    useViewerStore.setState({ geometryResult: result, zoneSets: [ZONE_SET], zoneApportionment: new Map(), zoneAssignments: assignments() });
    newHost();
  });
  afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });

  it('#23: writeback refuses when assignments were refreshed after review', async () => {
    const { token } = answer<{ token: string }>(await invoke('zones.writeback.prepare', { set_id: 'set-1', model_ids: ['m1'], basis: 'mesh', action: 'write' }));
    useViewerStore.setState({ zoneAssignments: assignments() });
    const applied = await invoke('zones.writeback.apply', { token }, true);
    assert.equal(applied.isError, true);
    assert.match(applied.text, /assignments changed/);
  });

  it('#28: the zone table export discards an artifact whose models changed while it encoded', async () => {
    const stop = useActivityJournal.subscribe(() => useViewerStore.setState(s => ({ mutationVersion: s.mutationVersion + 1 })));
    try {
      const exported = await invoke('zones.table.export', { set_id: 'set-1', basis: 'mesh', format: 'parquet' }, true);
      assert.equal(exported.isError, true, exported.text);
      assert.match(exported.text, /changed during export/);
    } finally { stop(); }
  });
});
