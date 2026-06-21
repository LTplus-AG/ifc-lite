/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '../src/index.js';

/**
 * #1289: a storey whose `Elevation` attribute is null (common in Revit /
 * ArchiCAD exports) used to be dropped from `storeyElevations`, leaving Exploded
 * mode with a single floor to order. The builder now falls back to the storey's
 * ObjectPlacement Z, so every storey participates in the sort + lift.
 *
 * The fixture has two storeys: a ground floor that carries Elevation = 0, and a
 * first floor with a NULL Elevation but a placement at Z = 3.5.
 */

/** Pad to the 22-char width of an IFC GlobalId (format is not validated here,
 *  only the length / uniqueness matter for a clean parse). */
const gid = (seed: string): string => seed.padEnd(22, '0').slice(0, 22);

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('test.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCLOCALPLACEMENT(#3,#5);
#7=IFCCARTESIANPOINT((0.,0.,3.5));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#9=IFCLOCALPLACEMENT(#3,#8);
#10=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#11=IFCUNITASSIGNMENT((#10));
#12=IFCPROJECT('${gid('Project')}',$,'Test',$,$,$,$,$,#11);
#13=IFCSITE('${gid('Site')}',$,'Site',$,$,#3,$,$,.ELEMENT.,$,$,$,$,$);
#14=IFCBUILDING('${gid('Building')}',$,'Building',$,$,#3,$,$,.ELEMENT.,$,$,$);
#15=IFCBUILDINGSTOREY('${gid('StoreyGF')}',$,'Ground Floor',$,$,#6,$,$,.ELEMENT.,0.);
#16=IFCBUILDINGSTOREY('${gid('StoreyF1')}',$,'First Floor',$,$,#9,$,$,$,$);
#17=IFCRELAGGREGATES('${gid('RelP2S')}',$,$,$,#12,(#13));
#18=IFCRELAGGREGATES('${gid('RelS2B')}',$,$,$,#13,(#14));
#19=IFCRELAGGREGATES('${gid('RelB2St')}',$,$,$,#14,(#15,#16));
ENDSEC;
END-ISO-10303-21;
`;

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

describe('storey elevation placement fallback (#1289)', () => {
  it('derives a missing storey Elevation from its ObjectPlacement Z', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(toArrayBuffer(IFC), { disableWorkerScan: true });

    const elevations = store.spatialHierarchy?.storeyElevations;
    expect(elevations, 'spatial hierarchy built').toBeDefined();

    // Both storeys present: the attribute one (0) AND the placement-fallback one (3.5).
    expect(elevations!.size).toBe(2);
    const values = [...elevations!.values()].sort((a, b) => a - b);
    expect(values[0]).toBeCloseTo(0, 6);
    expect(values[1]).toBeCloseTo(3.5, 6);
  });
});
