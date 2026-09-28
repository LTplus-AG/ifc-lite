/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `memberPath` on property rules and subjects addresses one member of an
 * `IfcComplexProperty` (#5475, maintainer decision on #5226): an explicit
 * field, one name per nesting level, never a dotted property name.
 *
 *   Wall A  Pset_Test.Dims  (complex)
 *             Width    = 300 mm (explicit unit)
 *             Frame    (complex)
 *               Material = 'Steel'
 *               Finish   -> IfcMaterial 'Oak' (a reference nested in a complex property)
 *           Pset_Test.Plain = 'x' (not complex)
 *   Wall B  Pset_Test.Dims
 *             Width    = 200 mm
 *             Frame
 *               Material = 'Wood'
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { isFilterRule, type FilterRule, type PropertyRule } from './filter-rules.js';
import { runRuleSet } from '../engine/rule-engine.js';
import { parseRuleSetFile } from '../rule-set/rule-set-io.js';
import { foldBetweenPairs, isBetweenChip } from '../rule-set/between-chip.js';
import { ruleSetToIds } from '../ids/rule-set-to-ids.js';
import type { RuleSetFile } from '../rule-set/rule-set.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#5= IFCMATERIAL('Oak',$,$);
#6= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10= IFCWALL('0WallA0000000000000010A',$,'Wall A',$,$,$,$,$,$);
#30= IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(300.),#6);
#31= IFCPROPERTYSINGLEVALUE('Material',$,IFCLABEL('Steel'),$);
#32= IFCPROPERTYREFERENCEVALUE('Finish',$,$,#5);
#33= IFCCOMPLEXPROPERTY('Frame',$,'frame',(#31,#32));
#34= IFCCOMPLEXPROPERTY('Dims',$,'dims',(#30,#33));
#35= IFCPROPERTYSINGLEVALUE('Plain',$,IFCLABEL('x'),$);
#36= IFCPROPERTYSET('0Pset00000000000000036A',$,'Pset_Test',$,(#34,#35));
#37= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000037A',$,$,$,(#10),#36);
#20= IFCWALL('0WallB0000000000000020A',$,'Wall B',$,$,$,$,$,$);
#50= IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(200.),#6);
#51= IFCPROPERTYSINGLEVALUE('Material',$,IFCLABEL('Wood'),$);
#52= IFCCOMPLEXPROPERTY('Frame',$,'frame',(#51));
#53= IFCCOMPLEXPROPERTY('Dims',$,'dims',(#50,#52));
#54= IFCPROPERTYSET('0Pset00000000000000054A',$,'Pset_Test',$,(#53));
#55= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000055A',$,$,$,(#20),#54);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** The walls `rule` selects. */
async function names(rule: FilterRule): Promise<string[]> {
  const walls: FilterRule = { kind: 'ifcType', op: 'in', values: ['IfcWall'] };
  return evaluateFilterRules('m', await parse(), [walls, rule], 'AND').map((e) => e.name).sort();
}

const dims = (memberPath: string[] | undefined, op: PropertyRule['op'], value: string): PropertyRule => ({
  kind: 'property', setName: 'Pset_Test', propertyName: 'Dims', op, value, ...(memberPath ? { memberPath } : {}),
});

describe('complex property members (#5475)', () => {
  it('the parser keeps each member by name, nested members and references included', async () => {
    const store = await parse();
    const [pset] = extractPropertiesOnDemand(store, 10);
    const complex = pset.properties.find((p) => p.name === 'Dims');
    assert.deepEqual(complex?.members?.map((m) => [m.name, m.value, m.unit]), [
      ['Width', 300, 'mm'],
      ['Frame', 'Material: Steel, Finish: Oak', undefined],
    ]);
    const frame = complex?.members?.[1];
    assert.deepEqual(frame?.members?.map((m) => [m.name, m.value]), [['Material', 'Steel'], ['Finish', 'Oak']]);
  });

  it('search reads the member the path names, case-insensitively', async () => {
    assert.deepEqual(await names(dims(['Width'], 'eq', '300')), ['Wall A']);
    assert.deepEqual(await names(dims(['Frame', 'Material'], 'eq', 'Wood')), ['Wall B']);
    assert.deepEqual(await names(dims(['frame', 'FINISH'], 'eq', 'Oak')), ['Wall A']);
    assert.deepEqual(await names(dims(['Frame', 'Material'], 'ne', 'Steel')), ['Wall B']);
    assert.deepEqual(await names(dims(['Width'], 'gt', '250')), ['Wall A']);
  });

  it('a member converts to SI with its own explicit unit', async () => {
    assert.deepEqual(await names({ ...dims(['Width'], 'gte', '0.25'), valueUnit: 'si' }), ['Wall A']);
  });

  it('a missing member, or a path into a property that is not complex, reads as absent', async () => {
    assert.deepEqual(await names(dims(['Nope'], 'isSet', '')), []);
    assert.deepEqual(await names(dims(['Frame', 'Finish'], 'isNotSet', '')), ['Wall B']);
    assert.deepEqual(await names(dims(['Width', 'Deeper'], 'isSet', '')), []);
    const plain: PropertyRule = { kind: 'property', setName: 'Pset_Test', propertyName: 'Plain', op: 'isSet', value: '', memberPath: ['x'] };
    assert.deepEqual(await names(plain), []);
  });

  it('without memberPath a complex property still reads as its members\' joined text', async () => {
    assert.deepEqual(await names(dims(undefined, 'contains', 'Width: 300')), ['Wall A']);
  });

  it('validation reads the member and names it in the report', async () => {
    const ruleSet: RuleSetFile = {
      version: 1, name: 'x',
      rules: [{
        id: 'r', name: 'width',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [dims(['Width'], 'eq', '300')], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    };
    const report = await runRuleSet({ ruleSet, models: [{ id: 'm', store: await parse() }] });
    const rows = report.specificationResults[0].entityResults;
    assert.deepEqual(Object.fromEntries(rows.map((e) => [e.entityName, e.passed])), { 'Wall A': true, 'Wall B': false });
    const b = rows.find((e) => e.entityName === 'Wall B')?.requirementResults[0];
    assert.equal(b?.actualValue, '200');
    assert.match(b?.checkedDescription ?? '', /Pset_Test\.Dims › Width/);
  });

  it('an aggregate requirement reads a member subject from a rule-set file', async () => {
    const file = (value: number) => ({
      version: 1, name: 'x',
      rules: [{
        id: 'a', name: 'total width',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'aggregate', fn: 'sum', op: 'eq', value, subject: { kind: 'property', setName: 'Pset_Test', propertyName: 'Dims', memberPath: ['Width'] } },
      }],
    });
    const run = async (value: number) => {
      const parsed = parseRuleSetFile(file(value));
      assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
      const report = await runRuleSet({ ruleSet: parsed.file, models: [{ id: 'm', store: await parse() }] });
      return report.specificationResults[0].status;
    };
    assert.equal(await run(500), 'pass');
    assert.equal(await run(400), 'fail');
  });

  it('only a non-empty list of names is accepted, and only on a property', () => {
    assert.equal(isFilterRule(dims(['Width'], 'eq', '1')), true);
    assert.equal(isFilterRule({ ...dims(undefined, 'eq', '1'), memberPath: [] }), false);
    assert.equal(isFilterRule({ ...dims(undefined, 'eq', '1'), memberPath: 'Width' }), false);
    assert.equal(isFilterRule({ ...dims(undefined, 'eq', '1'), memberPath: [''] }), false);
    assert.equal(isFilterRule({ kind: 'quantity', setName: 'Q', quantityName: 'L', op: 'eq', value: 1, memberPath: ['x'] }), false);
    const file = (subject: unknown) => ({
      version: 1, name: 'x',
      rules: [{
        id: 'u', name: 'u',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'unique', subject },
      }],
    });
    assert.equal(parseRuleSetFile(file({ kind: 'quantity', setName: 'Q', quantityName: 'L', memberPath: ['x'] })).ok, false);
    assert.equal(parseRuleSetFile(file({ kind: 'property', setName: 'P', propertyName: 'L', memberPath: [] })).ok, false);
  });

  it('a range on one member does not fold with a bound on another', () => {
    const rows = foldBetweenPairs([dims(['Width'], 'gte', '1'), dims(['Height'], 'lte', '2')]);
    assert.equal(rows.some(isBetweenChip), false);
    assert.equal(foldBetweenPairs([dims(['Width'], 'gte', '1'), dims(['Width'], 'lte', '2')]).some(isBetweenChip), true);
  });

  it('IDS export refuses a member rule rather than checking the whole property', () => {
    const ruleSet: RuleSetFile = {
      version: 1, name: 'x',
      rules: [{
        id: 'r', name: 'width',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [dims(['Frame', 'Material'], 'eq', 'Steel')], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    };
    const result = ruleSetToIds(ruleSet);
    assert.deepEqual(result.exportedRuleIds, []);
    assert.match(result.refused[0]?.reasons.join(' ') ?? '', /memberPath/);
  });
});
