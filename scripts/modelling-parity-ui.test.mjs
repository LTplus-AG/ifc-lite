/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROBES } from '../tests/modelling-parity/ui/probes.mjs';
import { readStep } from '../tests/modelling-parity/ui/lib/step.mjs';
import { wallSize, layerThicknesses, scheduleLengths } from '../tests/modelling-parity/ui/probes-u4.mjs';
import { EXERCISES } from '../tests/modelling-parity/ui/exercises.mjs';

test('#9296 F2 room volumes stop below the next storey occupancy band', async () => {
  let height = 3, field;
  const firstPick = new Error('first room pick');
  const session = {
    page: { getByLabel: (label) => ({ label }) },
    state: async () => ({ command: 'room.place' }),
    ui: {
      click: async (locator) => { field = locator.label; },
      key: async () => {},
      type: async (value) => { if (field === 'Height in metres') height = Number(value); },
      clickWorld: async () => {
        // Ground-floor rooms taller than 2.7m occupy the loft height band,
        // so the loft Pick would be refused even with a perfectly closed loop.
        assert.ok(height > 0 && height <= 2.7, `room height ${height} crosses the next floor`);
        throw firstPick;
      },
    },
  };
  const step = EXERCISES.F2.steps.find((s) => s.name.startsWith('EG spaces:'));
  await assert.rejects(() => step.run(session), (error) => error === firstPick);
});

// #9296 U4: a table-stakes UI level cannot pass if its probe never exists.
test('every table-stakes capability has a real UI probe', () => {
  const catalogue = JSON.parse(readFileSync(new URL('../tests/modelling-parity/catalogue.json', import.meta.url)));
  const covered = new Set(PROBES.map((p) => p.capability));
  assert.deepEqual(catalogue.capabilities.filter((c) => c.tableStakes && c.probes.ui.applicable !== false && !covered.has(c.id)).map((c) => c.id), []);
  assert.equal(new Set(PROBES.map((p) => p.id)).size, PROBES.length);
});

// Invariant: dimensions are read from the exported solid, not a typed HUD value.
test('wall size and ordered layer oracle distinguish the changed geometry', () => {
  const model = (height, thickness) => readStep(`ISO-10303-21;
HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCWALL('guid',$,'Wall',$,$,$,#2,$,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#4));
#4=IFCEXTRUDEDAREASOLID(#5,$,$,${height});
#5=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,5.,${thickness});
#6=IFCMATERIALLAYERSET((#7,#8,#9),'Compound',$);
#7=IFCMATERIALLAYER($,0.115,$,$,$,$,$);
#8=IFCMATERIALLAYER($,0.1,$,$,$,$,$);
#9=IFCMATERIALLAYER($,0.015,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`);
  for (const [h,t] of [[3,.2],[3.4,.23]]) {
    const step = model(h,t);
    assert.deepEqual(wallSize(step,step.of('IFCWALL')[0]),{height:h,thickness:t});
    assert.deepEqual(layerThicknesses(step),[[.115,.1,.015]]);
  }
});

test('#9296 schedule oracle reads Length, not a 5 in a name or another quantity', () => {
  assert.deepEqual(scheduleLengths('Name,Length,Height\r\n"Wall, south",5,3\r\nWall north,5,3'), [5,5]);
  assert.deepEqual(scheduleLengths('Name,Length,Height\nWall 5,2,5\nWall 5,3,5'), [2,3]);
  assert.deepEqual(scheduleLengths('Name,Height\nWall 5,5'), []);
});
