/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's JSON data export writes the model as edited (#5249): a deleted
 * entity is not exported, a created one is, a retyped one reports its new
 * class, and a queued Name edit and pset edit are what the file says. Real
 * parsed store, and a real `MutablePropertyView` wired as the viewer wires it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { configureMutationView } from '@/utils/configureMutationView';
import { buildCommandPaletteJsonEntities } from './commandPaletteJsonExport.js';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0Wall00000000000000001',$,'Wall A',$,$,$,$,$,$);
#2=IFCWALL('0Wall00000000000000002',$,'Wall B',$,$,$,$,$,$);
#3=IFCWALL('0Wall00000000000000003',$,'Wall C',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function session() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(FIXTURE).buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties ?? null, 'm');
  configureMutationView(view, store);
  view.setExpressIdWatermark(3);
  return { store, view };
}

describe('JSON export writes the edited model (#5249)', () => {
  it('control: with no view, every parsed row is exported as parsed', async () => {
    const { store } = await session();
    const rows = buildCommandPaletteJsonEntities(store);
    assert.deepEqual(rows.map((r) => [r.expressId, r.name, r.type]), [[1, 'Wall A', 'IfcWall'], [2, 'Wall B', 'IfcWall'], [3, 'Wall C', 'IfcWall']]);
  });

  it('deleted out, created in, retype, Name edit and pset edit applied', async () => {
    const { store, view } = await session();
    view.deleteEntity(2);
    view.setEntityType(3, 'IfcColumn', null, 'IfcWall');
    view.setAttribute(1, 'Name', 'Wall A renamed', 'Wall A');
    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'EI60', PropertyValueType.String);
    const created = view.createEntity('IfcSlab', ['2Slab00000000000000004', null, 'Slab D']).expressId;

    const rows = buildCommandPaletteJsonEntities(store, view);
    assert.deepEqual(rows.map((r) => [r.expressId, r.globalId, r.name, r.type]), [
      [1, '0Wall00000000000000001', 'Wall A renamed', 'IfcWall'],
      [3, '0Wall00000000000000003', 'Wall C', 'IfcColumn'],
      [created, '2Slab00000000000000004', 'Slab D', 'IfcSlab'],
    ]);
    const psets = rows[0].properties as Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>;
    assert.equal(psets.find((p) => p.name === 'Pset_WallCommon')?.properties.find((p) => p.name === 'FireRating')?.value, 'EI60');
  });
});
