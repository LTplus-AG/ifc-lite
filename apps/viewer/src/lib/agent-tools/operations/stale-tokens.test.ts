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
import { isGroupingLens } from '@/lib/lens/custom-groupings';
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
    // An edit makes all 64 unapplyable ('Model changed since preview'), so they no longer hold their places.
    useViewerStore.getState().setAttribute(SAMPLE_MODEL, store.entities.getExpressIdByGlobalId(BACK_WALL), 'Description', 'Second edit');
    for (let i = 0; i < 64; i++) await prepareRename(`After edit ${i}`);
    await seedAuthoringSample(); // the same model id, a new store: these 64 can never apply either
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

  it('#20: a replay while the first receipt write is in flight does not write again', async () => {
    const token = await prepareRename();
    let writes = 0, replay: Promise<AgentToolResult> | undefined;
    const put = modelChangeLibrary.put;
    modelChangeLibrary.put = (...args) => {
      writes++;
      replay ??= invoke('authoring.apply', { token }, true); // the agent retries while the receipt is being saved
      return put(...args);
    };
    try {
      const first = answer<{ receipt_json: string }>(await invoke('authoring.apply', { token }, true));
      assert.ok(replay);
      assert.equal(answer<{ receipt_json: string }>(await replay).receipt_json, first.receipt_json);
    } finally { modelChangeLibrary.put = put; }
    assert.equal(writes, 1);
  });

  it('#20: a receipt write that threw keeps its candidate until a replay saves it', async () => {
    const token = await prepareRename();
    const put = modelChangeLibrary.put;
    modelChangeLibrary.put = async () => { throw new Error('storage failed'); };
    try { assert.equal((await invoke('authoring.apply', { token }, true)).isError, true); }
    finally { modelChangeLibrary.put = put; }
    for (let i = 0; i < 63; i++) await prepareRename(`Name ${i}`);
    assert.equal((await invoke('properties.prepare', { proposal_json: rename('One too many') })).isError, true, 'the unsaved receipt still holds a place');
    assert.equal(answer<{ persisted: boolean }>(await invoke('authoring.apply', { token }, true)).persisted, true);
  });

  it('#20: a receipt write that resolved false is the library\'s to retry: a replay does not write again, and the candidate frees its place', async () => {
    const token = await prepareRename();
    let writes = 0;
    const put = modelChangeLibrary.put;
    modelChangeLibrary.put = async () => { writes++; return false; };
    try {
      assert.equal(answer<{ persisted: boolean }>(await invoke('authoring.apply', { token }, true)).persisted, false);
      assert.equal(answer<{ persisted: boolean }>(await invoke('authoring.apply', { token }, true)).persisted, false);
    } finally { modelChangeLibrary.put = put; }
    assert.equal(writes, 1);
    for (let i = 0; i < 64; i++) await prepareRename(`Name ${i}`);
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

  it('#19: graph reviews of a replaced model free their capacity', async () => {
    const proposal_json = await groupProposal();
    for (let i = 0; i < 32; i++) answer(await invoke('authoring.group.prepare', { proposal_json }));
    assert.equal((await invoke('authoring.group.prepare', { proposal_json })).isError, true, 'a host of 32 pending reviews is full');
    await seedAuthoringSample(); // the same model id, a new store
    const sample = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    let maxExpressId = 0; for (const id of sample.ifcDataStore!.entities.expressId) maxExpressId = Math.max(maxExpressId, id);
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...sample, maxExpressId }]]) });
    answer(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
  });

  it('#19: 32 Group reviews an edit invalidated free the cap for a fresh prepare', async () => {
    const proposal_json = await groupProposal();
    for (let i = 0; i < 32; i++) answer(await invoke('authoring.group.prepare', { proposal_json }));
    const full = await invoke('authoring.group.prepare', { proposal_json });
    assert.equal(full.isError, true);
    assert.match(full.text, /At most 32 graph review candidates/);
    // Any edit to the model, a membership change included, moves the mutation revision each review captured, so
    // none of the 32 can pass validate() again.
    const store = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!;
    useViewerStore.getState().setAttribute(SAMPLE_MODEL, store.entities.getExpressIdByGlobalId(BACK_WALL), 'Description', 'Edited after review');
    answer(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
  });

  it('#19 guard: a temporary refusal such as Edit mode being off keeps prepared graph reviews', async () => {
    const { token } = answer<{ token: string }>(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
    const proposal_json = await groupProposal();
    useViewerStore.setState({ editEnabled: false });
    try {
      const refused = await invoke('authoring.group.prepare', { proposal_json });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /Edit mode/i);
    } finally { useViewerStore.setState({ editEnabled: true }); }
    answer(await invoke('authoring.graph.apply', { token }, true));
  });

  it('#19 guard: a revision bump that changes no source keeps prepared graph reviews', async () => {
    const { token } = answer<{ token: string }>(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
    useViewerStore.setState(s => ({ mutationVersion: s.mutationVersion + 1 })); // as a schedule or appearance command does
    answer(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
    answer(await invoke('authoring.graph.apply', { token }, true));
  });

  it('#19: Group reviews invalidated by a newly loaded model free the cap', async () => {
    const proposal_json = await groupProposal();
    for (let i = 0; i < 32; i++) answer(await invoke('authoring.group.prepare', { proposal_json }));
    const sample = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    // A second model changes the population every review bound, without an edit.
    useViewerStore.setState(s => ({ models: new Map([...s.models, ['second', { ...sample, id: 'second' }]]) }));
    answer(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
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

  it('#19 guard: a single-model session keeps its earlier candidates', async () => {
    const sample = useViewerStore.getState().models.get('walls')!;
    useViewerStore.setState({ models: new Map(), ifcDataStore: sample.ifcDataStore, activeModelId: null,
      mutationViews: new Map([['default', useViewerStore.getState().mutationViews.get('walls')!]]) });
    modelId = 'default';
    const renameLegacy = (value: string) => JSON.stringify({ version: 1, kind: 'model.changes', title: 'Name', changes: [
      { op: 'attribute.set', target: { globalId: guid(1), modelId: 'default', ifcClass: 'IfcWall', name: 'Wall 1' }, name: 'Name', expected: 'Wall 1', value }] });
    const first = answer<{ token: string }>(await invoke('properties.prepare', { proposal_json: renameLegacy('First') })).token;
    answer(await invoke('properties.prepare', { proposal_json: renameLegacy('Second') }));
    answer(await invoke('authoring.discard', { token: first })); // still held: the second prepare dropped nothing
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
  const rules_json = JSON.stringify({ version: 1, name: 'Delivery rules', rules: [{
    id: 'wall-name', name: 'Wall name is recorded',
    applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
    requirement: { kind: 'element', block: { groups: [{ rules: [{ kind: 'attribute', name: 'Name', op: 'isSet', value: '' }], combinator: 'AND' }], authoredAs: 'chips' } },
  }] });
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

  it('#63: applied and outdated candidates do not use up pending capacity', async () => {
    for (let i = 0; i < 64; i++) answer(await invoke('ids.candidate.apply', { token: await prepareOps(`Name ${i}`) }, true));
    for (let i = 0; i < 64; i++) await prepareOps(`Pending ${i}`);
    const full = await invoke('ids.operations.prepare', { document_revision: useViewerStore.getState().idsStudioRevision,
      ops_json: JSON.stringify([setSpecTextOp(specId(), 'name', 'One too many')]) });
    assert.equal(full.isError, true, 'a host of 64 pending candidates is full');
    useViewerStore.getState().idsStudioDispatch([setSpecTextOp(specId(), 'name', 'Edited in the panel')]); // all 64 are now outdated
    await prepareOps('Still room');
  });

  for (const edit of [
    { name: 'the model tag set', apply: () => useViewerStore.setState(s => ({ modelTags: new Map([...s.modelTags, ['tag-new', { id: 'tag-new', name: 'Phase 2' }]]) })) },
    { name: 'tag assignments', apply: () => useViewerStore.setState(s => ({ modelTagAssignments: new Map(s.modelTagAssignments) })) },
    { name: 'a grouping lens', apply: () => {
      const lenses = useViewerStore.getState().savedLenses, index = lenses.findIndex(isGroupingLens);
      assert.ok(index >= 0, 'a grouping lens to edit');
      useViewerStore.setState({ savedLenses: lenses.map((lens, i) => i === index ? { ...lens, name: `${lens.name} (edited)` } : lens) });
    } },
  ])
    it(`#36: editing ${edit.name} between a rules run and its publish refuses the run`, async () => {
      const run = async () => answer<{ run_id: string }>(await invoke('validation.rules.run', { rules_json, model_ids: [SAMPLE_MODEL] })).run_id;
      const control = await run();
      answer(await invoke('validation.publish', { run_id: control }, true));
      const run_id = await run();
      edit.apply();
      const published = await invoke('validation.publish', { run_id }, true);
      assert.equal(published.isError, true);
      assert.match(published.text, /inputs changed/);
    });

  it('#36: a rules run survives a colour-only lens, a recoloured grouping and a renamed tag', async () => {
    useViewerStore.setState({ modelTags: new Map([['tag-a', { id: 'tag-a', name: 'Phase 1' }]]) });
    const { run_id } = answer<{ run_id: string }>(await invoke('validation.rules.run', { rules_json, model_ids: [SAMPLE_MODEL] }));
    const lens = useViewerStore.getState().savedLenses.find(isGroupingLens)!;
    useViewerStore.setState(s => ({ savedLenses: [...s.savedLenses, { ...lens, id: 'colour-only', rules: [] }],
      modelTags: new Map([...s.modelTags].map(([id, tag]) => [id, { ...tag, name: `${tag.name} renamed` }])) })); // tag ids unchanged
    // Recolouring a grouping lens's rules changes no grouping either.
    useViewerStore.setState(s => ({ savedLenses: s.savedLenses.map(row => row.id === lens.id ? { ...row, rules: row.rules.map(rule => ({ ...rule, color: '#0000ff' })) } : row) }));
    answer(await invoke('validation.publish', { run_id }, true));
  });

  it('#36: an IDS run, which reads no tags or lenses, survives a lens edit', async () => {
    const { content } = answer<{ content: string }>(await invoke('ids.document.xml'));
    const { run_id } = answer<{ run_id: string }>(await invoke('validation.ids.run', { xml: content, scope: 'whole', entity_ids: [] }));
    // A grouping edit that would refuse a rules run (see above).
    useViewerStore.setState(s => ({ savedLenses: s.savedLenses.map(lens => isGroupingLens(lens) ? { ...lens, name: `${lens.name} (edited)` } : lens) }));
    answer(await invoke('validation.publish', { run_id }, true));
  });
});

describe('saved clash report deletion (#10792)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await seedCoincidentWalls(2);
    const s = useViewerStore.getState();
    s.clearClashExclusions(); s.setClashMode('hard'); s.setClashTolerance(0.002); s.setClashReportTouch(false);
    newHost();
    answer(await invoke('document.initialize', {}, true));
  });
  async function savedReport(): Promise<string> {
    const input = { kind: 'all', preset_id: '', expected_model_ids: [...useViewerStore.getState().models.keys()], expected_settings: JSON.stringify(clashSettings()) };
    answer(await invoke('clash.run', input, true));
    answer(await invoke('clash.reports.save', { name: 'Coordination', run_seq: useViewerStore.getState().clashRunSeq }, true));
    return useViewerStore.getState().savedClashReports[0].id;
  }

  it('#2: deletion prepare refuses while documents are unopened or dashboards cannot be read', async () => {
    const id = await savedReport();
    const opened = useViewerStore.getState().documentsStorage;
    useViewerStore.setState({ documentsStorage: { ...opened, phase: 'loading' } }); // as before the library is opened
    const unopened = await invoke('clash.reports.delete.prepare', { id });
    assert.equal(unopened.isError, true);
    assert.match(unopened.text, /document.initialize/);
    useViewerStore.setState({ documentsStorage: opened });
    answer(await invoke('clash.reports.delete.prepare', { id }));
    localStorage.setItem('ifc-lite-dashboards', '{}');
    const prepared = await invoke('clash.reports.delete.prepare', { id });
    assert.equal(prepared.isError, true);
    assert.match(prepared.text, /could not be read/);
    // One invalid dashboard is reported in the preview, not a lockout: it cannot be repaired by retrying.
    localStorage.setItem('ifc-lite-dashboards', JSON.stringify([{ broken: true }]));
    const flagged = answer<{ preview: { omittedDashboards: number } }>(await invoke('clash.reports.delete.prepare', { id }));
    assert.equal(flagged.preview.omittedDashboards, 1);
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

  it('#23: writeback refuses changed assignments, not an identical rebuild', async () => {
    const prepare = async () => answer<{ token: string }>(await invoke('zones.writeback.prepare', { set_id: 'set-1', model_ids: ['m1'], basis: 'mesh', action: 'write' })).token;
    const rebuilt = await prepare();
    useViewerStore.setState({ zoneAssignments: assignments() }); // what the sync does after any geometry tick, a recolour included
    answer(await invoke('zones.writeback.apply', { token: rebuilt }, true));
    const changed = await prepare();
    useViewerStore.setState({ zoneAssignments: new Map([[WALL_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a'] } }]]) as never });
    const applied = await invoke('zones.writeback.apply', { token: changed }, true);
    assert.equal(applied.isError, true);
    assert.match(applied.text, /assignments changed/);
  });

  for (const change of [
    { name: 'an edit', apply: () => useViewerStore.setState(s => ({ mutationVersion: s.mutationVersion + 1 })) },
    { name: 'an unloaded model', apply: () => useViewerStore.setState({ models: new Map() }) },
    { name: 'new assignments', apply: () => useViewerStore.setState({ zoneAssignments: new Map() }) },
  ])
    it(`#28: the zone table export discards an artifact after ${change.name} while it encoded`, async () => {
      let changed = false;
      const stop = useActivityJournal.subscribe(() => { if (!changed) { changed = true; change.apply(); } });
      try {
        const exported = await invoke('zones.table.export', { set_id: 'set-1', basis: 'mesh', format: 'parquet' }, true);
        assert.equal(changed, true);
        assert.equal(exported.isError, true, exported.text);
        assert.match(exported.text, /changed during export/);
      } finally { stop(); }
    });
});
