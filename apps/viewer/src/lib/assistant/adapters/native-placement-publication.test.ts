/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { IfcCreator, readWallJoinTarget } from '@ifc-lite/create';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import type { NativePlacement } from '@/lib/actions/model-authoring-placement';
import { readOnlyModelEditLease } from '@/lib/actions/model-authoring-read-target';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { previewModelAuthoring } from '@/lib/actions/model-authoring-preview';
import { commitModelAuthoring } from '@/lib/actions/model-authoring-commit';
import { undoModelChanges } from '@/lib/actions/model-change-commit';
import { captureEvidence } from '../evidence';
import { replaceEvidence, cancelAssistant, useAssistant } from '../conversation';
import { sendAssistant } from '../request';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
const initial = useViewerStore.getState(), assistant = useAssistant.getState(), fetchBefore = globalThis.fetch;
afterEach(() => { cancelAssistant(); globalThis.fetch = fetchBefore; useAssistant.setState(assistant, true); useViewerStore.setState(initial, true); federationRegistry.clear(); });
const state = useViewerStore.getState;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
async function fixture(metres: boolean, federated: boolean) {
  federationRegistry.clear();
  let { dataStore, view } = await seedAuthoringSample();
  let storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  if (metres) {
    const creator = new IfcCreator({ Schema: 'IFC4', LengthUnit: 'METRE', Name: 'Native metre placement' });
    storey = creator.addIfcBuildingStorey({ Name: 'Level', Elevation: 0 });
    dataStore = await parseIfc(new TextEncoder().encode(creator.toIfc().content));
    view = new MutablePropertyView(dataStore.properties, SAMPLE_MODEL);
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...state().models.get(SAMPLE_MODEL)!, ifcDataStore: dataStore,
      maxExpressId: getMaxExpressId(dataStore, []) }]]), ifcDataStore: dataStore, mutationViews: new Map([[SAMPLE_MODEL, view]]), storeEditors: new Map() });
  }
  const wall = state().addWall(SAMPLE_MODEL, storey, { Start: [10,10,0], End: [15,10,0], Thickness: .2, Height: 3, Name: 'Native wire wall' });
  assert.ok('expressId' in wall, 'error' in wall ? wall.error : '');
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  let owner = SAMPLE_MODEL, selected = saved;
  const base = state().models.get(SAMPLE_MODEL)!;
  const savedView = new MutablePropertyView(saved.properties, SAMPLE_MODEL);
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...base, ifcDataStore: saved, maxExpressId: getMaxExpressId(saved, []) }]]),
    ifcDataStore: saved, mutationViews: new Map([[SAMPLE_MODEL, savedView]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map() });
  if (federated) {
    owner = 'peer'; selected = await parseIfc(saved.source.materialize());
    const first = state().registerModelOffset(SAMPLE_MODEL, getMaxExpressId(saved, []));
    const second = state().registerModelOffset(owner, getMaxExpressId(selected, []));
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...state().models.get(SAMPLE_MODEL)!, idOffset: first }],
      [owner, { ...base, id: owner, idOffset: second, ifcDataStore: selected, maxExpressId: getMaxExpressId(selected, []) }]]),
      mutationViews: new Map([[SAMPLE_MODEL, savedView], [owner, new MutablePropertyView(selected.properties, owner)]]) });
  }
  const rendererId = state().toGlobalId(owner, wall.expressId);
  useViewerStore.setState({ selectedEntity: { modelId: owner, expressId: wall.expressId }, selectedEntityId: rendererId, selectedEntityIds: new Set([rendererId]) });
  return { owner, selected, saved, id: wall.expressId, view: state().mutationViews.get(owner)!, unrelated: savedView };
}
for (const metres of [true, false]) for (const federation of [false, true]) for (const route of ['rich', 'attachment'] as const) {
  test(`#7313 actual ${metres ? 'm' : 'mm'} ${federation ? 'N' : '1'} ${route} wire placement constructs explicit-pivot native Apply/export/Undo`, async () => {
    const f = await fixture(metres, federation), snapshot = captureEvidence(route === 'rich' ? 'selection' : 'loadReport');
    replaceEvidence(snapshot);
    const grounding = route === 'attachment' ? captureSelectionGrounding(state()) : null;
    const held = state(), lease = readOnlyModelEditLease(held, f.owner); assert.ok(lease);
    const history = f.view.getMutations();
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const wire = JSON.parse(String(init?.body));
      let data: unknown;
      if (route === 'rich') {
        const system = typeof wire.system === 'string' ? wire.system : wire.system.map((b: { text: string }) => b.text).join('\n');
        const at = system.indexOf(snapshot.payload); assert.ok(at >= 0);
        data = JSON.parse(system.slice(at, at + snapshot.payload.length)).evidence.rows[0].data;
        assert.ok(record(data));
      } else {
        const user = wire.messages.filter((m: { role: string }) => m.role === 'user').at(-1);
        data = JSON.parse(user.content.split('\n').at(-1))[0];
      }
      assert.ok(record(data) && record(data.nativePlacement));
      assert.equal(data.modelId, f.owner);
      const answer = JSON.stringify({ kind: 'model.authoring', version: 1, title: 'Wire native pivot', units: metres ? 'm' : 'mm', frame: 'storey-local',
        operations: [{ op: 'element.rotate', target: { modelId: data.modelId, globalId: data.globalId, ifcClass: data.type, name: data.name },
          angleDeg: 90, pivot: [0,0], expected: data.nativePlacement }] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\n`);
    };
    assert.equal(await sendAssistant('Draft the explicit native pivot rotation', 'openai/gpt-free', '/api/chat',
      grounding ? attachmentsForSend({ selection: grounding, screenshot: null }) : {}), true, useAssistant.getState().error ?? '');
    assert.equal(calls, 1); assert.equal(state(), held); assert.deepEqual(f.view.getMutations(), history); assert.doesNotThrow(lease.validate);
    const answer = useAssistant.getState().messages.at(-1)?.content; assert.ok(answer);
    const preview = previewModelAuthoring(state(), parseModelAuthoringBatch(answer));
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
    const applied = commitModelAuthoring(useViewerStore, preview, new Set([0]), '#7313 real wire'); assert.ok(applied.ok, applied.ok ? '' : applied.detail ?? applied.reason);
    const start = async (store = f.selected, view = f.view) => {
      const parsed = await parseIfc(editedModelBytes(store, view));
      const read = readWallJoinTarget(parsed, new MutablePropertyView(parsed.properties, f.owner), f.id, metres ? 1 : .001); assert.ok(read);
      return read.wall.start.map(v => Math.round(v * 1e6) / 1e6);
    };
    assert.deepEqual(await start(), [-10,10]);
    if (federation) assert.deepEqual(await start(f.saved, f.unrelated), [10,10], 'Duplicate GUID in unrelated source is untouched');
    assert.ok(undoModelChanges(useViewerStore, applied.receipt).ok);
    assert.deepEqual(await start(), [10,10]);
  });
}

for(const metres of [true,false])test(`#7313 current named RelativePlacement is pinned in ${metres?'m':'mm'} after native STEP retarget`,async()=>{
 const f=await fixture(metres,false),old=captureSelectionGrounding(state()).elements[0]?.nativePlacement,editor=new StoreEditor(f.selected,f.view),root=f.selected.getEntity(f.id);assert.ok(root);const placement=root.attributes[5];assert.equal(typeof placement,'number');const scale=metres?1:.001;f.view.setExpressIdWatermark(getMaxExpressId(f.selected,[]));
 const point=editor.addEntity('IfcCartesianPoint',[[20/scale,10/scale,0]]),direction=editor.addEntity('IfcDirection',[[1,0,0]]),axis=editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,`#${direction.expressId}`]);editor.setAttribute(Number(placement),'RelativePlacement',`#${axis.expressId}`);
 const saved=await parseIfc(editedModelBytes(f.selected,f.view)),native=readWallJoinTarget(saved,new MutablePropertyView(saved.properties,f.owner),f.id,scale);assert.ok(native);assert.deepEqual(native.wall.start.map(v=>Math.round(v*1e6)/1e6),[20,10],'public named edit independently exports the current native start');
 const current=captureSelectionGrounding(state()).elements[0]?.nativePlacement;assert.ok(current&&!('layout'in current));assert.deepEqual(current.origin,[20,10],'current reviewed placement must match the independently exported native source');
 const make=(expected:NativePlacement)=>parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Explicit current native pivot',units:metres?'m':'mm',frame:'storey-local',operations:[{op:'element.rotate',target:{modelId:f.owner,globalId:f.selected.entities.getGlobalId(f.id),ifcClass:'IfcWall',name:f.selected.entities.getName(f.id)},angleDeg:90,pivot:[0,0],expected}]}));assert.ok(old);assert.notEqual(previewModelAuthoring(state(),make(old)).rows[0].status,'ready','old pins must refuse the native current retarget');
 const preview=previewModelAuthoring(state(),make(current));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'current native retarget');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const start=async()=>{const parsed=await parseIfc(editedModelBytes(f.selected,f.view)),read=readWallJoinTarget(parsed,new MutablePropertyView(parsed.properties,f.owner),f.id,scale);assert.ok(read);return read.wall.start.map(v=>Math.round(v*1e6)/1e6);};assert.deepEqual(await start(),[-10,20]);assert.ok(undoModelChanges(useViewerStore,result.receipt).ok);assert.deepEqual(await start(),[20,10]);
});
