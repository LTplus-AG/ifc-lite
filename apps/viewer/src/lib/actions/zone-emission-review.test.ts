/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test, afterEach, type TestContext } from 'node:test';
import type { Renderer } from '@ifc-lite/renderer';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { removeSpatialZones } from '@/lib/zones/emit-spatial-zones';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { Scene } from '../../../../../packages/renderer/src/scene';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { recomputeZoneAssignmentsNow } from '@/hooks/useZoneAssignmentSync';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from './selection-grounding';
import { nativeZoneEmissionEvidence } from './zone-emission-evidence';
import { prepareZoneEmission } from './zone-emission-review';
import { parseZoneEmissionProposal } from './zone-emission-proposal';
import { decodeModelChangeReceipt } from './receipts';
import { undoModelChanges } from './model-change-commit';
const initial = useViewerStore.getState();
afterEach(() => { setGlobalRendererRef({ current: null }); useViewerStore.setState(initial, true); });
async function seed(t: TestContext) {
  if (!ensureWasm(t)) return null;
  const f = await seedZoneExport();
  useViewerStore.setState({ editEnabled: true, collabRole: null, collabRoomId: null, storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), removedNewEntities: new Map(), removedMeshes: new Map(), dirtyModels: new Set(), mutationVersion: 0 });
  const model = useViewerStore.getState().models.get('bonsai')!;
  useViewerStore.setState({ models: new Map([['bonsai', { ...model, idOffset: 0, maxExpressId: Math.max(...f.store.entityIndex.byId.keys()) }]]) });
  const scene = new Scene(); f.meshes.forEach(mesh => scene.addMeshData(mesh)); setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  useViewerStore.getState().addEntityToSelection({ modelId: 'bonsai', expressId: f.wall.expressId }); useViewerStore.getState().setSelectedEntityIds([f.wall.expressId]);
  recomputeZoneAssignmentsNow(); return { ...f, scene };
}
function proposal() {
  const evidence = nativeZoneEmissionEvidence(useViewerStore.getState(), 'bonsai');
  const choice = evidence.choices.find(row => row.status === 'available'); assert.ok(choice?.expected, 'genuinely evaluated native snapshot must be available without private proposal evidence: ' + JSON.stringify(evidence));
  return parseZoneEmissionProposal(JSON.stringify({ version: 1, kind: 'zones.emit', title: 'Review native Bonsai zones', modelId: 'bonsai', zoneSetId: choice.zoneSetId, storey: { GlobalId: choice.expected.storey.GlobalId, Name: choice.expected.storey.Name }, expected: choice.expected }));
}
test('#7322 actual native evaluation producer stays pure, prepared emission exports genuine membership and grouped receipt Undo', async t => {
  const f = await seed(t); if (!f) return;
  const state = useViewerStore.getState(), views = state.mutationViews, editors = state.storeEditors, history = state.undoStacks;
  const grounding = captureSelectionGrounding(state); assert.equal(grounding.elements[0].nativeZoneEmission.status, 'available-targets');
  const review = prepareZoneEmission(useViewerStore, proposal());
  assert.equal(useViewerStore.getState().mutationViews, views); assert.equal(views.size, 0); assert.equal(useViewerStore.getState().storeEditors, editors); assert.equal(editors.size, 0); assert.equal(useViewerStore.getState().undoStacks, history);
  const receipt = review.commit('explicit native approval'); assert.ok(decodeModelChangeReceipt(receipt)); assert.equal(receipt.kind, 'zones.emit');
  const view = useViewerStore.getState().mutationViews.get('bonsai')!;
  const saved = await parseIfc(editedModelBytes(f.store, view)), zones = saved.entityIndex.byType.get('IFCSPATIALZONE'); assert.equal(zones?.length, 1);
  const refs = [...saved.entityIndex.byType.get('IFCRELREFERENCEDINSPATIALSTRUCTURE') ?? []].map(id => effectiveMetadataRecord(saved, id)!); assert.ok(refs.some(row => (row.attributes[4] as number[]).includes(f.wall.expressId)));
  assert.throws(() => review.commit('repeat'), /already/);
  const undo = undoModelChanges(useViewerStore, receipt); assert.equal(undo.ok, true);
  assert.equal((await parseIfc(editedModelBytes(f.store, view))).entityIndex.byType.get('IFCSPATIALZONE')?.length ?? 0, 0);
});
test('#7322 a genuine exported native SpatialZone receipt cannot be imported as a Cost graph', async t => {
  const f = await seed(t); if (!f) return;
  const receipt = prepareZoneEmission(useViewerStore, proposal()).commit('explicit native SpatialZone approval');
  const view = useViewerStore.getState().mutationViews.get('bonsai')!;
  const saved = await parseIfc(editedModelBytes(f.store, view));
  assert.equal(saved.entityIndex.byType.get('IFCSPATIALZONE')?.length, 1, 'the receipt originates from a genuine current native emission');
  assert.ok(receipt.applied.some(row => row.op === 'zones.emit'));
  assert.ok(decodeModelChangeReceipt(receipt), 'the original native receipt remains importable');
  const before = structuredClone({ changes: view.getEffectiveChanges(), revision: view.getMutationRevision(), next: view.peekNextExpressId() });
  assert.equal(decodeModelChangeReceipt({ ...receipt, kind: 'cost.graph' }), null, 'an emitted SpatialZone cannot acquire Cost receipt semantics');
  assert.deepEqual({ changes: view.getEffectiveChanges(), revision: view.getMutationRevision(), next: view.peekNextExpressId() }, before, 'receipt decoding cannot mutate the native graph');
});
test('#7322 stale evaluation cannot be certified from old timing after same-ID set, assignments or native geometry change', async t => {
  const f = await seed(t); if (!f) return;
  const review = prepareZoneEmission(useViewerStore, proposal());
  useViewerStore.setState({ zoneSets: [{ ...f.zoneSet, name: 'Changed same-ID native set' }] }); assert.throws(() => review.commit('stale set'), /evaluation|changed/);
  recomputeZoneAssignmentsNow(); const next = prepareZoneEmission(useViewerStore, proposal());
  const assignments = useViewerStore.getState().zoneAssignments; assignments.get(f.wall.expressId)![f.zoneSet.id].touchedZoneIds = []; assert.throws(() => next.commit('stale membership'), /evaluation|changed/);
  recomputeZoneAssignmentsNow(); const geometry = prepareZoneEmission(useViewerStore, proposal());
  const prior = f.scene.getEntityBoundingBox(f.wall.expressId); assert.ok(prior);
  f.scene.removeMeshesForEntity(f.wall.expressId);
  f.scene.addMeshData({ ...f.wall, positions: new Float32Array(f.wall.positions).map(value => value + 1) });
  const replaced = f.scene.getEntityBoundingBox(f.wall.expressId); assert.ok(replaced); assert.notDeepEqual(replaced, prior, 'native replacement invalidates cached bounds and changes the actual evaluation input');
  assert.throws(() => geometry.commit('stale actual Scene bounds'), /evaluation|changed/);
});
test('#7322 absent evaluation or explicit wrong set/storey refuses rather than choosing a default', async t => {
  const f = await seed(t); if (!f) return;
  const good = proposal(); assert.throws(() => prepareZoneEmission(useViewerStore, { ...good, storey: { ...good.storey, GlobalId: generateIfcGuid() } }), /unavailable or ambiguous/, 'a valid but absent native Root identity is a resolution refusal'); assert.throws(() => prepareZoneEmission(useViewerStore, { ...good, zoneSetId: 'unknown-set' }), /set|unavailable/);
  assert.throws(() => prepareZoneEmission(useViewerStore, { ...good, storey: { ...good.storey, Name: 'Wrong native storey name' } }), /differs/);
  setGlobalRendererRef({ current: null }); assert.equal(nativeZoneEmissionEvidence(useViewerStore.getState(), 'bonsai').status, 'unavailable-evaluation'); assert.throws(() => prepareZoneEmission(useViewerStore, good), /evaluation/);
});
test('#7322 an old proposal refuses a fresh byte-identical source/evaluation owner and a same-ID source reload', async t => {
  const f = await seed(t); if (!f) return;
  const old = proposal(); recomputeZoneAssignmentsNow(); assert.throws(() => prepareZoneEmission(useViewerStore, old), /differs/, 'a fresh actual evaluation has its own native owner, even when values match');
  const prepared = prepareZoneEmission(useViewerStore, proposal()), original = useViewerStore.getState().models.get('bonsai')!;
  const reloaded = await parseIfc(new Uint8Array(f.store.source)); assert.deepEqual(reloaded.source, f.store.source, 'native reload has identical source bytes'); useViewerStore.setState({ models: new Map([['bonsai', { ...original, ifcDataStore: reloaded }]]) });
  assert.throws(() => prepared.commit('same-ID source reload'), /source|changed/);
  recomputeZoneAssignmentsNow(); assert.throws(() => prepareZoneEmission(useViewerStore, old), /differs|unavailable/, 'a reloaded source must refuse old evidence, including native unavailable-unit refusal');
});

test('#7322 native federated evaluation emits only explicitly chosen model and set, retaining other set outputs', async t => {
  const f = await seed(t); if (!f) return;
  const primary = useViewerStore.getState().models.get('bonsai')!;
  const peerStore = await parseIfc(new Uint8Array(f.store.source));
  useViewerStore.setState({ models: new Map([['bonsai', primary], ['peer', { ...primary, id: 'peer', idOffset: 1000000, ifcDataStore: peerStore }]]) });
  f.meshes.forEach(mesh => f.scene.addMeshData({ ...mesh, expressId: mesh.expressId + 1000000 }));
  recomputeZoneAssignmentsNow();
  assert.equal(useViewerStore.getState().resolveGlobalIdFromModels(f.wall.expressId + 1000000)?.modelId, 'peer');
  assert.ok(useViewerStore.getState().zoneAssignments.get(f.wall.expressId + 1000000)?.[f.zoneSet.id], 'the actual native evaluator includes the independent loaded peer');
  const p = proposal();
  const reordered = { ...p, expected: Object.fromEntries(Object.entries(p.expected).reverse()) };
  const receipt = prepareZoneEmission(useViewerStore, reordered).commit('explicit Bonsai only');
  assert.deepEqual(receipt.batches.map(row => row.modelId), ['bonsai']);
  assert.equal(useViewerStore.getState().mutationViews.has('peer'), false);
  assert.equal((await parseIfc(new Uint8Array(peerStore.source))).entityIndex.byType.get('IFCSPATIALZONE')?.length ?? 0, 0);
  const other = { ...f.zoneSet, id: 'separate-zone-set', name: 'Independent native sections' };
  useViewerStore.setState({ zoneSets: [f.zoneSet, other] }); recomputeZoneAssignmentsNow();
  const choice = nativeZoneEmissionEvidence(useViewerStore.getState(), 'bonsai').choices.find(row => row.zoneSetId === other.id && row.status === 'available'); assert.ok(choice?.expected);
  const otherProposal = parseZoneEmissionProposal(JSON.stringify({ ...proposal(), zoneSetId: other.id, expected: choice.expected }));
  prepareZoneEmission(useViewerStore, otherProposal).commit('independent other set');
  useViewerStore.setState({ zoneSets: [{ ...f.zoneSet, name: 'Renamed native sections' }, other] }); recomputeZoneAssignmentsNow();
  const replacement = prepareZoneEmission(useViewerStore, proposal()); assert.equal(replacement.dry.outcome.zonesReplaced, 1); replacement.commit('rename own set only');
  const saved = await parseIfc(editedModelBytes(f.store, useViewerStore.getState().mutationViews.get('bonsai')!));
  const zones = [...saved.entityIndex.byType.get('IFCSPATIALZONE') ?? []].map(id => effectiveMetadataRecord(saved, id)!);
  assert.equal(zones.length, 2); assert.deepEqual(zones.map(row => row.attributes[7]).sort(), ['Independent native sections', 'Renamed native sections']);
});
test('#7322 imported marked outputs are retained while externally referenced current-session outputs refuse replacement', async t => {
  const f = await seed(t); if (!f) return;
  prepareZoneEmission(useViewerStore, proposal()).commit('native first output');
  const view = useViewerStore.getState().mutationViews.get('bonsai')!, zone = view.getNewEntities().find(row => row.type === 'IfcSpatialZone'); assert.ok(zone);
  const imported = await parseIfc(editedModelBytes(f.store, view));
  assert.equal(imported.entityIndex.byType.get('IFCSPATIALZONE')?.length, 1, 'independent STEP reload establishes a real imported marked output');
  const importedView = new MutablePropertyView(imported.properties ?? null, 'imported');
  assert.equal(removeSpatialZones(new StoreEditor(imported, importedView), f.zoneSet), 0, 'canonical removal cannot claim imported source outputs as this-session ownership');
  assert.equal((await parseIfc(editedModelBytes(imported, importedView))).entityIndex.byType.get('IFCSPATIALZONE')?.length, 1);
  recordModellingEdit(useViewerStore, 'bonsai', (_methods, draft) => {
    const group = draft.addEntity('IfcGroup', [generateIfcGuid(), null, 'External group', null, null]);
    draft.addEntity('IfcRelAssignsToGroup', [generateIfcGuid(), null, 'External assignment', null, [`#${zone.expressId}`], null, `#${group.expressId}`]);
  }, 'external native group');
  const saved = await parseIfc(editedModelBytes(f.store, view));
  assert.ok([...saved.entityIndex.byType.get('IFCRELASSIGNSTOGROUP') ?? []].some(id => (effectiveMetadataRecord(saved, id)!.attributes[4] as number[]).includes(zone.expressId)), 'actual exported unrelated relationship references the prior zone');
  recomputeZoneAssignmentsNow(); const evidence = nativeZoneEmissionEvidence(useViewerStore.getState(), 'bonsai');
  assert.ok(evidence.choices.some(row => row.reason?.includes('referenced outside')), JSON.stringify(evidence));
  const bytes = editedModelBytes(f.store, view); assert.throws(() => proposal(), /available/); assert.deepEqual(editedModelBytes(f.store, view), bytes);
});
