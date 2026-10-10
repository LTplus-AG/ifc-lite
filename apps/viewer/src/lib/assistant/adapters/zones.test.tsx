/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { render, click, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels, type FixtureEntity } from '@/test/store-fixture';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore, type FederatedModel } from '@/store';
import { zoneSetRevision, type ZoneAssignment, type ZoneSet } from '@/lib/zones';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { useAssistant, cancelAssistant } from '../conversation';

const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
afterEach(() => { cleanup(); cancelAssistant(); useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });

const SET: ZoneSet = { id: 'set-1', name: 'Takts', visible: true, createdAt: 1, updatedAt: 1, zones: [
  { id: 'z1', name: 'Takt A', center: [0, 0, 0], size: [10, 3, 10], rotationY: 0 },
  { id: 'z2', name: 'Takt B', center: [10, 0, 0], size: [10, 3, 10], rotationY: 0 },
] };

async function model(id: string, idOffset: number, entities: FixtureEntity[], volumes: Array<[number, number]>): Promise<FederatedModel> {
  // #7220: the adapter now reads native authored quantities as well as mesh
  // facts. Parse actual records rather than expanding the render-only stub.
  const records = entities.map(entity => `#${entity.expressId}=${entity.type.toUpperCase()}('${entity.globalId}',$,'${entity.name}',$,$,$,$,$,$);`);
  const text = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('zones.ifc','2026-10-08',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1000=IFCPROJECT('000000000000000000000p',$,'Zones',$,$,$,$,$,$);\n${records.join('\n')}\nENDSEC;\nEND-ISO-10303-21;`;
  const ifcDataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  return { ...fixtureModel(id, { idOffset, entities }), ifcDataStore, maxExpressId: 1000,
    geometryResult: { meshes: volumes.map(([expressId, geometryVolume]) => ({ expressId, geometryVolume })) },
  } as unknown as FederatedModel;
}

const inA: ZoneAssignment = { zoneId: 'z1', zoneName: 'Takt A', straddles: false, touchedZoneIds: ['z1'] };
const straddler: ZoneAssignment = { zoneId: 'z1', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z1', 'z2'] };

/** 150 walls in model A wholly in Takt A, one slab of model B (offset 2000) straddling both takts. */
async function seed() {
  const walls = Array.from({ length: 150 }, (_, i) => ({ expressId: i + 1, type: 'IfcWall', name: `Wall ${i + 1}`, globalId: `wall-${i + 1}` }));
  const assignments = new Map<number, Record<string, ZoneAssignment>>([[2005, { [SET.id]: straddler }]]);
  for (const wall of walls) assignments.set(wall.expressId, { [SET.id]: inA });
  useViewerStore.setState({
    ...fixtureModels(
      await model('A', 0, walls, walls.map(w => [w.expressId, 2])),
      await model('B', 2000, [{ expressId: 5, type: 'IfcSlab', name: 'Slab', globalId: 'slab-5' }], [[2005, 8]]),
    ),
    zoneSets: [SET], zoneAssignments: assignments, zoneApportionment: new Map(),
    zoneAssignmentTiming: { elapsedMs: 1, elementCount: 151, zoneSetCount: 1, computedAt: 1_700_000_000_000 },
  });
}

const dataRows = (payload: { evidence: { rows: Array<{ data: Record<string, unknown> }> } }) => payload.evidence.rows.map(row => row.data);

// #6833: the zone table rows, native pair totals and federated identities, without running the split.
test('zones evidence carries zone-table rows with exact pair totals across federated models', async () => {
  await seed();
  const snapshot = captureEvidence('zones');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, 152, '150 single-zone walls + one slab reaching two zones');
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
  const summary = payload.evidence.summary;
  assert.equal(summary.assignedCount, 151);
  assert.equal(summary.zoneCount, 2);
  assert.equal(summary.refusedCount, null, 'no split has run, so refusals are unknown, not zero');
  assert.equal(summary.zoneSets[0].straddlerCount, 1);
  assert.equal(summary.zoneSets[0].apportionmentComputed, false);
  assert.equal(summary.units.VolumeM3, 'm3');

  const rows = dataRows(payload);
  const slab = rows.filter(row => row.modelId === 'B');
  assert.deepEqual(slab.map(row => row.Zone), ['Takt A', 'Takt B']);
  for (const row of slab) {
    assert.equal(row.expressId, 5);
    assert.equal(row.globalId, 'slab-5');
    assert.equal(row.VolumeM3, null);
    assert.equal(row.status, 'unmeasured');
    assert.match(String(row.Unavailable), /split not computed/);
  }
  const wall = rows.find(row => row.globalId === 'wall-1');
  assert.ok(wall);
  assert.equal(wall.modelId, 'A');
  assert.equal(wall.Zone, 'Takt A');
  assert.equal(wall.VolumeM3, 2);
  assert.equal(wall.Fraction, 1);
  assert.equal(wall.unit, 'm3');
  assert.equal(wall.Name, 'Wall 1');
  assert.equal(evidenceIsCurrent(snapshot), true);
});

test('a computed split replaces "not computed" with native refusals and makes older evidence stale', async () => {
  await seed();
  const before = captureEvidence('zones');
  useViewerStore.getState().setZoneApportionment(SET.id, { revision: zoneSetRevision(SET), byElement: new Map(),
    refused: new Map([[2005, 'unproved-solid']]), computedAt: 2, elapsedMs: 1 });
  assert.equal(evidenceIsCurrent(before), false, 'the apportionment cache was replaced');
  const payload = JSON.parse(captureEvidence('zones').payload);
  assert.equal(payload.evidence.summary.refusedCount, 1);
  assert.deepEqual(payload.evidence.summary.zoneSets[0].refusedByReason, { noGeometry: 0, unprovedSolid: 1, rescaledByAlignment: 0 });
  const slab = dataRows(payload).filter(row => row.modelId === 'B');
  assert.ok(slab.every(row => row.Unavailable === 'the mesh is not a proven closed solid'));
});

test('moving a zone or editing the model makes zone evidence stale', async () => {
  await seed();
  const snapshot = captureEvidence('zones');
  useViewerStore.getState().updateZone(SET.id, 'z2', { center: [20, 0, 0] });
  assert.equal(evidenceIsCurrent(snapshot), false);
  const again = captureEvidence('zones');
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(again), false);
});

test('zones are unavailable without sets or assignment, and available-empty when nothing is assigned', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('A')), zoneSets: [], zoneAssignmentTiming: null });
  assert.equal(JSON.parse(captureEvidence('zones').payload).sourceAvailability, 'unavailable');
  useViewerStore.setState({ zoneSets: [SET], zoneAssignments: new Map(), zoneAssignmentTiming: null });
  assert.equal(JSON.parse(captureEvidence('zones').payload).sourceAvailability, 'unavailable', 'sets exist but nothing was classified');
  useViewerStore.setState({ zoneAssignmentTiming: { elapsedMs: 1, elementCount: 0, zoneSetCount: 1, computedAt: 1 } });
  const snapshot = captureEvidence('zones');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, 0);
  assert.equal(payload.evidence.summary.assignedCount, 0);
});

test('the Zones panel header discusses the zones source', async () => {
  await seed();
  const ui = render(renderPanelBody('zones', () => undefined));
  const button = ui.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button);
  click(button);
  assert.equal(useAssistant.getState().snapshot?.source, 'zones');
});
