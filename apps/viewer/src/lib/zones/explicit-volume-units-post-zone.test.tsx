/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EMPTY_SOURCE_BYTES, readCurrentTypeQuantities, extractProjectUnits, extractQuantitiesOnDemand, extractTypeQuantitiesOnDemand } from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { cleanup } from '@/test/render';
import { parse, materializeSourceFreeQuantityFixture } from '@/test/inherited-quantities-native-fixture';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { captureEvidence } from '@/lib/assistant/evidence';
import { explicitFixture } from '@/test/explicit-volume-unit-native-fixture';
import { assertSiVolume } from '@/test/native-quantity-assertions';
import { volumeBasisLabel } from '@/lib/zones';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });

function assertEvidenceNet(expectedM3: number) {
  for (const source of ['selection', 'zones'] as const) {
    const payload = JSON.parse(captureEvidence(source).payload) as { evidence: { rows: Array<{ data: {
      zoneVolumeBreakdowns?: { quantityStatus: string; volumeBases: Array<{ basis: string; totalM3?: number }> };
      DeclaredQuantityStatus?: string; VolumeBases?: Array<{ basis: string; ElementVolumeM3?: number }>;
    } }> } };
    assert.ok(payload.evidence.rows.length, 'public evidence retains the real native selected wall');
    const row = payload.evidence.rows[0].data;
    assert.equal(row.zoneVolumeBreakdowns?.quantityStatus ?? row.DeclaredQuantityStatus, 'available');
    const net = row.zoneVolumeBreakdowns?.volumeBases.find(basis => basis.basis === 'net')?.totalM3
      ?? row.VolumeBases?.find(basis => basis.basis === 'net')?.ElementVolumeM3;
    assertSiVolume(net, expectedM3, `${source} evidence agrees with independently native explicit volume`);
  }
}

function assertEvidenceUnavailable(expectedMeshM3: number, expectedGrossM3: number | null, assertUnitRefusal = false) {
  for (const source of ['selection', 'zones'] as const) {
    const payload = JSON.parse(captureEvidence(source).payload) as { evidence: { rows: Array<{ data: {
      Basis?: string; ElementVolumeM3?: number; DeclaredUnitStatus?: string; DeclaredUnitReason?: string | null;
      zoneVolumeBreakdowns?: { unitStatus?: string; unitReason?: string | null; volumeBases: Array<{ basis: string; totalM3?: number; ElementVolumeM3?: number }> }; VolumeBases?: Array<{ basis: string; totalM3?: number; ElementVolumeM3?: number }>;
    } }> } };
    assert.ok(payload.evidence.rows.length, 'public evidence retains the native selected wall');
    const row = payload.evidence.rows[0].data;
    if (assertUnitRefusal) {
      const status = row.zoneVolumeBreakdowns?.unitStatus ?? row.DeclaredUnitStatus;
      const reason = row.zoneVolumeBreakdowns?.unitReason ?? row.DeclaredUnitReason;
      assert.equal(status, 'unavailable', `${source} public evidence reports unsupported native Unit as unavailable`);
      assert.ok(typeof reason === 'string' && reason.trim().length > 0, `${source} public evidence explains native Unit refusal`);
    }
    const bases = row.zoneVolumeBreakdowns?.volumeBases ?? row.VolumeBases;
    assert.ok(bases, 'declared basis availability is explicitly represented');
    assert.ok(!bases.some(basis => basis.basis === 'net'), 'unavailable first Net basis cannot promote a later quantity; independent mesh/Gross remain eligible');
    const mesh = source === 'selection' ? bases.find(basis => basis.basis === 'mesh') : row;
    assert.ok(mesh, 'independent native mesh remains available despite declared Net refusal');
    if (source === 'zones') assert.equal(row.Basis, volumeBasisLabel('mesh'), 'Zones keeps mesh on its canonical top-level row');
    assertSiVolume('totalM3' in mesh ? mesh.totalM3 ?? mesh.ElementVolumeM3 : mesh.ElementVolumeM3, expectedMeshM3, `${source} retains independent native SI mesh`);
    const gross = bases.find(basis => basis.basis === 'gross');
    if (expectedGrossM3 === null) assert.equal(gross, undefined, 'unknown project context withholds implicit Gross magnitude');
    else { assert.ok(gross, 'valid independent implicit Gross remains available'); assertSiVolume(gross.totalM3 ?? gross.ElementVolumeM3, expectedGrossM3, `${source} retains independently valid Gross`); }
  }
}

test('#7376 unavailable current project context keeps explicitly resolvable native volume but retains independent evidence', async t => {
  const x = await explicitFixture(t, true); if (!x) return;
  // @raw-entity-enumeration-ok fixture identifies the original native Project before unsetting its current assignment.
  const project = x.store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
  x.view.setPositionalAttribute(project, 8, null);
  const exported = await parse(editedModelBytes(x.store, x.view));
  assert.equal(exported.getEntity(project)?.attributes[8], null, 'independent native export contains unavailable UnitsInContext');
  assert.equal(exported.getEntity(x.quantityId)?.attributes[2], x.unit);
  const explicit = extractQuantitiesOnDemand(exported, x.f.id).flatMap(set => set.quantities).find(q => q.name === x.quantityName);
  assert.equal(explicit?.explicitUnitSiScale, 1e-9, 'explicit member remains independently resolved');
  const before = editedModelBytes(x.store, x.view), revision = x.view.getMutationRevision();
  assertEvidenceNet(1e-8);
  assert.equal(x.view.getMutationRevision(), revision);
  await assertSameNativeIfcGraph(editedModelBytes(x.store, x.view), before);
});


test('#7376 unsupported first occurrence volume unit refuses the basis instead of falling through to later own or valid inherited quantity through post-zone selected evidence', async t => {
  const x = await explicitFixture(t, true); if (!x) return;
  const wrong = new StoreEditor(x.store, x.view).addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']).expressId;
  x.view.setPositionalAttribute(x.quantityId, 2, `#${wrong}`);
  // Deliberately author/reparse a new source before reading. This is not a
  // claim that the separate live own-quantity Unit cache defect (#7379) is fixed.
  const source = await parse(editedModelBytes(x.store, x.view));
  assert.equal(source.getEntity(x.quantityId)?.attributes[2], wrong);
  assert.equal(source.getEntity(x.quantityId)?.attributes[3], 10);
  assert.deepEqual(source.getEntity(wrong)?.attributes.slice(1), ['.LENGTHUNIT.', '.MILLI.', '.METRE.']);
  const inherited = extractTypeQuantitiesOnDemand(source, x.f.id)?.quantities.flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
  assert.equal(inherited?.value, 30); assert.equal(inherited?.explicitUnitSiScale, 1e-9, 'independent inherited alternative remains genuinely available');
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source,
    maxExpressId: getMaxExpressId(source, model.geometryResult?.meshes ?? []) }]]), ifcDataStore: source,
    mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  const before = editedModelBytes(source, view), revision = view.getMutationRevision();
  assertEvidenceUnavailable(x.f.apportionment.wholeVolumeM3, 99, true);
  assert.equal(view.getMutationRevision(), revision);
  await assertSameNativeIfcGraph(editedModelBytes(source, view), before);
});

for (const remove of [false, true]) {
  test(`#7376 current native Type quantity Unit ${remove ? 'removal' : 'replacement'} reaches selection and Zones evidence without stale source metadata`, async t => {
    const x = await explicitFixture(t, false); if (!x) return;
    const replacement = remove ? null : new StoreEditor(x.store, x.view)
      .addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.CENTI.', '.CUBIC_METRE.']).expressId;
    x.view.setPositionalAttribute(x.quantityId, 2, replacement === null ? null : `#${replacement}`);
    const exported = await parse(editedModelBytes(x.store, x.view));
    assert.equal(exported.getEntity(x.quantityId)?.attributes[2], replacement);
    const native = extractTypeQuantitiesOnDemand(exported, x.f.id)?.quantities.flatMap(set => set.quantities).find(q => q.name === x.quantityName);
    assert.ok(native); assert.equal(native.value, 10);
    if (remove) assert.equal(native.explicitUnitSiScale, undefined);
    else assert.ok(native.explicitUnitSiScale !== undefined && Math.abs(native.explicitUnitSiScale - 1e-6) < 1e-20,
      'canonical centimetre-cubed scaling differs only within floating-point roundoff');
    const expectedM3 = remove ? 10 : 1e-5;
    assert.equal(extractProjectUnits(exported.source, exported.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale, 1);
    const before = editedModelBytes(x.store, x.view), revision = x.view.getMutationRevision();
    assertEvidenceNet(expectedM3);
    assert.equal(x.view.getMutationRevision(), revision);
    await assertSameNativeIfcGraph(editedModelBytes(x.store, x.view), before);
  });
}



for (const occurrence of [true, false]) {
  test(`#7376 native ${occurrence ? 'occurrence first basis' : 'inherited Type'} explicit volume agrees in selection and Zones evidence`, async t => {
    const x = await explicitFixture(t, occurrence); if (!x) return;
    const state = useViewerStore.getState(), cache = state.zoneApportionment, geometry = state.models.get('arch')?.geometryResult;
    const cacheEntry = cache.get(x.f.zoneSet.id), revision = x.view.getMutationRevision(), changes = x.view.getEffectiveChanges();
    assert.ok(cacheEntry); assert.equal(cacheEntry.byElement.get(x.f.id), x.f.apportionment, 'actual native apportionment is present before reading');
    const before = editedModelBytes(x.store, x.view);
    assertEvidenceNet(1e-8);
    assert.equal(useViewerStore.getState().zoneApportionment, cache); assert.equal(cache.get(x.f.zoneSet.id), cacheEntry);
    assert.equal(useViewerStore.getState().models.get('arch')?.geometryResult, geometry);
    assert.equal(x.view.getMutationRevision(), revision); assert.deepEqual(x.view.getEffectiveChanges(), changes);
    await assertSameNativeIfcGraph(editedModelBytes(x.store, x.view), before, 'public evidence read leaves every native record unchanged');
  });
}



test('#7376 source-free native Type explicit unit survives through actual current view in selection and Zones evidence', async t => {
  const x = await explicitFixture(t, false); if (!x) return;
  const exported = await parse(editedModelBytes(x.store, x.view));
  assert.equal(exported.getEntity(x.quantityId)?.attributes[2], x.unit, 'independently exported source retains quantity Unit before metadata materialization');
  assert.equal(exported.getEntity(x.quantityId)?.attributes[3], 10, 'quantity scalar was never converted to a reference');
  assert.deepEqual(exported.getEntity(x.a.qto)?.attributes[5], x.store.getEntity(x.a.qto)?.attributes[5]);
  assert.deepEqual(exported.getEntity(x.relation)?.attributes[4], x.store.getEntity(x.relation)?.attributes[4]);
  assert.equal(exported.getEntity(x.relation)?.attributes[5], x.a.type);
  const native = extractTypeQuantitiesOnDemand(exported, x.f.id)?.quantities.flatMap(set => set.quantities).find(q => q.name === x.quantityName);
  assert.equal(native?.explicitUnitSiScale, 1e-9);
  materializeSourceFreeQuantityFixture(x.store, x.view, new Map<number, ReadonlySet<number>>([
    [x.a.type, new Set([1, 5, 6])], [x.a.qto, new Set([1, 5])], [x.a.volume, new Set([2])],
  ]), [x.unit]);
  assert.equal(x.view.getPositionalMutationsForEntity(x.quantityId)?.get(2), `#${x.unit}`);
  assert.equal(x.view.getPositionalMutationsForEntity(x.quantityId)?.get(3), 10);
  const materializedChanges = x.view.getEffectiveChanges();
  const before = editedModelBytes(x.store, x.view), revision = x.view.getMutationRevision();
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  const sourceFree = { ...x.store, source: EMPTY_SOURCE_BYTES };
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: sourceFree }]]), ifcDataStore: sourceFree });
  const currentQuantityRead = readCurrentTypeQuantities(sourceFree, x.f.id, x.view);
  assert.equal(currentQuantityRead.status, 'available', currentQuantityRead.reason ?? 'source-free native inventory is complete');
  assertEvidenceNet(1e-8);
  assert.equal(x.view.getMutationRevision(), revision);
  assert.deepEqual(x.view.getEffectiveChanges(), materializedChanges);
  assert.equal(x.view.getPositionalMutationsForEntity(x.quantityId)?.get(2), `#${x.unit}`);
  assert.equal(x.view.getPositionalMutationsForEntity(x.quantityId)?.get(3), 10);
  await assertSameNativeIfcGraph(editedModelBytes(x.store, x.view), before);
});


test('#7376 unavailable project context retains the first implicit occurrence basis instead of promoting a later explicit native quantity through post-zone selected evidence', async t => {
  const x = await explicitFixture(t, true); if (!x) return;
  x.view.setPositionalAttribute(x.quantityId, 2, null);
  // Author/reparse the implicit occurrence before reading; this does not claim
  // that live own-quantity Unit metadata edits (#7379) have been implemented.
  const source = await parse(editedModelBytes(x.store, x.view));
  assert.equal(source.getEntity(x.quantityId)?.attributes[2], null);
  assert.equal(source.getEntity(x.quantityId)?.attributes[3], 10);
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source,
    maxExpressId: getMaxExpressId(source, model.geometryResult?.meshes ?? []) }]]), ifcDataStore: source,
    mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  // @raw-entity-enumeration-ok fixture identifies the parsed native Project before removing its current assignment.
  const project = source.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
  view.setPositionalAttribute(project, 8, null);
  const exported = await parse(editedModelBytes(source, view));
  assert.equal(exported.getEntity(project)?.attributes[8], null);
  const own = extractQuantitiesOnDemand(exported, x.f.id).flatMap(set => set.quantities);
  const first = own.find(q => q.name === 'NetExplicitVolume'); assert.ok(first);
  assert.equal(first.value, 10); assert.equal(first.explicitUnitSiScale, undefined);
  const later = own.find(q => q.name === 'NetLaterVolume'); assert.ok(later);
  assert.equal(later.value, 999); assert.equal(later.explicitUnitSiScale, 1e-9);
  const inherited = extractTypeQuantitiesOnDemand(exported, x.f.id)?.quantities.flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
  assert.equal(inherited?.value, 30); assert.equal(inherited?.explicitUnitSiScale, 1e-9);
  const before = editedModelBytes(source, view), revision = view.getMutationRevision();
  assertEvidenceUnavailable(x.f.apportionment.wholeVolumeM3, null);
  assert.equal(view.getMutationRevision(), revision);
  await assertSameNativeIfcGraph(editedModelBytes(source, view), before);
});

