/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EMPTY_SOURCE_BYTES, IfcParser, extractProjectUnits, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureEvidence } from '@/lib/assistant/evidence';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { render, cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { assertSiVolume } from '@/test/native-quantity-assertions';
import { applyZoneWriteBack } from '@/hooks/useZoneWriteBack';
import { computeZoneApportionmentForElement } from '@/hooks/useZoneApportionment';
import { ZONE_QUANTITY_SET_NAME_PREFIX } from '@/lib/zones';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
interface Basis { basis: string; totalM3?: number; ElementVolumeM3?: number }
interface Row {
  zoneVolumeBreakdowns?: { unitStatus: string; volumeBases: Basis[] };
  DeclaredUnitStatus?: string; VolumeBases?: Basis[]; ElementVolumeM3?: number;
}
function read(source: 'selection' | 'zones') {
  const payload = JSON.parse(captureEvidence(source).payload) as { evidence: { rows: Array<{ data: Row }> } };
  assert.ok(payload.evidence.rows.length, 'public evidence retains the native selected wall');
  const row = payload.evidence.rows[0].data;
  const bases = row.zoneVolumeBreakdowns?.volumeBases ?? row.VolumeBases ?? [];
  const value = (name: string) => { const basis = bases.find(b => b.basis === name); return basis?.totalM3 ?? basis?.ElementVolumeM3; };
  return { net: value('net'), mesh: row.zoneVolumeBreakdowns ? value('mesh') : row.ElementVolumeM3,
    unitStatus: row.zoneVolumeBreakdowns?.unitStatus ?? row.DeclaredUnitStatus };
}
for (const source of ['selection', 'zones'] as const) {
  test(`#7220 ${source} source-free occurrence evidence honors native current volume units`, async t => {
    const f = await seedDeclaredZoneWall(t); if (!f) return;
    const draft = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(draft);
    const editor = new StoreEditor(f.store, draft);
    let removedQuantityRelationships = 0;
    // @raw-entity-enumeration-ok native fixture authoring removes only the real wall's source quantity relationships
    for (const id of f.store.entityIndex.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
      const attrs = f.store.getEntity(id)?.attributes;
      if (!Array.isArray(attrs?.[4]) || !attrs[4].includes(f.id) || typeof attrs[5] !== 'number'
        || f.store.getEntity(attrs[5])?.type.toUpperCase() !== 'IFCELEMENTQUANTITY') continue;
      removedQuantityRelationships++;
      const others = attrs[4].filter(id => id !== f.id);
      if (others.length) draft.setPositionalAttribute(id, 4, others.map(id => `#${id}`)); else draft.deleteEntity(id);
    }
    assert.ok(removedQuantityRelationships > 0, 'native setup removes the original occurrence quantity relationship');
    const ownerId = f.store.getEntity(f.id)?.attributes[1];
    const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
    const q = editor.addEntity('IfcQuantityVolume', f.store.schemaVersion === 'IFC2X3'
      ? ['NetVolume', null, null, 10] : ['NetVolume', null, null, 10, null]).expressId;
    const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner, 'SourceFree quantities', null, null, [`#${q}`]]).expressId;
    editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), owner, null, null, [`#${f.id}`], `#${qto}`]);
    const store = await parse(editedModelBytes(f.store, draft));
    const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
    const currentModel = { ...model, ifcDataStore: store, maxExpressId: getMaxExpressId(store, model.geometryResult?.meshes ?? []) };
    useViewerStore.setState({ models: new Map([['arch', currentModel]]), ifcDataStore: store,
      mutationViews: new Map(), storeEditors: new Map() });
    const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
    const current = new StoreEditor(store, view);
    const volume = current.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.MILLI.', '.CUBIC_METRE.']).expressId;
    const assignment = current.addEntity('IfcUnitAssignment', [[`#${volume}`]]).expressId;
    // @raw-entity-enumeration-ok native fixture authoring selects the source Project before any Project edits
    const project = store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
    view.setPositionalAttribute(project, 8, `#${assignment}`);
    const exported = await parse(editedModelBytes(store, view));
    const scale = extractProjectUnits(exported.source, exported.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale;
    assert.equal(scale, 1e-9, 'independent native export declares cubic millimetres');
    assert.ok(scale !== undefined);
    const native = extractQuantitiesOnDemand(exported, f.id).flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
    assert.ok(native); assert.equal(native.value, 10);
    assert.equal(native.explicitUnitSiScale, undefined, 'the occurrence quantity uses its Project units');
    const before = read(source); assert.ok(before.mesh !== undefined, 'real kernel SI mesh evidence is present');
    assertSiVolume(before.net, native.value * scale, 'source-backed capture agrees with the independent native export');
    const cache = useViewerStore.getState().zoneApportionment;
    const cacheEntry = cache.get(f.zoneSet.id);
    const revision = view.getMutationRevision();
    const changes = view.getEffectiveChanges().length;
    const undo = useViewerStore.getState().undoStacks;
    const redo = useViewerStore.getState().redoStacks;
    const geometry = useViewerStore.getState().models.get('arch')?.geometryResult;
    const sourceFree = { ...store, source: EMPTY_SOURCE_BYTES };
    useViewerStore.setState({ models: new Map([['arch', { ...currentModel, ifcDataStore: sourceFree }]]), ifcDataStore: sourceFree,
      propertiesActiveTab: 'quantities' });
    const panel = render(<PropertiesPanel />);
    assert.match(panel.textContent ?? '', /10 mm³/, 'Properties independently consults the surviving native unit view');
    const after = read(source);
    if (source === 'selection') {
      const selected = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;
      const ordinary = selected.quantities.flatMap((set: { quantities: Record<string, { value: number; unit: string | null }> }) =>
        Object.entries(set.quantities)).find(([name]: [string, { value: number; unit: string | null }]) => name === 'NetVolume');
      assert.ok(ordinary, '#7220 ordinary native quantity remains present beside Zone evidence');
      assert.equal(ordinary[1].value, native.value);
      assert.equal(ordinary[1].unit, 'mm³', '#7220 the same selected wall cannot publish current mm³ as ordinary m³');
      assert.equal(typeof after.net, 'number', '#7220 the declared native NetVolume basis is available');
      assert.ok(after.net !== undefined);
      assertSiVolume(ordinary[1].value * scale, after.net, '#7220 ordinary quantity and declared Zone basis describe the same physical magnitude');
    }
    assert.equal(after.unitStatus, 'available');
    assertSiVolume(after.net, native.value * scale, 'source release cannot certify the raw value as cubic metres');
    assert.equal(after.mesh, before.mesh, 'native geometry remains SI');
    assert.equal(useViewerStore.getState().zoneApportionment, cache, 'capture leaves apportionment cache intact');
    assert.equal(useViewerStore.getState().zoneApportionment.get(f.zoneSet.id), cacheEntry);
    assert.equal(useViewerStore.getState().models.get('arch')?.geometryResult, geometry);
    assert.equal(view.getMutationRevision(), revision);
    assert.equal(view.getEffectiveChanges().length, changes, 'evidence makes no native allocations or edits');
    assert.equal(useViewerStore.getState().undoStacks, undo);
    assert.equal(useViewerStore.getState().redoStacks, redo);
    assert.equal(useViewerStore.getState().mutationViews.get('arch'), view, 'capture neither replaces nor creates a view');
  });
}

// #7220: actual canonical writeback values are per-zone shares, not a new whole-element basis.
test('#7220 selection and Zones exclude native zone writeback quantities from whole-element declared bases', async t => {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  let removed = 0;
  // @raw-entity-enumeration-ok native fixture removes the selected wall's original quantity associations before canonical Zone writeback
  for (const id of f.store.entityIndex.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
    const attrs = f.store.getEntity(id)?.attributes;
    if (!Array.isArray(attrs?.[4]) || !attrs[4].includes(f.id) || typeof attrs[5] !== 'number'
      || f.store.getEntity(attrs[5])?.type.toUpperCase() !== 'IFCELEMENTQUANTITY') continue;
    removed++;
    const others = attrs[4].filter(id => id !== f.id);
    if (others.length) view.setPositionalAttribute(id, 4, others.map(id => `#${id}`)); else view.deleteEntity(id);
  }
  assert.ok(removed > 0, 'setup removes actual native occurrence quantity associations');
  useViewerStore.setState({ editEnabled: true });
  const written = applyZoneWriteBack(f.zoneSet, 'mesh');
  assert.equal(written.blocked, null); assert.equal(written.summary.written, 1);
  const exported = await parse(editedModelBytes(f.store, view));
  const qsets = extractQuantitiesOnDemand(exported, f.id);
  assert.ok(qsets.length > 0 && qsets.every(set => set.name.startsWith(ZONE_QUANTITY_SET_NAME_PREFIX)),
    'independent STEP readback contains only the canonical per-zone writeback quantity sets');
  const scale = extractProjectUnits(exported.source, exported.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale ?? 1;
  assertSiVolume(qsets.flatMap(set => set.quantities).reduce((n, quantity) => n + quantity.value * scale, 0),
    f.apportionment.wholeVolumeM3, 'actual per-zone native writeback reconciles to the kernel whole volume');
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: exported,
    maxExpressId: getMaxExpressId(exported, model.geometryResult?.meshes ?? []) }]]), ifcDataStore: exported,
    mutationViews: new Map(), storeEditors: new Map() });
  assert.deepEqual(useViewerStore.getState().resolveGlobalIdFromModels(f.id), { modelId: 'arch', expressId: f.id });
  assert.ok(computeZoneApportionmentForElement(f.zoneSet, f.id).apportionment, 'native split is freshly computed for the reparsed owner');
  const beforeVersion = useViewerStore.getState().mutationVersion;
  const beforeViews = useViewerStore.getState().mutationViews;
  const selected = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;
  assert.ok(selected.quantities.some((set: { name: string }) => set.name.startsWith(ZONE_QUANTITY_SET_NAME_PREFIX)),
    'ordinary quantities retain the actual writeback facts');
  assert.deepEqual(selected.zoneVolumeBreakdowns.volumeBases.map((basis: { basis: string }) => basis.basis), ['mesh'],
    'per-zone shares must not be split again as whole-element declared volume');
  const zones = JSON.parse(captureEvidence('zones').payload).evidence.rows;
  assert.equal(zones.length, 2);
  assert.ok(zones.every((row: { data: { VolumeBases: unknown[] } }) => row.data.VolumeBases.length === 0),
    'both public captures exclude the same canonical writeback sets');
  assert.equal(useViewerStore.getState().mutationVersion, beforeVersion);
  assert.equal(useViewerStore.getState().mutationViews, beforeViews, 'capture creates no native mutation view');
});

// #7220: STEP lazy quantities do not materialize into a retained table when warmed.
// This witnesses false unit availability after source release, not a fabricated retained-value conversion.
for (const route of ['selection', 'zones', 'properties'] as const) {
  test(`#7220 ${route} source-free no-view native unit context is explicitly unavailable`, async t => {
    const f = await seedDeclaredZoneWall(t); if (!f) return;
    const draft = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(draft);
    const editor = new StoreEditor(f.store, draft);
    let removedQuantityRelationships = 0;
    // @raw-entity-enumeration-ok native fixture authoring removes only the real wall's source quantity relationships
    for (const id of f.store.entityIndex.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
      const attrs = f.store.getEntity(id)?.attributes;
      if (!Array.isArray(attrs?.[4]) || !attrs[4].includes(f.id) || typeof attrs[5] !== 'number'
        || f.store.getEntity(attrs[5])?.type.toUpperCase() !== 'IFCELEMENTQUANTITY') continue;
      removedQuantityRelationships++;
      const others = attrs[4].filter(id => id !== f.id);
      if (others.length) draft.setPositionalAttribute(id, 4, others.map(id => `#${id}`)); else draft.deleteEntity(id);
    }
    assert.ok(removedQuantityRelationships > 0, 'native setup removes the original occurrence quantity relationship');
    const ownerId = f.store.getEntity(f.id)?.attributes[1];
    const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
    const q = editor.addEntity('IfcQuantityVolume', f.store.schemaVersion === 'IFC2X3'
      ? ['NetVolume', null, null, 10] : ['NetVolume', null, null, 10, null]).expressId;
    const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner, 'SourceFree quantities', null, null, [`#${q}`]]).expressId;
    editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), owner, null, null, [`#${f.id}`], `#${qto}`]);
    const store = await parse(editedModelBytes(f.store, draft));
    const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
    const currentModel = { ...model, ifcDataStore: store, maxExpressId: getMaxExpressId(store, model.geometryResult?.meshes ?? []) };
    useViewerStore.setState({ models: new Map([['arch', currentModel]]), ifcDataStore: store,
      mutationViews: new Map(), storeEditors: new Map() });
    const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
    const current = new StoreEditor(store, view);
    const volume = current.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.MILLI.', '.CUBIC_METRE.']).expressId;
    const assignment = current.addEntity('IfcUnitAssignment', [[`#${volume}`]]).expressId;
    // @raw-entity-enumeration-ok native fixture authoring selects the source Project before any Project edits
    const project = store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
    view.setPositionalAttribute(project, 8, `#${assignment}`);
    const exported = await parse(editedModelBytes(store, view));
    const scale = extractProjectUnits(exported.source, exported.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale;
    assert.equal(scale, 1e-9, 'independent native export declares cubic millimetres');
    assert.ok(scale !== undefined);
    const native = extractQuantitiesOnDemand(exported, f.id).flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
    assert.ok(native); assert.equal(native.value, 10);
    assert.equal(native.explicitUnitSiScale, undefined, 'the occurrence quantity uses its Project units');
    const reparsedModel = { ...currentModel, ifcDataStore: exported,
      maxExpressId: getMaxExpressId(exported, model.geometryResult?.meshes ?? []) };
    useViewerStore.setState({ models: new Map([['arch', reparsedModel]]), ifcDataStore: exported,
      mutationViews: new Map(), storeEditors: new Map(), propertiesActiveTab: 'quantities' });
    assert.equal(useViewerStore.getState().mutationViews.size, 0, 'native export is reloaded without an edit view');
    const warm = exported.getQuantities(f.id).flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
    assert.ok(warm); assert.equal(warm.value, 10, 'the real source-backed native getter is warmed');
    const sourceBacked = read(route === 'zones' ? 'zones' : 'selection');
    assertSiVolume(sourceBacked.net, native.value * scale, 'intact no-view native capture agrees with independent mm³ export');
    const retained = exported.quantities.getForEntity(f.id);
    const sourceFree = { ...exported, source: EMPTY_SOURCE_BYTES };
    useViewerStore.setState({ models: new Map([['arch', { ...reparsedModel, ifcDataStore: sourceFree }]]), ifcDataStore: sourceFree });
    assert.deepEqual(sourceFree.getQuantities(f.id), retained,
      'remaining quantities come from the actual native precomputed table; warming invents no retained values');
    const cache = useViewerStore.getState().zoneApportionment;
    const views = useViewerStore.getState().mutationViews;
    const version = useViewerStore.getState().mutationVersion;
    const after = read(route === 'zones' ? 'zones' : 'selection');
    assert.equal(after.mesh, sourceBacked.mesh, 'the native cached SI mesh survives release without rescaling');
    if (route === 'properties') {
      const panel = render(<PropertiesPanel />);
      assert.match(panel.textContent ?? '', /Current quantity units are unavailable/,
        'the mounted native card must report absent unit context even without remaining quantities');
      assert.doesNotMatch(panel.textContent ?? '', /10 m³/, 'no manufactured SI quantity label');
    } else {
      assert.equal(after.unitStatus, 'unavailable', 'absent native source and view cannot certify an available SI context');
      assert.equal(after.net, undefined, 'missing context cannot publish a declared SI basis');
    }
    assert.equal(useViewerStore.getState().zoneApportionment, cache);
    assert.equal(useViewerStore.getState().mutationViews, views);
    assert.equal(useViewerStore.getState().mutationViews.size, 0, 'capture does not manufacture a native edit view');
    assert.equal(useViewerStore.getState().mutationVersion, version);
  });
}
