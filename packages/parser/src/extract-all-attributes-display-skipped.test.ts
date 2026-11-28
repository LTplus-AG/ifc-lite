/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10543: `extractAllEntityAttributes(store, id, { includeDisplaySkipped: true })`
 * keeps the attributes the display list (`SKIP_DISPLAY_ATTRS`) leaves out, for
 * the IDS attribute facet. Without the option the result is the one every
 * other caller has always had: the diff fingerprints hash it.
 */

import { describe, expect, it } from 'vitest';
import { extractAllEntityAttributes } from './columnar-parser.js';
import { SKIP_DISPLAY_ATTRS } from './columnar-parser-indexes.js';
import { IfcParser } from './index.js';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0PROJ00000000000000000',$,'Proj',$,$,$,$,$,$);
#4=IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);
#5=IFCLOCALPLACEMENT($,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,());
#10=IFCWALL('0WALL00000000000000010',#4,'W-1',$,'Type A',#5,#11,'T-1',.SOLIDWALL.);
#20=IFCWALL('0WALL00000000000000020',$,'W-2',$,$,$,$,$,$);
#31=IFCPROPERTYSET('0PSET00000000000000031',$,'Pset_A',$,());
#32=IFCWALLTYPE('0TYPE00000000000000032',$,'T',$,$,$,$,$,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;
`;

async function store() {
  return new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer, { disableWorkerScan: true });
}

describe('extractAllEntityAttributes: includeDisplaySkipped (#10543)', () => {
  it('keeps GlobalId, OwnerHistory, ObjectPlacement and Representation, in schema order', async () => {
    const s = await store();
    expect(extractAllEntityAttributes(s, 10, { includeDisplaySkipped: true })).toEqual([
      { name: 'GlobalId', value: '0WALL00000000000000010' },
      { name: 'OwnerHistory', value: 4 },
      { name: 'Name', value: 'W-1' },
      { name: 'ObjectType', value: 'Type A' },
      { name: 'ObjectPlacement', value: 5 },
      { name: 'Representation', value: 11 },
      { name: 'Tag', value: 'T-1' },
      { name: 'PredefinedType', value: 'SOLIDWALL' },
    ]);
    expect(extractAllEntityAttributes(s, 20, { includeDisplaySkipped: true })).toEqual([
      { name: 'GlobalId', value: '0WALL00000000000000020' },
      { name: 'Name', value: 'W-2' },
    ]);
  });

  it('control: without the option, with it false, null or not an object, the result is the display list as before', async () => {
    const s = await store();
    const display = [
      { name: 'Name', value: 'W-1' },
      { name: 'ObjectType', value: 'Type A' },
      { name: 'Tag', value: 'T-1' },
      { name: 'PredefinedType', value: 'SOLIDWALL' },
    ];
    expect(extractAllEntityAttributes(s, 10)).toEqual(display);
    expect(extractAllEntityAttributes(s, 10, {})).toEqual(display);
    expect(extractAllEntityAttributes(s, 10, { includeDisplaySkipped: false })).toEqual(display);
    // Before the option existed a JavaScript caller's third argument was
    // ignored: null and a value that is not an object still return.
    expect(extractAllEntityAttributes(s, 10, null)).toEqual(display);
    for (const notAnObject of [true, 1, 'includeDisplaySkipped']) {
      expect(extractAllEntityAttributes(s, 10, notAnObject as unknown as { includeDisplaySkipped?: boolean })).toEqual(display);
    }
  });

  it('control: with the option the result is the default one plus only the display-skipped names', async () => {
    const s = await store();
    for (const id of [1, 4, 5, 10, 11, 20, 31, 32]) {
      const all = extractAllEntityAttributes(s, id, { includeDisplaySkipped: true });
      expect(all.filter((a) => !SKIP_DISPLAY_ATTRS.has(a.name))).toEqual(extractAllEntityAttributes(s, id));
    }
  });
});
