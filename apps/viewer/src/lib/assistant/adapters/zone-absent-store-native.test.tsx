/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { IfcParser, extractProjectUnits, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureEvidence } from '@/lib/assistant/evidence';
import { currentProjectUnitContext } from '@/lib/units/current-project-unit-context';
import { cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';
const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
interface Basis { basis: string; totalM3?: number; ElementVolumeM3?: number }
interface Row { zoneVolumeBreakdowns?: { unitStatus: string; unitReason: string | null; volumeBases: Basis[] };
  DeclaredUnitStatus?: string; DeclaredUnitReason?: string | null; VolumeBases?: Basis[]; ElementVolumeM3?: number }
function rows(source: 'selection' | 'zones') {
  const result = JSON.parse(captureEvidence(source).payload) as { evidence: { rows: Array<{ data: Row }> } };
  assert.ok(result.evidence.rows.length, 'public native wall/assignment evidence remains present');
  return result.evidence.rows.map(row => row.data);
}
for (const source of ['selection', 'zones'] as const) {
  test(`#7220 ${source} absent native model store cannot certify implicit quantities as physical SI`, async t => {
    const f = await seedDeclaredZoneWall(t); if (!f) return;
    const netSet = f.quantities.find(set => set.quantities.some(q => q.name === 'NetVolume'));
    assert.ok(netSet, 'real FZK wall supplies native occurrence NetVolume');
    const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
    view.setQuantity(f.id, netSet.name, 'NetVolume', 7, QuantityType.Volume);
    const bytes = editedModelBytes(f.store, view);
    const exported = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
    const oracle = extractQuantitiesOnDemand(exported, f.id).flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
    assert.ok(oracle); assert.equal(oracle.value, 7); assert.equal(oracle.explicitUnitSiScale, undefined);
    assert.ok(extractProjectUnits(exported.source, exported.entityIndex).resolvedForUnitType('VOLUMEUNIT'));
    const available = currentProjectUnitContext(f.store, view);
    assert.equal(available.status, 'available'); assert.ok(available.value);
    const baseline = rows(source);
    assert.ok(baseline.some(row => (row.zoneVolumeBreakdowns?.volumeBases ?? row.VolumeBases ?? []).some(b => b.basis === 'net')),
      'source-backed public native quantity has a physical basis before store removal');
    const state = useViewerStore.getState(); const model = state.models.get('arch'); assert.ok(model);
    const geometry = model.geometryResult; assert.ok(geometry && geometry.meshes.length);
    const cache = state.zoneApportionment; const assignments = state.zoneAssignments;
    const revision = view.getMutationRevision(); const changes = view.getEffectiveChanges().length;
    const sourceHash = createHash('sha256').update(f.store.source.materialize()).digest('hex');
    const undo = state.undoStacks; const redo = state.redoStacks;
    useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: null }]]), ifcDataStore: null });
    const absent = rows(source);
    for (const row of absent) {
      const status = row.zoneVolumeBreakdowns?.unitStatus ?? row.DeclaredUnitStatus;
      const reason = row.zoneVolumeBreakdowns?.unitReason ?? row.DeclaredUnitReason;
      assert.equal(status, 'unavailable', 'missing store is unknown, never undeclared default SI');
      assert.ok(typeof reason === 'string' && reason.length > 0);
      assert.ok(!(row.zoneVolumeBreakdowns?.volumeBases ?? row.VolumeBases ?? []).some(b => b.basis === 'net' || b.basis === 'gross' || b.basis === 'unqualified'),
        'implicit raw quantity remains withheld from physical declared volume bases');
    }
    assert.equal(useViewerStore.getState().models.get('arch')?.geometryResult, geometry);
    assert.equal(useViewerStore.getState().zoneApportionment, cache);
    assert.equal(useViewerStore.getState().zoneAssignments, assignments);
    assert.equal(view.getMutationRevision(), revision); assert.equal(view.getEffectiveChanges().length, changes);
    assert.equal(useViewerStore.getState().undoStacks, undo); assert.equal(useViewerStore.getState().redoStacks, redo);
    assert.equal(createHash('sha256').update(f.store.source.materialize()).digest('hex'), sourceHash);
  });
}
