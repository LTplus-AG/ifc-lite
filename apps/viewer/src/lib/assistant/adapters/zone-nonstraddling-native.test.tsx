/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { recomputeZoneAssignmentsNow } from '@/hooks/useZoneAssignmentSync';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });

for (const staleCache of [false, true]) {
  test(`#7220 native whole-home selection matches Zones without a split (${staleCache ? 'stale' : 'empty'} cache)`, async t => {
    const f = await seedDeclaredZoneWall(t); if (!f) return;
    const initial = useViewerStore.getState();
    const bounds = initial.geometryResult?.coordinateInfo?.originalBounds; assert.ok(bounds);
    const whole = { ...f.zoneSet, updatedAt: f.zoneSet.updatedAt + 1, zones: [{ ...f.zoneSet.zones[0],
      center: [(bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2, (bounds.min.z + bounds.max.z) / 2] as [number, number, number],
      size: [bounds.max.x - bounds.min.x + 2, bounds.max.y - bounds.min.y + 2, bounds.max.z - bounds.min.z + 2] as [number, number, number] }] };
    useViewerStore.setState({ zoneSets: [whole], zoneApportionment: staleCache ? initial.zoneApportionment : new Map() });
    recomputeZoneAssignmentsNow();
    const state = useViewerStore.getState();
    const assignment = state.zoneAssignments.get(f.id)?.[whole.id]; assert.ok(assignment);
    assert.equal(assignment.straddles, false);
    assert.equal(assignment.zoneId, whole.zones[0].id);
    assert.deepEqual(assignment.touchedZoneIds, [whole.zones[0].id]);
    const nativeNet = f.quantities.flatMap(set => set.quantities).find(q => q.name === 'NetVolume'); assert.ok(nativeNet);
    assert.ok(Math.abs(nativeNet.value - 2.49624) < 1e-8, 'fixture native declaration precedes public capture');
    const cache = state.zoneApportionment;
    const views = state.mutationViews;
    const source = f.store.source;
    const selection = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.zoneVolumeBreakdowns;
    assert.ok(selection);
    assert.ok(selection.zoneSets[0], 'public selected evidence must represent the native whole-home assignment');
    assert.equal(selection.zoneSets[0].status, 'whole-element');
    const net = selection.volumeBases.find((basis: { basis: string }) => basis.basis === 'net'); assert.ok(net);
    assert.ok(Math.abs(net.totalM3 - nativeNet.value) < 1e-8);
    assert.equal(net.shares.length, 1);
    assert.equal(net.shares[0].zoneId, assignment.zoneId);
    assert.equal(net.outsideM3, 0);
    const zones = JSON.parse(captureEvidence('zones').payload).evidence.rows;
    const nativeRow = zones.find((row: { data: { ExpressId: number } }) => row.data.ExpressId === f.id); assert.ok(nativeRow);
    const zoneNet = nativeRow.data.VolumeBases.find((basis: { basis: string }) => basis.basis === 'net'); assert.ok(zoneNet);
    assert.ok(Math.abs(zoneNet.VolumeM3 - net.shares[0].valueM3) < 1e-8);
    assert.equal(useViewerStore.getState().zoneApportionment, cache);
    assert.equal(useViewerStore.getState().mutationViews, views);
    assert.equal(f.store.source, source);
    const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
    useViewerStore.setState({ models: new Map([['arch', model], ['other', { ...fixtureModel('other', { idOffset: 1_000_000 }), ifcDataStore: f.store }]]),
      selectedEntity: { modelId: 'other', expressId: f.id } });
    const peer = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.zoneVolumeBreakdowns;
    assert.equal(peer.zoneSetCount, 0, 'unassigned native peer never acquires another model whole-home assignment');
    useViewerStore.setState({ selectedEntity: { modelId: 'arch', expressId: f.id } });
    assert.equal(JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.zoneVolumeBreakdowns.zoneSetCount, 1, 'assigned native owner retains coverage with N loaded models');
  });
}

test('#7220 native wall reaching no zone retains explicit empty selected coverage', async t => {
  const f = await seedDeclaredZoneWall(t); if (!f) return;
  const remote = { ...f.zoneSet, updatedAt: f.zoneSet.updatedAt + 1,
    zones: f.zoneSet.zones.map(zone => ({ ...zone, center: [zone.center[0] + 100000, zone.center[1], zone.center[2]] as [number, number, number] })) };
  useViewerStore.setState({ zoneSets: [remote] });
  recomputeZoneAssignmentsNow();
  assert.equal(useViewerStore.getState().zoneAssignments.get(f.id)?.[remote.id]?.touchedZoneIds.length ?? 0, 0);
  const captured = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data.zoneVolumeBreakdowns;
  assert.deepEqual(captured, { zoneSetCount: 0, zoneSets: [], volumeBases: [] });
  assert.equal(JSON.parse(captureEvidence('zones').payload).evidence.rows.length, 0);
});
