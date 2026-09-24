/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List, enumerated and table property values match ANY candidate (#5475,
 * maintainer decision on #5226), in search and validation alike; a negated
 * op holds only when NO candidate has the value.
 *
 *   Wall A  Colors  IfcPropertyListValue       (Red, Blue)
 *           Grade   IfcPropertyEnumeratedValue (C30)
 *           Load    IfcPropertyTableValue      rows 1 -> 10, 2 -> 20
 *   Wall B  Colors  IfcPropertyListValue       (Green)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import type { FilterRule } from './filter-rules.js';
import { runRuleSet } from '../engine/rule-engine.js';
import type { RuleSetFile } from '../rule-set/rule-set.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#10= IFCWALL('0WallA0000000000000010A',$,'Wall A',$,$,$,$,$,$);
#11= IFCPROPERTYLISTVALUE('Colors',$,(IFCLABEL('Red'),IFCLABEL('Blue')),$);
#12= IFCPROPERTYENUMERATEDVALUE('Grade',$,(IFCLABEL('C30')),$);
#13= IFCPROPERTYTABLEVALUE('Load',$,(IFCINTEGER(1),IFCINTEGER(2)),(IFCREAL(10.),IFCREAL(20.)),$,$,$,$);
#14= IFCPROPERTYSET('0Pset00000000000000014A',$,'Pset_Test',$,(#11,#12,#13));
#15= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000015A',$,$,$,(#10),#14);
#20= IFCWALL('0WallB0000000000000020A',$,'Wall B',$,$,$,$,$,$);
#21= IFCPROPERTYLISTVALUE('Colors',$,(IFCLABEL('Green')),$);
#22= IFCPROPERTYSET('0Pset00000000000000022A',$,'Pset_Test',$,(#21));
#23= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000023A',$,$,$,(#20),#22);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const prop = (propertyName: string, op: 'eq' | 'ne' | 'gte' | 'contains', value: string): FilterRule =>
  ({ kind: 'property', setName: 'Pset_Test', propertyName, op, value });

async function names(rule: FilterRule): Promise<string[]> {
  return evaluateFilterRules('m', await parse(), [rule], 'AND').map((e) => e.name).sort();
}

describe('list and table values match any candidate (#5475)', () => {
  it('search: a list member matches, the joined display string no longer has to', async () => {
    assert.deepEqual(await names(prop('Colors', 'eq', 'Blue')), ['Wall A']);
    assert.deepEqual(await names(prop('Colors', 'eq', 'Red, Blue')), []);
    assert.deepEqual(await names(prop('Grade', 'eq', 'C30')), ['Wall A']);
  });

  it('search: a table cell matches, numerically too', async () => {
    assert.deepEqual(await names(prop('Load', 'eq', '20')), ['Wall A']);
    assert.deepEqual(await names(prop('Load', 'gte', '15')), ['Wall A']);
  });

  it('search: a negated op holds only when no member has the value', async () => {
    assert.deepEqual(await names(prop('Colors', 'ne', 'Red')), ['Wall B']);
    assert.deepEqual(await names(prop('Colors', 'ne', 'Purple')), ['Wall A', 'Wall B']);
  });

  it('validation reads the same candidates', async () => {
    const ruleSet: RuleSetFile = {
      version: 1, name: 'x',
      rules: [{
        id: 'r', name: 'has blue',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [prop('Colors', 'eq', 'Blue')], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    };
    const report = await runRuleSet({ ruleSet, models: [{ id: 'm', store: await parse() }] });
    const verdicts = Object.fromEntries(report.specificationResults[0].entityResults.map((e) => [e.entityName, e.passed]));
    assert.deepEqual(verdicts, { 'Wall A': true, 'Wall B': false });
  });
});
