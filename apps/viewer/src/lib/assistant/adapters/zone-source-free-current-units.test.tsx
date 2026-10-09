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

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
interface Basis { basis: string; totalM3?: number; ElementVolumeM3?: number }
interface Row {
  zoneVolumeBreakdowns?: { unitStatus: string; volumeBases: Basis[] };
  DeclaredUnitStatus?: string; VolumeBases?: Basis[]; ElementVolumeM3?: number;
}
function sameSiVolume(actual: number | undefined, expected: number, message: string) {
  assert.ok(actual !== undefined && Number.isFinite(actual), message);
  // Native unit readers use algebraically equivalent prefix powers whose
  // floating point rounding may differ by a few ULPs after volume scaling.
  assert.ok(Math.abs(actual - expected) <= 8 * Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected)),
    `${message}: ${actual} versus ${expected}`);
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
    sameSiVolume(before.net, native.value * scale, 'source-backed capture agrees with the independent native export');
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
    assert.equal(after.unitStatus, 'available');
    sameSiVolume(after.net, native.value * scale, 'source release cannot certify the raw value as cubic metres');
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
