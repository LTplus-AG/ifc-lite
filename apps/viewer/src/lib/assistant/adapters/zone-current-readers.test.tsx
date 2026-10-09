/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractProjectUnits, extractTypeQuantitiesOnDemand } from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/create';
import { generateIfcGuid } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureEvidence } from '@/lib/assistant/evidence';
import { setGlobalRendererRef } from '@/hooks/useBCF';

const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
afterEach(() => { setGlobalRendererRef({ current: null }); useViewerStore.getState().clearAllModels(); });

async function inheritedWall(t: TestContext) {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const draft = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(draft);
  const editor = new StoreEditor(f.store, draft);
  const ownerId = f.store.getEntity(f.id)?.attributes[1];
  const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
  for (const kind of ['IFCRELDEFINESBYPROPERTIES', 'IFCRELDEFINESBYTYPE']) {
    for (const id of f.store.entityIndex.byType.get(kind) ?? []) {
      const members = f.store.getEntity(id)?.attributes[4];
      if (!Array.isArray(members) || !members.includes(f.id)) continue;
      const others = members.filter(id => id !== f.id);
      if (others.length) draft.setPositionalAttribute(id, 4, others.map(id => `#${id}`)); else draft.deleteEntity(id);
    }
  }
  const makeType = (value: number) => {
    const quantity = editor.addEntity('IfcQuantityVolume', f.store.schemaVersion === 'IFC2X3'
      ? ['NetVolume', null, null, value] : ['NetVolume', null, null, value, null]).expressId;
    const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner, 'Qto_WallBaseQuantities', null, null, [`#${quantity}`]]).expressId;
    const type = editor.addEntity('IfcWallType', [generateIfcGuid(), owner, 'Current native wall type', null, null,
      [`#${qto}`], null, null, null, '.NOTDEFINED.']).expressId;
    return { quantity, qto, type };
  };
  const a = makeType(10), b = makeType(30);
  const relation = editor.addEntity('IfcRelDefinesByType', [generateIfcGuid(), owner, null, null, [`#${f.id}`], `#${a.type}`]).expressId;
  const store = await parse(editedModelBytes(f.store, draft));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: store }]]), ifcDataStore: store,
    mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  return { f, store, view, a, b, relation };
}
interface Basis { basis: string; totalM3?: number; ElementVolumeM3?: number }
interface CaptureData {
  zoneVolumeBreakdowns?: { quantityStatus: string; unitStatus: string; volumeBases: Basis[] };
  DeclaredQuantityStatus?: string; DeclaredUnitStatus?: string; VolumeBases?: Basis[]; ElementVolumeM3?: number;
}
function capture(source: 'selection' | 'zones') {
  const payload = JSON.parse(captureEvidence(source).payload) as { evidence: { rows: Array<{ data: CaptureData }> } };
  assert.ok(payload.evidence.rows.length, 'public native evidence retains the actual wall');
  const data = payload.evidence.rows[0].data;
  const bases = data.zoneVolumeBreakdowns?.volumeBases ?? data.VolumeBases ?? [];
  const value = (basis: string) => {
    const row = bases.find(row => row.basis === basis);
    return row?.totalM3 ?? row?.ElementVolumeM3;
  };
  return { data, value, quantityStatus: data.zoneVolumeBreakdowns?.quantityStatus ?? data.DeclaredQuantityStatus,
    unitStatus: data.zoneVolumeBreakdowns?.unitStatus ?? data.DeclaredUnitStatus,
    mesh: data.zoneVolumeBreakdowns ? value('mesh') : data.ElementVolumeM3 };
}
for (const source of ['selection', 'zones'] as const) {
  test(`#7220 ${source} follows current native HasPropertySets values and type reassignment`, async t => {
    const x = await inheritedWall(t); if (!x) return;
    const cache = useViewerStore.getState().zoneApportionment;
    assert.equal(capture(source).value('net'), 10);
    x.view.setPositionalAttribute(x.a.quantity, 3, 20);
    const exported = await parse(editedModelBytes(x.store, x.view));
    const native = extractTypeQuantitiesOnDemand(exported, x.f.id)?.quantities.flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
    assert.ok(native);
    assert.equal(native.value, 20, 'independent native export sees the edited authored type value');
    assert.equal(capture(source).value('net'), native.value);
    x.view.setPositionalAttribute(x.relation, 5, `#${x.b.type}`);
    const reassigned = await parse(editedModelBytes(x.store, x.view));
    const actual = extractTypeQuantitiesOnDemand(reassigned, x.f.id)?.quantities.flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
    assert.ok(actual);
    assert.equal(actual.value, 30);
    assert.equal(capture(source).value('net'), actual.value);
    assert.equal(useViewerStore.getState().zoneApportionment, cache, 'capture retains native SI geometry cache');
  });
  test(`#7220 ${source} current project units scale declared magnitude without rescaling native SI mesh`, async t => {
    const x = await inheritedWall(t); if (!x) return;
    const unit = (x.store.entityIndex.byType.get('IFCSIUNIT') ?? []).find(id =>
      String(x.store.getEntity(id)?.attributes[1]).replace(/\./g, '') === 'VOLUMEUNIT');
    assert.ok(unit);
    const before = capture(source);
    x.view.setPositionalAttribute(unit, 2, '.MILLI.');
    const exported = await parse(editedModelBytes(x.store, x.view));
    const scale = extractProjectUnits(exported.source, exported.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale;
    assert.ok(scale !== undefined);
    assert.equal(scale, 1e-9, 'independent native IFC declares cubic millimetres');
    const after = capture(source);
    assert.equal(after.value('net'), 10 * scale);
    assert.equal(after.mesh, before.mesh, 'mesh basis stays in native SI, separate from authored quantities');
    assert.equal(after.unitStatus, 'available');
  });
  test(`#7220 ${source} refuses malformed current type quantities without resurrecting source magnitude`, async t => {
    const x = await inheritedWall(t); if (!x) return;
    x.view.setPositionalAttribute(x.a.qto, 5, null);
    const exported = await parse(editedModelBytes(x.store, x.view));
    assert.equal(exported.getEntity(x.a.qto)?.attributes[5], null, 'independent export retains malformed required quantity references');
    const evidence = capture(source);
    assert.equal(evidence.quantityStatus, 'unavailable');
    assert.equal(evidence.value('net'), undefined, 'the source NetVolume10 cannot reappear');
    assert.ok(evidence.mesh !== undefined, 'native geometry evidence remains available');
  });
  test(`#7220 ${source} refuses an unreadable current project unit without a source-scale physical claim`, async t => {
    const x = await inheritedWall(t); if (!x) return;
    const unit = (x.store.entityIndex.byType.get('IFCSIUNIT') ?? []).find(id =>
      String(x.store.getEntity(id)?.attributes[1]).replace(/\./g, '') === 'VOLUMEUNIT');
    assert.ok(unit);
    x.view.setPositionalAttribute(unit, 3, null);
    const exported = await parse(editedModelBytes(x.store, x.view));
    assert.equal(exported.getEntity(unit)?.attributes[3], null);
    const evidence = capture(source);
    assert.equal(evidence.unitStatus, 'unavailable');
    assert.equal(evidence.value('net'), undefined, 'neither source units nor fabricated scale1 certify a declared magnitude');
    assert.ok(evidence.mesh !== undefined);
  });
}
