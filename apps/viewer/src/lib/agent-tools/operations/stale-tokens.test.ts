/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #10792: operation tokens and candidates must not go stale, leak capacity, or replay over newer state. */
import '@/test/setup-dom.js';
import { refuseContentWrites } from '@/test/content-fixture';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock, type TestContext } from 'node:test';
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
import { configuredView, model, parseStep, seed } from '@/test/agent-tools-fixture';
import type { Renderer } from '@ifc-lite/renderer';
import { Scene } from '../../../../../../packages/renderer/src/scene';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { recomputeZoneAssignmentsNow } from '@/hooks/useZoneAssignmentSync';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { nativeZoneEmissionEvidence } from '@/lib/actions/zone-emission-evidence';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { seedReviewedRoom, roomProposal, roomEnvelope } from '@/test/reviewed-room-fixture';
import { MODEL as ROOM_MODEL } from '@/test/native-sdk-model';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { prepareRoomReview } from '@/lib/actions/room-review';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import type { ToolHost } from '../types';
import { viewerOperation } from './registry';
import { idsOperations } from './ids-studio';
import { isGroupingLens } from '@/lib/lens/custom-groupings';
import { clashSettings } from './clash-native';
import { listArtifacts } from './artifacts';

let host: ToolHost;
let modelId = SAMPLE_MODEL;
const newHost = () => { host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) })); };
const invoke = (id: string, input: unknown = {}, write = false, canEdit: () => boolean = () => true) =>
  dispatchMainViewerTool(host, write ? 'viewer_operation_execute' : 'viewer_operation_inspect', {
    ...(viewerOperation(id).needs === 'model' ? { model_id: modelId } : {}), operation_id: id, input,
  }, { canEdit });
/**
 * Cancel the tool call right after `file` creates the token of the candidate it stores, so the executor refuses a result
 * the handler already stored (#10918). Returns that token: the caller never received it.
 */
async function refusedAfterToken(file: string, id: string, input: unknown, write = false) {
  const controller = new AbortController(), uuid = crypto.randomUUID.bind(crypto);
  let token: string | undefined;
  const spy = mock.method(crypto, 'randomUUID', () => {
    const value = uuid();
    if (token === undefined && new Error().stack?.includes(file)) { token = value; queueMicrotask(() => controller.abort()); }
    return value;
  });
  try {
    const refused = await dispatchMainViewerTool(host, write ? 'viewer_operation_execute' : 'viewer_operation_inspect', {
      ...(viewerOperation(id).needs === 'model' ? { model_id: modelId } : {}), operation_id: id, input,
    }, { canEdit: () => true, signal: controller.signal });
    // The dispatch answers the cancellation at once; the executor refuses the handler's result just after.
    for (let tick = 0; tick < 50; tick++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(refused.isError, true, 'the call was refused');
    assert.ok(token, `${file} stored a candidate before the refusal`);
    return token;
  } finally { spy.mock.restore(); }
}
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
    // A reload under the same model id with the revision held: only the store check can free these 64.
    const revision = useViewerStore.getState().mutationVersion, before = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore;
    await seedAuthoringSample();
    useViewerStore.setState({ mutationVersion: revision });
    const after = useViewerStore.getState().models.get(SAMPLE_MODEL)?.ifcDataStore;
    assert.ok(after && after !== before, 'same model id, a new store');
    await prepareRename('After reload');
  });

  it('distinguishes a failed native commit from an unchanged proposal (#10871)', async (t) => {
    const token = await prepareRename();
    const original = useViewerStore.getState().setAttribute;
    const undo = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0;
    useViewerStore.setState({ setAttribute: () => { throw new Error('Native attribute writer failed'); } });
    t.after(() => useViewerStore.setState({ setAttribute: original }));
    const failed = await invoke('authoring.apply', { token }, true);
    assert.equal(failed.errorCode, 'INTERNAL_ERROR', failed.text);
    assert.equal((failed.structured as { reason: string }).reason, 'internal');
    assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0, undo);
    const unchanged = await invoke('authoring.apply', { token: await prepareRename(BACK_WALL_NAME) }, true);
    assert.equal(unchanged.errorCode, 'INVALID_INPUT', unchanged.text);
    assert.equal((unchanged.structured as { reason: string }).reason, 'invalid-value');
  });
  for (const [operation, input] of [
    ['authoring.defaults.dimension', { kind: 'wall', field: 'unknown', metres: 1, expected_defaults: '{}' }],
    ['zones.set.edit', { set_id: 'unknown', action: 'remove', name: '', visible: true, expected_configuration: '1:0' }],
    ['clash.reports.write', { action: 'rename', id: 'unknown', name: 'Report', report_json: '', expected_reports: '1:0' }],
    ['clash.presets.write', { action: 'delete', id: 'unknown', preset_json: '', enabled: false, expected_presets: '[]' }],
    ['validation.manual.answer', { item_id: 'unknown', fingerprint: 'A', status: 'pass', comment: '', expected_library: '{}' }],
  ] as const) {
    it(`${operation} identifies a missing target before comparing a stale snapshot (#10871)`, async () => {
      const result = await invoke(operation, input, true);
      assert.equal(result.errorCode, 'INVALID_INPUT', result.text);
      assert.equal((result.structured as { reason: string }).reason, 'unknown-target');
    });
  }

  for (const [feature, id, input] of [
    ['tools.section', 'section.box', { min: [0, 0, 0], max: [1, 2, 3] }],
    ['check.clash', 'clash.run', {}],
  ] as const) {
    it(`a disabled ${feature} operation returns a permission denial (#10871)`, async (t) => {
      resetFeaturesForTest({ default: 'all', disable: [feature] });
      t.after(() => resetFeaturesForTest());
      const result = await invoke(id, input, true);
      assert.equal(result.errorCode, 'PERMISSION_DENIED', result.text);
      assert.equal((result.structured as { reason: string }).reason, 'disabled');
    });
  }

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
    modelChangeLibrary.put = async (...args) => {
      writes++;
      // Hold the first write open while the agent retries, so the replay must find the write still in flight.
      replay ??= invoke('authoring.apply', { token }, true);
      for (let tick = 0; tick < 100; tick++) await new Promise(resolve => setTimeout(resolve, 0));
      return put(...args);
    };
    try {
      const first = answer<{ receipt_json: string }>(await invoke('authoring.apply', { token }, true));
      assert.ok(replay);
      assert.equal(answer<{ receipt_json: string }>(await replay).receipt_json, first.receipt_json);
    } finally { modelChangeLibrary.put = put; }
    assert.equal(writes, 1);
  });

  it('#20: a receipt write that throws before the library holds the receipt is put again by the replay', async () => {
    const token = await prepareRename();
    const put = modelChangeLibrary.put;
    // Defensive: the real library records a draft before its first await, so only a throw before that reaches here.
    modelChangeLibrary.put = () => { throw new Error('Library unavailable'); };
    try { assert.equal((await invoke('authoring.apply', { token }, true)).isError, true); } finally { modelChangeLibrary.put = put; }
    const replay = answer<{ receipt_json: string; persisted: boolean }>(await invoke('authoring.apply', { token }, true));
    assert.equal(replay.persisted, true);
    const receipt = JSON.parse(replay.receipt_json) as ModelChangeReceipt;
    assert.equal(useModelChangeReceipts.getState().status.items[receipt.id], 'saved');
    assert.equal(storedReceipt(receipt.id)?.status, 'applied');
  });

  it('#20: a receipt write that throws after the library kept its draft is retried, not put again', async () => {
    const token = await prepareRename();
    const put = modelChangeLibrary.put, refused = refuseContentWrites();
    let receipt: ModelChangeReceipt | undefined;
    modelChangeLibrary.put = (id, value, ...rest) => {
      receipt = value as ModelChangeReceipt;
      return put(id, value, ...rest).then(() => { throw new Error('Acknowledgement lost'); });
    };
    try {
      assert.equal((await invoke('authoring.apply', { token }, true)).isError, true);
      modelChangeLibrary.put = put;
      // The Changes panel marks the kept draft undone; a second put of the original receipt would overwrite that.
      assert.equal(await modelChangeLibrary.put(receipt!.id, { ...receipt!, status: 'undone', undoneAt: new Date(0).toISOString() }), false);
    } finally { modelChangeLibrary.put = put; refused.mock.restore(); }
    assert.equal(answer<{ persisted: boolean }>(await invoke('authoring.apply', { token }, true)).persisted, true);
    assert.equal(storedReceipt(receipt!.id)?.status, 'undone', 'the replay saved the library\'s draft');
  });

  it('#20: a receipt saved while the Changes panel writes it again still reports persisted', async () => {
    const token = await prepareRename();
    const put = modelChangeLibrary.put;
    let undo: Promise<boolean> | undefined;
    modelChangeLibrary.put = (id, value, ...rest) => {
      modelChangeLibrary.put = put;
      const first = put(id, value, ...rest);
      // The panel marks it undone before our write lands; the library's status now follows the newer write.
      undo = put(id, { ...(value as ModelChangeReceipt), status: 'undone', undoneAt: new Date(0).toISOString() });
      return first;
    };
    try { assert.equal(answer<{ persisted: boolean }>(await invoke('authoring.apply', { token }, true)).persisted, true); }
    finally { modelChangeLibrary.put = put; await undo?.catch(() => false); }
    assert.equal(await undo, true);
  });

  it('#20: a replay never puts back a receipt draft that a library restore dropped', async () => {
    const token = await prepareRename();
    let receipt: ModelChangeReceipt;
    const refused = refuseContentWrites();
    try {
      const applied = answer<{ receipt_json: string; persisted: boolean }>(await invoke('authoring.apply', { token }, true));
      assert.equal(applied.persisted, false);
      receipt = JSON.parse(applied.receipt_json) as ModelChangeReceipt;
    } finally { refused.mock.restore(); }
    assert.equal(await modelChangeLibrary.restore(), true); // the user restores what storage holds, without this draft
    assert.equal(storedReceipt(receipt!.id), undefined);
    const retry = mock.method(modelChangeLibrary, 'retry');
    try {
      for (let i = 0; i < 2; i++) assert.equal(answer<{ persisted: boolean }>(await invoke('authoring.apply', { token }, true)).persisted, false);
      assert.equal(retry.mock.callCount(), 0, 'a replay does not flush the library\'s other drafts for a receipt it no longer has');
    } finally { retry.mock.restore(); }
    assert.equal(storedReceipt(receipt!.id), undefined, 'the dropped receipt stays dropped');
  });

  it('#20: a replay after a library restore reports a receipt storage holds as saved', async () => {
    const token = await prepareRename();
    let receipt: ModelChangeReceipt;
    const refused = refuseContentWrites();
    try {
      const applied = answer<{ receipt_json: string; persisted: boolean }>(await invoke('authoring.apply', { token }, true));
      assert.equal(applied.persisted, false);
      receipt = JSON.parse(applied.receipt_json) as ModelChangeReceipt;
    } finally { refused.mock.restore(); }
    assert.equal(await modelChangeLibrary.retry(), true); // the panel's Retry saves it
    assert.equal(await modelChangeLibrary.restore(), true); // a restore rereads storage and resets item statuses
    assert.ok(storedReceipt(receipt!.id));
    assert.equal(answer<{ persisted: boolean }>(await invoke('authoring.apply', { token }, true)).persisted, true);
  });

  it('#20: a replay of an unsaved receipt saves the library\'s latest draft, an undone mark included', async () => {
    const token = await prepareRename();
    let receipt: ModelChangeReceipt;
    const refused = refuseContentWrites(); // storage refuses: put resolves false and keeps the receipt as a draft
    try {
      const applied = answer<{ receipt_json: string; persisted: boolean }>(await invoke('authoring.apply', { token }, true));
      assert.equal(applied.persisted, false);
      receipt = JSON.parse(applied.receipt_json) as ModelChangeReceipt;
      assert.equal(answer<{ persisted: boolean }>(await invoke('authoring.apply', { token }, true)).persisted, false, 'still unsaved');
      // The Changes panel marks it undone while storage is still refusing.
      assert.equal(await modelChangeLibrary.put(receipt.id, { ...receipt, status: 'undone', undoneAt: new Date(0).toISOString() }), false);
    } finally { refused.mock.restore(); }
    assert.equal(answer<{ persisted: boolean }>(await invoke('authoring.apply', { token }, true)).persisted, true);
    assert.equal(useModelChangeReceipts.getState().status.items[receipt!.id], 'saved');
    assert.equal(storedReceipt(receipt!.id)?.status, 'undone', 'the replay saved the undone draft, not the original receipt');
  });

  it('#20: unsaved receipts do not lock the host out; the library keeps them for its own retry', async () => {
    const refused = refuseContentWrites();
    try {
      const token = await prepareRename();
      const applied = answer<{ receipt_json: string; persisted: boolean }>(await invoke('authoring.apply', { token }, true));
      assert.equal(applied.persisted, false);
      const receipt = JSON.parse(applied.receipt_json) as ModelChangeReceipt;
      for (let i = 0; i < 64; i++) await prepareRename(`Name ${i}`); // the 64th evicts the applied candidate
      assert.match((await invoke('authoring.apply', { token }, true)).text, /Unknown reviewed candidate/, 'the applied one was the one evicted');
      assert.ok(storedReceipt(receipt.id), 'the receipt survives as the library\'s draft');
      assert.notEqual(useModelChangeReceipts.getState().status.items[receipt.id], 'saved');
    } finally { refused.mock.restore(); }
  });

  it('#20: replaying an applied graph token keeps its undone receipt too', async () => {
    const { token } = answer<{ token: string }>(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
    const { receipt } = answer<{ receipt: ModelChangeReceipt }>(await invoke('authoring.graph.apply', { token }, true));
    await markUndone(receipt);
    answer(await invoke('authoring.graph.apply', { token }, true));
    assert.equal(storedReceipt(receipt.id)?.status, 'undone');
  });

  it('#10918: a refused properties prepare keeps no candidate', async () => {
    const token = await refusedAfterToken('authoring-native', 'properties.prepare', { proposal_json: rename('Refused') });
    assert.match((await invoke('authoring.discard', { token })).text, /Unknown reviewed candidate/);
  });

  it('#10918: a result refused by the schema keeps no candidate', async () => {
    let token: string | undefined;
    const entry = viewerOperation('properties.prepare');
    const validate = entry.validateResult.bind(entry);
    const validator = mock.method(entry, 'validateResult', (result: unknown) => {
      const { token: stored, ...withoutToken } = result as { token: string };
      token = stored;
      validate(withoutToken);
    });
    try {
      const failed = await invoke('properties.prepare', { proposal_json: rename('Invalid result') });
      assert.equal(failed.isError, true);
      assert.match(failed.text, /properties\.prepare output.*token/);
    } finally {
      validator.mock.restore();
    }
    assert.ok(token, 'the candidate was stored before result validation');
    assert.match((await invoke('authoring.discard', { token })).text, /Unknown reviewed candidate/);
  });

  it('#10918: a prepare whose handler throws after storing its candidate keeps none', async () => {
    const uuid = crypto.randomUUID.bind(crypto), stringify = JSON.stringify;
    let token: string | undefined, thrown = false;
    mock.method(crypto, 'randomUUID', () => { const value = uuid(); if (token === undefined && new Error().stack?.includes('authoring-native')) token = value; return value; });
    // The preview serializes after the candidate is stored; make that one serialization fail.
    mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
      if (token !== undefined && !thrown && new Error().stack?.includes('authoring-native')) { thrown = true; throw new Error('Preview could not be serialized'); }
      return stringify(...args);
    });
    let failed: AgentToolResult;
    try { failed = await invoke('properties.prepare', { proposal_json: rename('Throws after storing') }); } finally { mock.restoreAll(); }
    assert.equal(thrown, true, 'the handler threw after storing');
    assert.match(failed.text, /Preview could not be serialized/);
    assert.match((await invoke('authoring.discard', { token })).text, /Unknown reviewed candidate/);
  });

  it('#10918: a refused revert prepare keeps no candidate', async () => {
    answer(await invoke('authoring.apply', { token: await prepareRename() }, true));
    const [change] = answer<Array<{ id: string }>>(await invoke('changes.read'));
    const token = await refusedAfterToken('changes-native', 'changes.revert.prepare', { id: change.id });
    assert.match((await invoke('changes.revert.apply', { token }, true)).text, /Unknown revert candidate/);
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

  it('#19: a malformed prepare evicts no applied review before the new one is ready', async () => {
    const { token: applied } = answer<{ token: string }>(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
    answer(await invoke('authoring.graph.apply', { token: applied }, true));
    const proposal_json = await groupProposal();
    for (let i = 0; i < 31; i++) answer(await invoke('authoring.group.prepare', { proposal_json }));
    // 31 pending plus the applied one fill the cap; a prepare that fails to parse must not take the applied one's place.
    const malformed = await invoke('authoring.group.prepare', { proposal_json: '{"not":"a proposal"}' });
    assert.equal(malformed.isError, true); assert.doesNotMatch(malformed.text, /At most 32/, 'admitted, then refused by parsing');
    answer(await invoke('authoring.graph.apply', { token: applied }, true)); // still held: its replay answers
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

  const renameWall = (value: string, current = 'Wall 1') => JSON.stringify({ version: 1, kind: 'model.changes', title: 'Name', changes: [
    { op: 'attribute.set', target: { globalId: guid(1), modelId: 'walls', ifcClass: 'IfcWall', name: current }, name: 'Name', expected: current, value }] });

  it('#68: a refused correction evicts no applied candidate', async () => {
    const applied = answer<{ token: string }>(await invoke('properties.prepare', { proposal_json: renameWall('Applied') })).token;
    answer(await invoke('authoring.apply', { token: applied }, true));
    for (let i = 0; i < 63; i++) answer(await invoke('properties.prepare', { proposal_json: renameWall(`Name ${i}`, 'Applied') }));
    // 63 pending plus two batches cannot fit; the refusal comes before batch one could evict the applied candidate.
    const express_ids = Array.from({ length: WALLS }, (_, i) => i + 1);
    const fix = await invoke('validation.fix.prepare', { express_ids, pset: 'Pset_Review', name: 'Checked', facet_data_type: '', raw_value: 'yes', title: 'Mark reviewed' });
    assert.match(fix.text, /At most 64/);
    answer(await invoke('authoring.apply', { token: applied }, true)); // still held: its replay answers
  });

  const prepareCorrection = async (raw_value = 'yes') => {
    const express_ids = Array.from({ length: WALLS }, (_, i) => i + 1);
    const { candidates } = answer<{ candidates: Array<{ token: string }> }>(await invoke('validation.fix.prepare',
      { express_ids, pset: 'Pset_Review', name: 'Checked', facet_data_type: '', raw_value, title: 'Mark reviewed' }));
    assert.equal(candidates.length, 2);
    return candidates.map(row => row.token);
  };
  const applyBatch = async (token: string) => JSON.parse(answer<{ receipt_json: string }>(await invoke('authoring.apply', { token }, true)).receipt_json) as ModelChangeReceipt;

  it('#10894: a correction over 500 changes applies batch by batch without re-preparing, in either order', async () => {
    for (const [order, value] of [[[0, 1], 'yes'], [[1, 0], 'no']] as const) {
      const tokens = await prepareCorrection(value);
      let applied = 0;
      for (const index of order) applied += (await applyBatch(tokens[index])).applied.length;
      assert.equal(applied, WALLS, `every change applied, order ${order.join(',')}`);
    }
  });

  it('#10894: undoing an applied batch refuses the rest of its correction', async () => {
    const [first, second] = await prepareCorrection();
    const receipt = await applyBatch(first);
    const { undoModelChanges } = await import('@/lib/actions/model-change-commit');
    assert.deepEqual(undoModelChanges(useViewerStore, receipt), { ok: true });
    assert.match((await invoke('authoring.apply', { token: second }, true)).text, /Model changed since preview/);
  });

  it('#10894: an element listed twice is withheld, never split across batches', async () => {
    const express_ids = [...Array.from({ length: WALLS }, (_, i) => i + 1), 1];
    const { converted, candidates } = answer<{ converted: { issues: Array<{ kind: string; element?: string }> }; candidates: Array<{ token: string }> }>(await invoke('validation.fix.prepare',
      { express_ids, pset: 'Pset_Review', name: 'Checked', facet_data_type: '', raw_value: 'yes', title: 'Mark reviewed' }));
    assert.deepEqual(converted.issues.filter(issue => issue.kind === 'ambiguous-key').map(issue => issue.element), [guid(1)], 'wall 1 is withheld, not split');
    assert.equal(candidates.length, 1, 'the other 500 fit one batch');
    const receipt = await applyBatch(candidates[0].token);
    assert.equal(receipt.applied.length, WALLS - 1);
    assert.equal(receipt.applied.some(row => row.globalId === guid(1)), false);
  });

  it('#10894: two sibling batches applied at once: one applies, the other is refused, then applies on retry', async () => {
    const [first, second] = await prepareCorrection();
    // Both calls bind the revision when they start, and apply awaits its imports before committing, so the second to
    // commit meets a revision the first moved.
    const results = await Promise.all([invoke('authoring.apply', { token: first }, true), invoke('authoring.apply', { token: second }, true)]);
    assert.equal(results.filter(result => result.isError).length, 1);
    const winner = results.find(result => !result.isError)!, loser = results.find(result => result.isError)!;
    assert.match(loser.text, /Model replaced, closed, or edited during the operation/);
    const applied = (JSON.parse(answer<{ receipt_json: string }>(winner).receipt_json) as ModelChangeReceipt).applied.length;
    const retried = (await applyBatch(results[0].isError ? first : second)).applied.length;
    assert.equal(applied + retried, WALLS, 'the refused apply wrote nothing; its retry applied its whole batch');
  });

  it('#10894: an edit outside the correction between its batches still refuses the rest', async () => {
    const [first, second] = await prepareCorrection();
    await applyBatch(first);
    useViewerStore.getState().setAttribute(modelId, 1, 'Description', 'Unrelated edit');
    assert.match((await invoke('authoring.apply', { token: second }, true)).text, /Model changed since preview/);
  });

  it('#68: a correction that cannot fit is refused whole and stages none of its batches', async () => {
    for (let i = 0; i < 63; i++) answer(await invoke('properties.prepare', { proposal_json: renameWall(`Name ${i}`) }));
    // Two batches cannot fit beside 63: every batch is previewed first, then none is admitted.
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

  it('#10918: a refused IDS Studio prepare keeps no candidate', async () => {
    const token = await refusedAfterToken('ids-studio', 'ids.operations.prepare', { document_revision: useViewerStore.getState().idsStudioRevision,
      ops_json: JSON.stringify([setSpecTextOp(specId(), 'name', 'Refused')]) });
    assert.match((await invoke('ids.candidate.apply', { token }, true)).text, /Unknown IDS candidate/);
  });

  it('#10918: a refused IDS validation run keeps no run handle', async () => {
    const { content } = answer<{ content: string }>(await invoke('ids.document.xml'));
    const run_id = await refusedAfterToken('ids-validation', 'validation.ids.run', { xml: content, scope: 'whole', entity_ids: [] });
    assert.match((await invoke('validation.results', { run_id, offset: 0, limit: 1 })).text, /Unknown validation run/);
  });

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

  it('#63: a prepare cancelled during its imports evicts no other candidate', async () => {
    const applied = await prepareOps('Applied');
    answer(await invoke('ids.candidate.apply', { token: applied }, true));
    for (let i = 0; i < 63; i++) await prepareOps(`Pending ${i}`); // 64 held: admission would evict the applied one
    const prepareOperation = idsOperations.find(row => row.id === 'ids.operations.prepare')!;
    const controller = new AbortController();
    // Cancel from the call's own checkpoint right after its contexts load, so it lands before the later imports.
    const context = { host, canEdit: () => true, signal: controller.signal, checkpoint: () => controller.abort() } as Parameters<typeof prepareOperation.execute>[1];
    await assert.rejects(prepareOperation.execute({ document_revision: useViewerStore.getState().idsStudioRevision,
      ops_json: JSON.stringify([setSpecTextOp(specId(), 'name', 'Cancelled')]) }, context), { message: 'Tool cancelled.' });
    assert.equal(controller.signal.aborted, true, 'the call was cancelled from its own checkpoint');
    answer(await invoke('ids.candidate.apply', { token: applied }, true)); // still held: its replay answers
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

  it('#36: an IDS run in a single-model session refuses once that session replaced its store', async () => {
    const sample = useViewerStore.getState().models.get(modelId)!;
    useViewerStore.setState({ models: new Map(), ifcDataStore: sample.ifcDataStore, activeModelId: null,
      mutationViews: new Map([['default', useViewerStore.getState().mutationViews.get(modelId)!]]) });
    modelId = 'default';
    const { content } = answer<{ content: string }>(await invoke('ids.document.xml'));
    const { run_id } = answer<{ run_id: string }>(await invoke('validation.ids.run', { xml: content, scope: 'whole', entity_ids: [] }));
    // setIfcDataStore without an active model: `models` and the revision stay as they were.
    useViewerStore.setState({ ifcDataStore: { ...sample.ifcDataStore! } });
    assert.match((await invoke('validation.publish', { run_id }, true)).text, /Validation inputs changed/);
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

  it('#10918: a refused clash report deletion prepare keeps no candidate', async () => {
    const id = await savedReport();
    const token = await refusedAfterToken('clash-native-reports', 'clash.reports.delete.prepare', { id });
    assert.match((await invoke('clash.reports.delete.apply', { token }, true)).text, /Unknown deletion candidate/);
  });

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

  for (const failure of ['unreadable-dashboards', 'document-read-error'] as const) {
    it(`preserves a ${failure} refusal inside the report deletion guard (#10871)`, async (t) => {
      const id = await savedReport();
      const { token } = answer<{ token: string }>(await invoke('clash.reports.delete.prepare', { id }));
      let reads = 0;
      const getAll = IDBIndex.prototype.getAll;
      t.mock.method(IDBIndex.prototype, 'getAll', function (this: IDBIndex, query?: IDBValidKey | IDBKeyRange | null, count?: number) {
        if (query === 'document' && ++reads === 2) {
          if (failure === 'document-read-error') throw new Error('Document index read failed');
          localStorage.setItem('ifc-lite-dashboards', '{}');
        }
        return getAll.call(this, query, count);
      });
      const result = await invoke('clash.reports.delete.apply', { token }, true);
      assert.equal(reads, 2, 'the failure occurs on the guard read');
      assert.equal(result.errorCode, 'INTERNAL_ERROR', result.text);
      const details = result.structured as { reason: string; dependency?: string };
      assert.equal(details.reason, 'internal');
      assert.ok(details.dependency);
      assert.ok(useViewerStore.getState().savedClashReports.some(report => report.id === id));
    });
  }

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

  it('#10918: a refused zone writeback prepare keeps no candidate', async () => {
    const token = await refusedAfterToken('authoring-zone-writes', 'zones.writeback.prepare', { set_id: 'set-1', model_ids: ['m1'], basis: 'mesh', action: 'write' });
    assert.match((await invoke('zones.writeback.apply', { token }, true)).text, /Unknown zone candidate/);
  });

  it('#23: writeback refuses changed assignments, not an identical rebuild', async () => {
    const prepare = async () => answer<{ token: string }>(await invoke('zones.writeback.prepare', { set_id: 'set-1', model_ids: ['m1'], basis: 'mesh', action: 'write' })).token;
    const rebuilt = await prepare();
    useViewerStore.setState({ zoneAssignments: assignments() }); // what the sync does after any geometry tick, a recolour included
    answer(await invoke('zones.writeback.apply', { token: rebuilt }, true));
    const changed = await prepare();
    useViewerStore.setState({ zoneAssignments: new Map([[WALL_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a'] } }]]) as never });
    const applied = await invoke('zones.writeback.apply', { token: changed }, true);
    assert.equal(applied.isError, true);
    assert.match(applied.text, /changed after review/); // main's writeback digest covers the rows the assignments produce
  });

  const tableExport = { set_id: 'set-1', basis: 'mesh', format: 'parquet' } as const;
  for (const change of [
    { name: 'an edit', apply: () => useViewerStore.setState(s => ({ mutationVersion: s.mutationVersion + 1 })) },
    { name: 'an unloaded model', apply: () => useViewerStore.setState({ models: new Map() }) },
    { name: 'new assignments', apply: () => useViewerStore.setState({ zoneAssignments: new Map() }) },
    { name: 'a geometry update alone', apply: () => useViewerStore.setState(s => ({ geometryUpdateTick: s.geometryUpdateTick + 1 })) },
    // realignFederation moves vertices in place and bumps only the content version.
    { name: 'an in-place realignment', apply: () => useViewerStore.setState(s => ({ geometryContentVersion: s.geometryContentVersion + 1 })) },
  ])
    it(`#28: the zone table export discards an artifact after ${change.name} while it encoded`, async () => {
      let changed = false;
      const before = listArtifacts(host).length;
      const stop = useActivityJournal.subscribe(() => { if (!changed) { changed = true; change.apply(); } });
      try {
        const exported = await invoke('zones.table.export', tableExport, true);
        assert.equal(changed, true);
        assert.equal(exported.isError, true, exported.text);
        assert.match(exported.text, /changed during export/);
        assert.equal(listArtifacts(host).length, before, 'the refused export registered no artifact');
      } finally { stop(); }
    });
  it('#28 control: an export with nothing changed registers its artifact', async () => {
    const before = listArtifacts(host).length;
    const { artifact } = answer<{ artifact: { artifact_id: string } | null }>(await invoke('zones.table.export', tableExport, true));
    assert.equal(listArtifacts(host).length, before + 1);
    assert.ok(artifact && listArtifacts(host).some(row => row.artifact_id === artifact.artifact_id), 'the registered artifact is the zone table');
  });
});

describe('zone emission reviews (#10792)', () => {
  const initial = useViewerStore.getState();
  afterEach(() => { setGlobalRendererRef({ current: null }); useViewerStore.setState(initial, true); });
  async function seedZones(t: TestContext) {
    if (!ensureWasm(t)) return null;
    const f = await seedZoneExport();
    useViewerStore.setState({ editEnabled: true, collabRole: null, collabRoomId: null, storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), removedNewEntities: new Map(), removedMeshes: new Map(), dirtyModels: new Set(), mutationVersion: 0 });
    const model = useViewerStore.getState().models.get('bonsai')!;
    useViewerStore.setState({ models: new Map([['bonsai', { ...model, idOffset: 0, maxExpressId: Math.max(...f.store.entityIndex.byId.keys()) }]]) });
    const scene = new Scene(); f.meshes.forEach(mesh => scene.addMeshData(mesh)); setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
    recomputeZoneAssignmentsNow(); modelId = 'bonsai'; newHost(); return f;
  }
  const zoneProposal = () => {
    const choice = nativeZoneEmissionEvidence(useViewerStore.getState(), 'bonsai').choices.find(row => row.status === 'available');
    assert.ok(choice?.expected, 'an evaluated native zone snapshot');
    return JSON.stringify({ version: 1, kind: 'zones.emit', title: 'Review native zones', modelId: 'bonsai', zoneSetId: choice.zoneSetId,
      storey: { GlobalId: choice.expected.storey.GlobalId, Name: choice.expected.storey.Name }, expected: choice.expected });
  };

  it('#19: 32 zone reviews of a zone set that then changed free the cap for a fresh prepare', async (t) => {
    const f = await seedZones(t); if (!f) return;
    const proposal_json = zoneProposal();
    for (let i = 0; i < 32; i++) answer(await invoke('authoring.zone.prepare', { proposal_json }));
    // The models are unchanged; only the zone set is edited. None of the 32 can apply now.
    useViewerStore.setState(s => ({ zoneSets: s.zoneSets.map(set => set.id === f.zoneSet.id ? { ...set, name: `${set.name} (edited)` } : set) }));
    recomputeZoneAssignmentsNow();
    answer(await invoke('authoring.zone.prepare', { proposal_json: zoneProposal() }));
  });

  it('#19: 32 zone reviews of an evaluation that was then rebuilt free the cap, since none can apply', async (t) => {
    if (!await seedZones(t)) return;
    const proposal_json = zoneProposal();
    const tokens: string[] = [];
    for (let i = 0; i < 32; i++) tokens.push(answer<{ token: string }>(await invoke('authoring.zone.prepare', { proposal_json })).token);
    // An identical assignment rebuild (the sync's after any geometry tick) is a new evaluation, which validate() binds.
    recomputeZoneAssignmentsNow();
    assert.match((await invoke('authoring.graph.apply', { token: tokens[0] }, true)).text, /Native evaluation, zone set, members, frame or prior output changed/);
    answer(await invoke('authoring.zone.prepare', { proposal_json: zoneProposal() }));
  });

  it('#19: 32 zone reviews whose native lease moved (an edit to the target model) free the cap', async (t) => {
    const f = await seedZones(t); if (!f) return;
    // The view exists before the reviews, so the edit below moves only its revision.
    useViewerStore.setState(s => ({ mutationViews: new Map(s.mutationViews).set('bonsai', configuredView(f.store, 'bonsai')) }));
    recomputeZoneAssignmentsNow();
    const proposal_json = zoneProposal();
    const tokens: string[] = [];
    for (let i = 0; i < 32; i++) tokens.push(answer<{ token: string }>(await invoke('authoring.zone.prepare', { proposal_json })).token);
    // Zone set, assignments and evaluation owner unchanged; only the model the reviews' lease bound is edited.
    const view = useViewerStore.getState().mutationViews.get('bonsai');
    useViewerStore.getState().setAttribute('bonsai', f.wall.expressId, 'Description', 'Edited after review');
    assert.equal(useViewerStore.getState().mutationViews.get('bonsai'), view, 'same view, new revision');
    assert.ok((useViewerStore.getState().mutationViews.get('bonsai')?.getMutationRevision() ?? 0) > 0, 'the edit reached the model');
    // Admission without a recompute (which would record a new owner and drop them on its own): any prepare checks the
    // cap first, here one that then fails to parse.
    const malformed = await invoke('authoring.zone.prepare', { proposal_json: '{"not":"a proposal"}' });
    assert.equal(malformed.isError, true); assert.doesNotMatch(malformed.text, /At most 32/, 'admitted, then refused by parsing');
    assert.match((await invoke('authoring.graph.discard', { token: tokens[0] })).text, /Unknown graph review/, 'the edit dropped them');
  });
});

describe('Room review admission probe (#10792)', () => {
  const initial = useViewerStore.getState();
  afterEach(() => { clearModelLayouts(ROOM_MODEL); setRemeshClientFactory(null); useViewerStore.setState(initial, true); });
  const withGeometry = (meshes: (mesh: MeshData) => MeshData) => useViewerStore.setState(s => {
    const model = s.models.get(ROOM_MODEL)!, geometry = model.geometryResult!;
    return { models: new Map(s.models).set(ROOM_MODEL, { ...model, geometryResult: { ...geometry, meshes: geometry.meshes.map(meshes) } }) };
  });

  const reorderMeshes = () => useViewerStore.setState(s => {
    const model = s.models.get(ROOM_MODEL)!, geometry = model.geometryResult!;
    return { models: new Map(s.models).set(ROOM_MODEL, { ...model, geometryResult: { ...geometry, meshes: [...geometry.meshes].reverse() } }) };
  });
  it('#19: a Room review whose meshes were reordered reads as changed, as its lease does', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await seedReviewedRoom();
    const review = await prepareRoomReview(roomProposal(), new AbortController().signal);
    try {
      assert.equal(review.sourcesCurrent(), true);
      reorderMeshes(); // the same mesh objects and buffers in another order
      assert.throws(() => review.validate(), /geometry or model\/storey frame changed/);
      assert.equal(review.sourcesCurrent(), false);
    } finally { review.dispose(); }
  });

  it('#19: a Room review of a model rotated since reads as changed, as its lease does', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await seedReviewedRoom();
    const review = await prepareRoomReview(roomProposal(), new AbortController().signal);
    try {
      assert.equal(review.sourcesCurrent(), true);
      const models = useViewerStore.getState().models;
      useViewerStore.getState().setModelRotation([ROOM_MODEL], { angle: Math.PI / 2, pivot: [0, 0, 0] }); // placement only
      assert.equal(useViewerStore.getState().models, models, 'the rotation left the model entries alone');
      assert.throws(() => review.validate(), /geometry or model\/storey frame changed/);
      assert.equal(review.sourcesCurrent(), false);
    } finally { review.dispose(); }
  });

  it('#19: a Room review a newer preparation superseded reads as changed, as its validate() does', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await seedReviewedRoom();
    const earlier = await prepareRoomReview(roomProposal(), new AbortController().signal);
    const later = await prepareRoomReview(roomProposal(), new AbortController().signal);
    try {
      assert.equal(later.sourcesCurrent(), true, 'the later prepare remeshed to identical bytes: not a change');
      assert.throws(() => earlier.validate(), /model changed while native Room geometry was preparing/);
      assert.equal(earlier.sourcesCurrent(), false);
    } finally { earlier.dispose(); later.dispose(); }
  });

  it('#19: a Room review whose meshes were reordered frees its place under the cap, through the graph operations', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await seedReviewedRoom(); modelId = ROOM_MODEL; newHost();
    // Only one Room review per model is ever current (a newer preparation supersedes the rest), so 31 Group reviews of
    // the same model fill the cap beside it.
    const wall = 1222;
    const evidence = answer<{ elements: Array<{ globalId: string; nativeGroup: { snapshot: unknown } }> }>(await invoke('authoring.nativeEvidence', { express_ids: [wall] }));
    const group = JSON.stringify({ version: 1, kind: 'group.lifecycle', title: 'Exact group', modelId: ROOM_MODEL, expected: evidence.elements[0].nativeGroup.snapshot,
      operations: [{ op: 'group.create', params: { Name: 'Operation group', RelatedObjects: [{ expressId: wall, GlobalId: evidence.elements[0].globalId }] } }] });
    // The Room prepare first: its own wall remesh replaces the model entry, which would make earlier Group reviews stale.
    const { token: room } = answer<{ token: string }>(await invoke('authoring.room.prepare', { proposal_json: JSON.stringify(roomEnvelope()) }, true));
    const groups: string[] = [];
    for (let i = 0; i < 31; i++) groups.push(answer<{ token: string }>(await invoke('authoring.group.prepare', { proposal_json: group })).token);
    assert.match((await invoke('authoring.group.prepare', { proposal_json: group })).text, /At most 32 graph review candidates/, 'the Room review keeps its place');
    reorderMeshes();
    const malformed = await invoke('authoring.group.prepare', { proposal_json: '{"not":"a proposal"}' }); // any prepare checks the cap
    assert.equal(malformed.isError, true); assert.doesNotMatch(malformed.text, /At most 32/, 'admitted, then refused by parsing');
    // Kept above (its forwarded probe was true), dropped now. (The reorder replaced the model entry, so the Group
    // reviews, which bind it by identity, went too.)
    assert.match((await invoke('authoring.graph.discard', { token: room })).text, /Unknown graph review/, 'the reordered Room review was dropped');
    assert.equal(groups.length, 31);
  });

  it('#19: a Room review stays admitted through a recolour and a same-bytes remesh, and is dropped after a byte change', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await seedReviewedRoom();
    const review = await prepareRoomReview(roomProposal(), new AbortController().signal);
    try {
      assert.equal(review.sourcesCurrent(), true);
      withGeometry(mesh => ({ ...mesh, color: [1, 0, 0, 1] })); // a recolour copies meshes with the same buffers
      assert.equal(review.sourcesCurrent(), true);
      withGeometry(mesh => ({ ...mesh, positions: mesh.positions.slice() })); // a remesh replaces the buffers, same bytes
      assert.equal(review.sourcesCurrent(), true);
      review.validate();
      withGeometry(mesh => { const positions = mesh.positions.slice(); if (positions.length) positions[0] += 1; return { ...mesh, positions }; });
      assert.equal(review.sourcesCurrent(), false);
      assert.throws(() => review.validate(), /geometry or model\/storey frame changed/);
    } finally { review.dispose(); }
    // Released meshes share one empty positions array but keep distinct indices; that alone must not read as a change.
    const empty = new Float32Array(0);
    withGeometry(mesh => ({ ...mesh, positions: empty }));
    const released = await prepareRoomReview(roomProposal(), new AbortController().signal);
    try {
      assert.equal(released.sourcesCurrent(), true);
      // A mesh left without a positions buffer cannot be read: it reads as changed, and does not throw.
      withGeometry(mesh => ({ ...mesh, positions: undefined as unknown as Float32Array }));
      assert.equal(released.sourcesCurrent(), false);
    } finally { released.dispose(); }
  });
});
