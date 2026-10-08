/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { render, cleanup } from '@/test/render';
import { ZoneVolumeBreakdown } from '@/components/viewer/ZoneVolumeBreakdown';
import { allBasisBreakdowns, declaredVolumeBases } from '@/lib/zones';
import { captureEvidence } from '@/lib/assistant/evidence';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { QuantityType } from '@ifc-lite/data';
import { fixtureModel } from '@/test/store-fixture';
import { evidenceIsCurrent } from '@/lib/assistant/evidence';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { recomputeZoneAssignmentsNow } from '@/hooks/useZoneAssignmentSync';
import { computeZoneApportionmentForElement } from '@/hooks/useZoneApportionment';

afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.getState().clearAllModels(); });
test('#7220 native declared zone shares are available to selected evidence', async t => {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const bases = allBasisBreakdowns(f.apportionment, declaredVolumeBases(f.quantities, 1));
  assert.deepEqual(bases.map(row => row.basis), ['mesh', 'net', 'gross', 'unqualified']);
  assert.ok(Math.abs(bases.find(row => row.basis === 'net')!.totalM3 - 2.49624) < 1e-9, 'unmodified ArchiCAD authored NetVolume ground truth');
  for (const basis of bases) assert.ok(Math.abs(basis.shares.reduce((n, share) => n + share.valueM3, basis.outsideM3) - basis.totalM3) < 1e-8, 'native measured fractions conserve each separately declared magnitude');
  const ui = render(<ZoneVolumeBreakdown zoneSet={f.zoneSet} globalId={f.id} quantitySets={f.quantities} projectUnits={f.projectUnits} unitDisplayOverrides={{}} />);
  for (const basis of ['mesh', 'net', 'gross', 'unqualified']) assert.ok(ui.textContent?.includes(basis), 'the actual Properties card exposes each native basis');
  const payload = JSON.parse(captureEvidence('selection').payload);
  assert.equal(payload.evidence.rows[0].data.quantities[0].quantities.NetVolume.value, 2.49624, 'selected source already has the declared scalar quantity');
  assert.ok(payload.evidence.rows[0].data.zoneVolumeBreakdowns, 'selected source must also include the existing native per-zone basis breakdown');
  const captured = payload.evidence.rows[0].data.zoneVolumeBreakdowns;
  assert.equal(captured.zoneSets[0].status, 'cached');
  for (const [index, basis] of bases.entries()) {
    assert.equal(captured.volumeBases[index].totalM3, basis.totalM3);
    assert.deepEqual(captured.volumeBases[index].shares, basis.shares);
    assert.equal(captured.volumeBases[index].outsideM3, basis.outsideM3);
  }
  assert.match(captured.volumeBases[1].ratioNote, /applied to the declared total/);
  assert.equal(payload.projectionTruncated, false, 'the real two-zone basis shares survive the bounded evidence projection');
});
test('#7220 Zones evidence preserves native declared bases beside mesh', async t => {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const payload = JSON.parse(captureEvidence('zones').payload);
  assert.equal(payload.evidence.rows.length, 2, 'real native classified wall reaches two zones');
  assert.equal(payload.evidence.rows[0].data.Basis, 'mesh');
  assert.ok(payload.evidence.rows[0].data.VolumeBases?.some((row: { basis: string }) => row.basis === 'net'), 'Zones source must include the declared native basis shares');
  for (const basis of ['net', 'gross', 'unqualified']) {
    const rows = payload.evidence.rows.map((row: { data: { VolumeBases: Array<{ basis: string; VolumeM3: number; ElementVolumeM3: number }> } }) => row.data.VolumeBases.find(b => b.basis === basis)!);
    assert.ok(Math.abs(rows.reduce((n: number, row: { VolumeM3: number }) => n + row.VolumeM3, 0) - 2.49624) < 1e-8);
    assert.ok(rows.every((row: { ElementVolumeM3: number }) => Math.abs(row.ElementVolumeM3 - 2.49624) < 1e-8));
  }
  assert.equal(useViewerStore.getState().mutationViews.size, 0, 'capture never creates native mutation state');
});

test('#7220 live declared edits retain the cached mesh split and native occurrence precedence', async t => {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const cache = useViewerStore.getState().zoneApportionment;
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  const netSet = f.quantities.find(set => set.quantities.some(q => q.name === 'NetVolume')); assert.ok(netSet);
  view.setQuantity(f.id, netSet.name, 'NetVolume', 7, QuantityType.Volume);
  const native = allBasisBreakdowns(f.apportionment, declaredVolumeBases(view.getQuantitiesForEntity(f.id), 1));
  const captured = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.zoneVolumeBreakdowns.volumeBases;
  assert.equal(captured.find((row: { basis: string }) => row.basis === 'net').totalM3, 7);
  assert.deepEqual(captured.find((row: { basis: string }) => row.basis === 'net').shares, native.find(row => row.basis === 'net')!.shares);
  assert.equal(useViewerStore.getState().zoneApportionment, cache, 'read-only evidence retains the actual native split cache');
});

test('#7220 changed zone geometry refuses late selected splits and invalidates captured evidence', async t => {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const snapshot = captureEvidence('selection');
  const cache = useViewerStore.getState().zoneApportionment;
  useViewerStore.setState({ zoneSets: [{ ...f.zoneSet, zones: f.zoneSet.zones.map(zone => ({ ...zone, size: [zone.size[0] + 1, zone.size[1], zone.size[2]] as [number, number, number] })) }] });
  assert.equal(evidenceIsCurrent(snapshot), false);
  const split = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.zoneVolumeBreakdowns;
  assert.equal(split.zoneSets[0].status, 'split-not-computed'); assert.deepEqual(split.volumeBases, []);
  const rows = JSON.parse(captureEvidence('zones').payload).evidence.rows;
  assert.ok(rows.every((row: { data: { VolumeBases: Array<{ VolumeM3: number | null; Unavailable: string }> } }) => row.data.VolumeBases.every(basis => basis.VolumeM3 === null && /split not computed/.test(basis.Unavailable))));
  assert.equal(useViewerStore.getState().zoneApportionment, cache, 'capture does not repair stale splits');
});

test('#7220 federated selection retains model-local declared quantities and excludes another model cache', async t => {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', model], ['other', { ...fixtureModel('other', { idOffset: 1_000_000 }), ifcDataStore: f.store }]]),
    selectedEntity: { modelId: 'other', expressId: f.id } });
  const other = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.zoneVolumeBreakdowns;
  assert.equal(other.zoneSetCount, 0, 'same express ID in another model must not acquire the first model split');
  useViewerStore.setState({ selectedEntity: { modelId: 'arch', expressId: f.id } });
  assert.equal(JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.zoneVolumeBreakdowns.zoneSetCount, 1);
});

test('#7220 missing original source retains unverified quantity status rather than proving declared absence', async t => {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  const sourceFree = { ...f.store, source: EMPTY_SOURCE_BYTES };
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: sourceFree }]]), ifcDataStore: sourceFree });
  const split = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.zoneVolumeBreakdowns;
  assert.equal(split.quantityStatus, 'unverified-without-source');
  assert.equal(split.zoneSets[0].status, 'cached', 'existing native mesh evidence remains separate from declared-source availability');
  assert.equal(split.volumeBases[0].basis, 'mesh');
  const rows = JSON.parse(captureEvidence('zones').payload).evidence.rows;
  assert.ok(rows.every((row: { data: { DeclaredQuantityStatus: string } }) => row.data.DeclaredQuantityStatus === 'unverified-without-source'));
});

test('#7220 known native zone-set population precedes the selected display bound', async t => {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const sets = Array.from({ length: 17 }, (_, index) => ({ ...f.zoneSet, id: `native-${index}` }));
  useViewerStore.setState({ zoneSets: sets });
  recomputeZoneAssignmentsNow();
  for (const set of sets) assert.ok(computeZoneApportionmentForElement(set, f.id).apportionment);
  const payload = JSON.parse(captureEvidence('selection').payload);
  const split = payload.evidence.rows[0].data.zoneVolumeBreakdowns;
  assert.equal(split.zoneSetCount, 17);
  assert.equal(split.zoneSets.length, payload.evidence.summary.perElementBounds.zoneSets);
  assert.equal(split.zoneSets.length, 16);
});
