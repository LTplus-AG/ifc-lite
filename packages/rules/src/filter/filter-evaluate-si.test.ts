/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `valueUnit: 'si'` in search / applicability (#5225): a millimetre model's
 * values are converted to SI before comparing, the same reading the
 * validation engine uses, so an imported IDS applicability scopes the same
 * elements it would in an IDS checker.
 *
 *   Wall A  Width 300 (mm, project unit), Height IFCLENGTHMEASURE 2500 (mm)
 *   Wall B  Width 0.2 with an explicit METRE unit
 *   Wall C  Label IFCLABEL '5' (no unit)
 *   Wall D  Height only on its type: IFCLENGTHMEASURE 2.5 with an explicit
 *           METRE unit (review, #5432: a type-level explicit unit counts)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { isFilterRule, type FilterRule } from './filter-rules.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#32= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#101= IFCWALL('0WallA0000000000000001A',$,'Wall A',$,$,$,$,$,$);
#110= IFCQUANTITYLENGTH('Width',$,$,300.,$);
#111= IFCELEMENTQUANTITY('0Qto00000000000000111A',$,'Qto_WallBaseQuantities',$,$,(#110));
#112= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000112A',$,$,$,(#101),#111);
#113= IFCPROPERTYSINGLEVALUE('Height',$,IFCLENGTHMEASURE(2500.),$);
#114= IFCPROPERTYSET('0Pset00000000000000114A',$,'Pset_Dims',$,(#113));
#115= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000115A',$,$,$,(#101),#114);
#102= IFCWALL('0WallB0000000000000002A',$,'Wall B',$,$,$,$,$,$);
#120= IFCQUANTITYLENGTH('Width',$,#32,0.2,$);
#121= IFCELEMENTQUANTITY('0Qto00000000000000121A',$,'Qto_WallBaseQuantities',$,$,(#120));
#122= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000122A',$,$,$,(#102),#121);
#103= IFCWALL('0WallC0000000000000003A',$,'Wall C',$,$,$,$,$,$);
#130= IFCPROPERTYSINGLEVALUE('Height',$,IFCLABEL('5'),$);
#131= IFCPROPERTYSET('0Pset00000000000000131A',$,'Pset_Dims',$,(#130));
#132= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000132A',$,$,$,(#103),#131);
#104= IFCWALL('0WallD0000000000000004A',$,'Wall D',$,$,$,$,$,$);
#140= IFCPROPERTYSINGLEVALUE('Height',$,IFCLENGTHMEASURE(2.5),#32);
#141= IFCPROPERTYSET('0Pset00000000000000141A',$,'Pset_Dims',$,(#140));
#142= IFCWALLTYPE('0WType00000000000000142',$,'WT',$,$,(#141),$,$,$,.STANDARD.);
#143= IFCRELDEFINESBYTYPE('0Rel00000000000000143A',$,$,$,(#104),#142);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function names(rule: FilterRule): Promise<string[]> {
  const store = await parse();
  return evaluateFilterRules('m', store, [rule], 'AND').map((e) => e.name).sort();
}

describe('valueUnit: si in search (#5225)', () => {
  it('compares quantities in SI: 300 mm and an explicit 0.2 m both read in metres', async () => {
    const width = { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width' } as const;
    assert.deepEqual(await names({ ...width, op: 'gte', value: 0.25, valueUnit: 'si' }), ['Wall A']);
    assert.deepEqual(await names({ ...width, op: 'gte', value: 0.15, valueUnit: 'si' }), ['Wall A', 'Wall B']);
    // Without it, the same bound reads the stored numbers: 300 and 0.2.
    assert.deepEqual(await names({ ...width, op: 'gte', value: 0.25 }), ['Wall A']);
    assert.deepEqual(await names({ ...width, op: 'lte', value: 0.25 }), ['Wall B']);
    assert.deepEqual(await names({ ...width, op: 'lte', value: 0.25, valueUnit: 'si' }), ['Wall B']);
  });

  it('compares a length property in SI and leaves a unit-less label as stored', async () => {
    const height = { kind: 'property', setName: 'Pset_Dims', propertyName: 'Height' } as const;
    assert.deepEqual(await names({ ...height, op: 'gte', value: '2', valueUnit: 'si' }), ['Wall A', 'Wall C', 'Wall D']);
    assert.deepEqual(await names({ ...height, op: 'gt', value: '3', valueUnit: 'si' }), ['Wall C']);
  });

  it('only "si" is a valid valueUnit', () => {
    assert.equal(isFilterRule({ kind: 'quantity', setName: 'Q', quantityName: 'W', op: 'gt', value: 1, valueUnit: 'si' }), true);
    assert.equal(isFilterRule({ kind: 'quantity', setName: 'Q', quantityName: 'W', op: 'gt', value: 1, valueUnit: 'mm' }), false);
  });
});
