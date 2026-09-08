/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The zone table against a real model (#2508 item 3).
 *
 * `lib/zones/table.test.ts` pins the SHAPE from hand-written facts. What only
 * this file can check is that the facts arriving from the store are the same
 * ones the pset write-back writes: the whole point of the table is that a
 * planner can reconcile the spreadsheet against the model, and two producers of
 * a per-zone volume is exactly how that stops being true.
 *
 * The fixture declares CUBIC MILLIMETRES, because a table that reports native
 * units where it promises SI is wrong by 1e9 while looking entirely plausible.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import { buildZoneTable, exportZoneTable } from './useZoneTableExport.js';
import { applyZoneWriteBack } from './useZoneWriteBack.js';
import { zoneQuantitySetName, type ZoneApportionmentEntry, type ZoneSet } from '@/lib/zones';

const WALL_ID = 42;
const BEAM_ID = 43;

/** `#42` declares a NetVolume of 2e9 mm3 (2 m3) and straddles; `#43` is wholly
 *  in Takt A and declares nothing. */
const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('zones','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#5),#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.VOLUMEUNIT.,.MILLI.,.CUBIC_METRE.);
#6=IFCUNITASSIGNMENT((#2,#3));
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$);
#${WALL_ID}=IFCWALL('0Wall00000000000000042',$,'Wall, A',$,$,$,$,$,$);
#${BEAM_ID}=IFCBEAM('0Beam00000000000000043',$,'Beam B',$,$,$,$,$,$);
#50=IFCQUANTITYVOLUME('NetVolume',$,$,2.E+09,$);
#51=IFCELEMENTQUANTITY('0Qto000000000000000051',$,'Qto_WallBaseQuantities',$,$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000052',$,$,$,(#${WALL_ID}),#51);
ENDSEC;
END-ISO-10303-21;
`;

const ZONE_SET: ZoneSet = {
  id: 'set-1',
  name: 'Takt areas',
  zones: [
    { id: 'z-a', name: 'Takt A', center: [0, 0, 0], size: [10, 10, 10], rotationY: 0 },
    { id: 'z-b', name: 'Takt B', center: [10, 0, 0], size: [10, 10, 10], rotationY: 0 },
  ],
  visible: true,
  createdAt: 0,
  updatedAt: 0,
};

function seedApportionment(revision: string): Map<string, ZoneApportionmentEntry> {
  return new Map([['set-1', {
    revision,
    byElement: new Map([[WALL_ID, {
      wholeVolumeM3: 5,
      shares: [
        { zoneId: 'z-a', zoneName: 'Takt A', volumeM3: 2, fraction: 0.4 },
        { zoneId: 'z-b', zoneName: 'Takt B', volumeM3: 3, fraction: 0.6 },
      ],
      outsideVolumeM3: 0,
      outsideFraction: 0,
      overlapping: false,
      unreliable: false,
    }]]),
    refused: new Map(),
    computedAt: 0,
    elapsedMs: 1,
  }]]);
}

async function seed(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const { zoneSetRevision } = await import('@/lib/zones');
  useViewerStore.setState({
    models: new Map([['m1', { id: 'm1', name: 'zones.ifc', ifcDataStore: store, visible: true } as never]]),
    zoneSets: [ZONE_SET],
    zoneAssignments: new Map([
      [WALL_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a', 'z-b'] } }],
      [BEAM_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: false, touchedZoneIds: ['z-a'] } }],
    ]) as never,
    zoneApportionment: seedApportionment(zoneSetRevision(ZONE_SET)),
    mutationViews: new Map(),
    dirtyModels: new Set(),
  } as never);
  return store;
}

describe('the zone table against a real store', () => {
  beforeEach(async () => { await seed(); });

  it('names each element from the model rather than from its id', () => {
    const rows = buildZoneTable(ZONE_SET, 'net');
    const wall = rows.find((r) => r.ExpressId === WALL_ID);
    assert.equal(wall?.GlobalId, '0Wall00000000000000042');
    // PascalCase, as `getTypeName` gives it: this column is filtered on in a
    // spreadsheet, and 'IfcWall' is what every other surface in the app shows.
    assert.equal(wall?.IfcType, 'IfcWall');
    assert.equal(wall?.Name, 'Wall, A');
    assert.equal(wall?.Model, 'zones.ifc');
  });

  it('reports SI cubic metres, whatever the model declares', () => {
    // The file's VOLUMEUNIT is CUBIC MILLIMETRE and its NetVolume is 2e9. A
    // table that reported the native number would say 2,000,000,000.
    const rows = buildZoneTable(ZONE_SET, 'net');
    const wall = rows.filter((r) => r.ExpressId === WALL_ID);
    assert.equal(wall.reduce((sum, r) => sum + (r.VolumeM3 ?? 0), 0), 2);
    assert.deepEqual(wall.map((r) => r.VolumeM3), [0.8, 1.2]);
  });

  it('agrees with what the write-back puts in the model, to the last digit', () => {
    // The reconciliation the whole table exists for. `applyZoneWriteBack`
    // writes the model's NATIVE unit; the table writes SI; both come from the
    // same resolved facts, so the ratio is exactly the declared unit scale.
    const rows = buildZoneTable(ZONE_SET, 'net');
    applyZoneWriteBack(ZONE_SET, 'net');
    const qsets = useViewerStore.getState().getMutationView('m1')?.getQuantitiesForEntity(WALL_ID) ?? [];
    const qset = qsets.find((q) => q.name === zoneQuantitySetName('Takt areas', 'net'));
    assert.ok(qset, 'the write-back wrote no quantity set');

    for (const row of rows.filter((r) => r.ExpressId === WALL_ID)) {
      const written: { name: string; value: unknown } | undefined = qset.quantities
        .find((q) => q.name === row.Zone);
      assert.ok(written, `no written quantity for ${row.Zone}`);
      // 1e9 mm3 per m3.
      assert.equal(Number(written.value), (row.VolumeM3 as number) * 1e9);
    }
  });

  it('states a reason rather than dropping an element it cannot measure', () => {
    // The beam declares no NetVolume, so on the `net` basis it has no number -
    // and it is still in Takt A, which the table must say.
    const beam = buildZoneTable(ZONE_SET, 'net').filter((r) => r.ExpressId === BEAM_ID);
    assert.equal(beam.length, 1);
    assert.equal(beam[0].Zone, 'Takt A');
    assert.equal(beam[0].VolumeM3, null);
    assert.match(beam[0].Unavailable, /declares no quantity/);
  });

  it('downloads a CSV whose header and row count match what it reports', async () => {
    const emitted: Array<{ bytes: Uint8Array; filename: string; mime: string }> = [];
    const result = await exportZoneTable(ZONE_SET, 'net', 'csv', (bytes, filename, mime) =>
      emitted.push({ bytes, filename, mime }));

    assert.equal(result.blocked, null);
    assert.equal(result.rows, 3, 'two zones for the straddler, one for the beam');
    assert.equal(result.elements, 2);
    assert.equal(result.unmeasured, 1);
    assert.equal(emitted[0].filename, 'Takt areas-zone-quantities.csv');
    assert.equal(emitted[0].mime, 'text/csv');

    const text = new TextDecoder().decode(emitted[0].bytes);
    assert.equal(text.trim().split('\n').length, result.rows + 1, 'header plus one line per row');
    assert.equal(emitted[0].bytes.byteLength, result.bytes);
    // The name with a comma is quoted, so the row still parses into columns.
    assert.match(text, /"Wall, A"/);
  });

  it('refuses to download an empty table', async () => {
    useViewerStore.setState({ zoneAssignments: new Map() } as never);
    const emitted: string[] = [];
    const result = await exportZoneTable(ZONE_SET, 'net', 'csv', (_b, filename) => emitted.push(filename));
    assert.equal(result.blocked, 'no-members');
    assert.deepEqual(emitted, [], 'an empty zone set must not download a header-only file');
  });
});
