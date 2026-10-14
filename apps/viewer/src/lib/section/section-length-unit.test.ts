/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { METRES, projectLengthUnit, sceneLengthUnit } from './section-length-unit.js';

/** A tiny but real IFC file whose project declares `unit` as its length unit. */
function stepWith(unit: string): ArrayBuffer {
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('u.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));
#3=${unit};
ENDSEC;
END-ISO-10303-21;
`;
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function store(unit: string) {
  return new IfcParser().parseColumnar(stepWith(unit), { disableWorkerScan: true });
}

describe('the length unit the Section bar speaks (#7545)', () => {
  it('reads millimetres from the project, and metres', async () => {
    const mm = projectLengthUnit(await store('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'));
    assert.equal(mm.symbol, 'mm');
    assert.ok(Math.abs(mm.scale - 0.001) < 1e-12);
    const m = projectLengthUnit(await store('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'));
    assert.deepEqual(m, { scale: 1, symbol: 'm' });
  });

  it('falls back to metres without a store, and caches per store', async () => {
    assert.deepEqual(projectLengthUnit(null), METRES);
    const s = await store('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
    assert.equal(projectLengthUnit(s), projectLengthUnit(s));
  });

  it('takes the first visible model that has a store', async () => {
    const mm = await store('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
    assert.equal(sceneLengthUnit([{ visible: false, ifcDataStore: mm }, { ifcDataStore: null }]).symbol, 'm');
    assert.equal(sceneLengthUnit([{ visible: false, ifcDataStore: null }, { visible: true, ifcDataStore: mm }]).symbol, 'mm');
    assert.equal(sceneLengthUnit([]).symbol, 'm');
  });
});
