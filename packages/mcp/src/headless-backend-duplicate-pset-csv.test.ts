/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An entity can legitimately carry two distinct IfcPropertySets sharing
 * the same name. `resolveColumn()` in headless-backend.ts's CSV export
 * used to do `props.find(p => p.name === setName)`, which only ever
 * sees the FIRST same-named set — a `Pset.Prop` column whose value
 * lives on the SECOND same-named set silently emitted an empty cell
 * instead of the value.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadIfcModel } from './loader.js';
import type { LoadedModel } from './context.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

// Wall #72 carries TWO "Pset_WallCommon" sets: the first (#80) has only
// IsExternal, the second (#83) has the FireRating column we export.
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41));
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#81= IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#80= IFCPROPERTYSET('${guid('PST1')}',$,'Pset_WallCommon',$,(#81));
#82= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#80);
#84= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#83= IFCPROPERTYSET('${guid('PST2')}',$,'Pset_WallCommon',$,(#84));
#85= IFCRELDEFINESBYPROPERTIES('${guid('RDP2')}',$,$,$,(#72),#83);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let model: LoadedModel;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-dup-pset-csv-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
  model = await loadIfcModel(join(tmp, 'm.ifc'), { modelId: 'm' });
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('headless-backend export.csv — two same-named property sets', () => {
  it('emits the value from the SECOND same-named set, not an empty cell', () => {
    const wall = model.bim.query().byType('IfcWall').toArray()[0];
    const csv = model.bim.export.csv([wall.ref], {
      columns: ['name', 'Pset_WallCommon.FireRating'],
    });

    const rows = csv.trim().split('\n');
    expect(rows[1]).toBe('Wall A,REI60');
  });
});
