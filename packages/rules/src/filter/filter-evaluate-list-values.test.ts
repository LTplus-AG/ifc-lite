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
 *   Wall C  typed by WT, whose Pset_Test.Colors = (Blue, White); Tags = ()
 *   Wall D  Pset_Other.Colors = (Red); Pset_Test.Colors = (Green)
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
#16= IFCPROPERTYTABLEVALUE('Mixed',$,(IFCLABEL('Length'),IFCLABEL('Load')),(IFCREAL(0.5),IFCREAL(20.)),$,$,$,$);
#14= IFCPROPERTYSET('0Pset00000000000000014A',$,'Pset_Test',$,(#11,#12,#13,#16));
#15= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000015A',$,$,$,(#10),#14);
#20= IFCWALL('0WallB0000000000000020A',$,'Wall B',$,$,$,$,$,$);
#21= IFCPROPERTYLISTVALUE('Colors',$,(IFCLABEL('Green')),$);
#22= IFCPROPERTYSET('0Pset00000000000000022A',$,'Pset_Test',$,(#21));
#23= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000023A',$,$,$,(#20),#22);
#30= IFCWALL('0WallC0000000000000030A',$,'Wall C',$,$,$,$,$,$);
#31= IFCPROPERTYLISTVALUE('Colors',$,(IFCLABEL('Blue'),IFCLABEL('White')),$);
#32= IFCPROPERTYSET('0Pset00000000000000032A',$,'Pset_Test',$,(#31));
#33= IFCWALLTYPE('0WType00000000000000033',$,'WT',$,$,(#32),$,$,$,.STANDARD.);
#34= IFCRELDEFINESBYTYPE('0Rel00000000000000034A',$,$,$,(#30),#33);
#35= IFCPROPERTYLISTVALUE('Tags',$,(),$);
#36= IFCPROPERTYSET('0Pset00000000000000036A',$,'Pset_Test',$,(#35));
#37= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000037A',$,$,$,(#30),#36);
#40= IFCWALL('0WallD0000000000000040A',$,'Wall D',$,$,$,$,$,$);
#41= IFCPROPERTYLISTVALUE('Colors',$,(IFCLABEL('Red')),$);
#42= IFCPROPERTYSET('0Pset00000000000000042A',$,'Pset_Other',$,(#41));
#43= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000043A',$,$,$,(#40),#42);
#44= IFCPROPERTYLISTVALUE('Colors',$,(IFCLABEL('Green')),$);
#45= IFCPROPERTYSET('0Pset00000000000000045A',$,'Pset_Test',$,(#44));
#46= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000046A',$,$,$,(#40),#45);
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
    assert.deepEqual(await names(prop('Colors', 'eq', 'Blue')), ['Wall A', 'Wall C']);
    assert.deepEqual(await names(prop('Colors', 'eq', 'Red, Blue')), []);
    assert.deepEqual(await names(prop('Grade', 'eq', 'C30')), ['Wall A']);
  });

  it('search: a table cell matches, numerically too', async () => {
    assert.deepEqual(await names(prop('Load', 'eq', '20')), ['Wall A']);
    assert.deepEqual(await names(prop('Load', 'gte', '15')), ['Wall A']);
  });

  it('validation: a numeric eq matches a number cell of a table that also has text cells (review, #5545)', async () => {
    const ruleSet: RuleSetFile = {
      version: 1, name: 'x',
      rules: [{
        id: 'r', name: 'load 20',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' },
        // '20.0' is not the string '20': only a per-member numeric compare matches it.
        requirement: { kind: 'element', block: { groups: [{ rules: [prop('Mixed', 'eq', '20.0')], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    };
    const report = await runRuleSet({ ruleSet, models: [{ id: 'm', store: await parse() }] });
    const wallA = report.specificationResults[0].entityResults.find((e) => e.entityName === 'Wall A');
    assert.equal(wallA?.passed, true);
  });

  it('search: a negated op holds only when no member has the value', async () => {
    assert.deepEqual(await names(prop('Colors', 'ne', 'Red')), ['Wall B', 'Wall C', 'Wall D']);
    assert.deepEqual(await names(prop('Colors', 'ne', 'Purple')), ['Wall A', 'Wall B', 'Wall C', 'Wall D']);
    // Across property sets matched by a regex name: NONE of them may have it.
    const anySet = { kind: 'property', setName: 'Pset_.*', setNameKind: 'regex', propertyName: 'Colors', op: 'ne', value: 'Red' } as const;
    assert.deepEqual(await names(anySet), ['Wall B', 'Wall C']);
  });

  it('search: a rule read through the subject reader (inherit / SI) applies the same NONE rule (review, #5545)', async () => {
    assert.deepEqual(await names({ ...prop('Colors', 'ne', 'Red'), inherit: 'aggregation' } as FilterRule), ['Wall B', 'Wall C', 'Wall D']);
    assert.deepEqual(await names({ ...prop('Colors', 'ne', 'Red'), valueUnit: 'si' } as FilterRule), ['Wall B', 'Wall C', 'Wall D']);
    assert.deepEqual(await names({ ...prop('Colors', 'eq', 'Blue'), valueUnit: 'si' } as FilterRule), ['Wall A', 'Wall C']);
  });

  it('a type-level list is read member by member; an empty list still exists for search isSet', async () => {
    assert.deepEqual(await names(prop('Colors', 'eq', 'White')), ['Wall C']);
    const tags = { kind: 'property', setName: 'Pset_Test', propertyName: 'Tags', op: 'isSet', value: '' } as const;
    // Search's isSet asks whether the property exists, as before: an empty
    // list keeps its one (blank) display candidate, so it still does.
    assert.deepEqual(await names(tags), ['Wall C']);
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
    assert.deepEqual(verdicts, { 'Wall A': true, 'Wall B': false, 'Wall C': true, 'Wall D': false });
  });

  it('validation: a negated op holds only when no member has the value, as in search', async () => {
    const ruleSet: RuleSetFile = {
      version: 1, name: 'x',
      rules: [{
        id: 'r', name: 'not red',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [prop('Colors', 'ne', 'Red')], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    };
    const report = await runRuleSet({ ruleSet, models: [{ id: 'm', store: await parse() }] });
    const verdicts = Object.fromEntries(report.specificationResults[0].entityResults.map((e) => [e.entityName, e.passed]));
    assert.deepEqual(verdicts, { 'Wall A': false, 'Wall B': true, 'Wall C': true, 'Wall D': true });
  });

  it('set checks still read a list as one value: unique keys on the whole list', async () => {
    const ruleSet: RuleSetFile = {
      version: 1, name: 'x',
      rules: [{
        id: 'u', name: 'unique colors',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' },
        // Wall B and Wall D both have Pset_Test.Colors = (Green): the one duplicate pair.
        requirement: { kind: 'unique', subject: { kind: 'property', setName: 'Pset_Test', propertyName: 'Colors' } },
      }],
    };
    const report = await runRuleSet({ ruleSet, models: [{ id: 'm', store: await parse() }] });
    const failing = report.specificationResults[0].entityResults.filter((e) => !e.passed).map((e) => e.entityName).sort();
    assert.deepEqual(failing, ['Wall B', 'Wall D']);
  });
});
