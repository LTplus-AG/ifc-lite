/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { expandAffectedSet } from './affected-set.js';

const fixture = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCROOF('0000000000000000000010',$,'Roof',$,$,$,$,$,.HIP_ROOF.);
#11=IFCSLAB('0000000000000000000011',$,'Plane 1',$,$,$,$,$,.ROOF.);
#12=IFCSLAB('0000000000000000000012',$,'Plane 2',$,$,$,$,$,.ROOF.);
#13=IFCSLAB('0000000000000000000013',$,'Other plane',$,$,$,$,$,.ROOF.);
#20=IFCROOF('0000000000000000000020',$,'Other roof',$,$,$,$,$,.HIP_ROOF.);
#30=IFCRELAGGREGATES('0000000000000000000030',$,$,$,#10,(#11,#12));
#31=IFCRELAGGREGATES('0000000000000000000031',$,$,$,#20,(#13));
ENDSEC;
END-ISO-10303-21;`;
const parse = () => new IfcParser().parseColumnar(new TextEncoder().encode(fixture).buffer as ArrayBuffer, { disableWorkerScan: true });
const ids = (set: Set<number>) => [...set].sort((a,b) => a-b);

it.each(['created', 'shape', 'hostsChanged'] as const)('reopened roof remesh includes its slab parts with no view: %s (#9357)', async cause => {
  expect(ids(expandAffectedSet(await parse(), null, [10], cause))).toEqual([10,11,12]);
});

it('roof remesh reads effective aggregate membership and excludes deleted slabs (#9357)', async () => {
  const store = await parse(), view = new MutablePropertyView(null, 'roof');
  const editor = new StoreEditor(store, view);
  editor.setPositionalAttribute(30, 5, ['#12','#13']);
  editor.removeEntity(12);
  expect(ids(expandAffectedSet(store, view, [10], 'shape'))).toEqual([10,13]);
});
