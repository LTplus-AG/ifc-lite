/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7675 D3: the parser's walk budget cuts an `IfcComplexProperty` with 1100
 * members after 1024 visits. A `memberPath` naming a member past the cut must
 * not read as absent (an `isNotSet` rule would then select the wall on data
 * it never read): it reads as the cut level's marker member.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { COMPLEX_PROPERTY_BUDGET_MARKER, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import type { FilterRule, PropertyRule } from './filter-rules.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#10= IFCWALL('0WallA0000000000000010A',$,'Wall A',$,$,$,$,$,$);
#20= IFCPROPERTYSINGLEVALUE('First',$,IFCLABEL('v'),$);
#21= IFCPROPERTYSINGLEVALUE('Last',$,IFCLABEL('w'),$);
#22= IFCCOMPLEXPROPERTY('Wide',$,'wide',(${Array(1100).fill('#20').join(',')},#21));
#30= IFCPROPERTYSET('0Pset00000000000000030A',$,'Pset_Test',$,(#22));
#31= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000031A',$,$,$,(#10),#30);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function names(rule: FilterRule): Promise<string[]> {
  const walls: FilterRule = { kind: 'ifcType', op: 'in', values: ['IfcWall'] };
  return evaluateFilterRules('m', await parse(), [walls, rule], 'AND').map((e) => e.name);
}

const wide = (memberPath: string[], op: PropertyRule['op'], value = ''): PropertyRule => ({
  kind: 'property', setName: 'Pset_Test', propertyName: 'Wide', op, value, memberPath,
});

describe('complex property members past the walk budget (#7675)', () => {
  it('a member before the cut reads as itself', async () => {
    assert.deepEqual(await names(wide(['First'], 'eq', 'v')), ['Wall A']);
  });

  it('a member past the cut reads as the marker, not as absent', async () => {
    assert.deepEqual(await names(wide(['Last'], 'isNotSet')), [], 'past the cut is not "not set"');
    assert.deepEqual(await names(wide(['Last'], 'eq', 'w')), [], 'nor its real value');
    assert.deepEqual(await names(wide(['Last'], 'eq', COMPLEX_PROPERTY_BUDGET_MARKER)), ['Wall A']);
  });
});
