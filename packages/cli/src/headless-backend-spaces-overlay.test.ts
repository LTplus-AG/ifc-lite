/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.spaces` on a headless session answers for the edited model (#5249):
 * a storey deleted through `bim.store.removeEntity` is no longer listed, and
 * `generate` reads the same session overlay.
 */

import { describe, expect, it } from 'vitest';
import { loadIfcBytes } from './loader.js';
import { HeadlessBackend } from './headless-backend.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

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
#41= IFCBUILDINGSTOREY('${guid('STOA')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#47= IFCBUILDINGSTOREY('${guid('STOB')}',$,'L02',$,$,#40,$,$,.ELEMENT.,3.);
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41,#47));
ENDSEC;
END-ISO-10303-21;
`;

describe('HeadlessBackend spaces over the edited model (#5249)', () => {
  it('a storey deleted this session is no longer listed', async () => {
    const backend = new HeadlessBackend(await loadIfcBytes(new TextEncoder().encode(MODEL), 'm.ifc'), 'm.ifc');
    expect(backend.spaces.listStoreys().map((s) => s.name)).toEqual(['L01', 'L02']);

    const [storey] = backend.query.entities({ types: ['IfcBuildingStorey'] }).filter((e) => e.name === 'L02');
    backend.store.removeEntity(storey.ref);

    expect(backend.spaces.listStoreys().map((s) => s.name)).toEqual(['L01']);
    // generate walks the same effective storey list: the deleted one is not attempted.
    const result = backend.spaces.generate({ dryRun: true });
    expect(result.storeys.map((s) => s.id)).toEqual([41]);
  });
});
