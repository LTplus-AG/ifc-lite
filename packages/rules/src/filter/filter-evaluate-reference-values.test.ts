/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcPropertyReferenceValue` reads as the referenced object's Name, or an
 * external reference's Identification (#5475, maintainer decision on
 * #5226). Before, the parser read the `UsageName` slot as the reference, so
 * every reference property read as absent.
 *
 *   Wall A  Pset_Test.Finish   -> IfcMaterial 'Oak'
 *           Pset_Test.Spec     -> IfcClassificationReference with no Name, Identification 'Ss_25'
 *   Wall B  Pset_Test.Finish   -> IfcMaterial 'Steel'
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import type { FilterRule } from './filter-rules.js';
import { runRuleSet } from '../engine/rule-engine.js';
import type { RuleSetFile } from '../rule-set/rule-set.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#5= IFCMATERIAL('Oak',$,$);
#6= IFCMATERIAL('Steel',$,$);
#7= IFCCLASSIFICATIONREFERENCE($,'Ss_25',$,$,$,$);
#10= IFCWALL('0WallA0000000000000010A',$,'Wall A',$,$,$,$,$,$);
#11= IFCPROPERTYREFERENCEVALUE('Finish',$,'finish usage',#5);
#12= IFCPROPERTYREFERENCEVALUE('Spec',$,$,#7);
#13= IFCPROPERTYSET('0Pset00000000000000013A',$,'Pset_Test',$,(#11,#12));
#14= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000014A',$,$,$,(#10),#13);
#20= IFCWALL('0WallB0000000000000020A',$,'Wall B',$,$,$,$,$,$);
#21= IFCPROPERTYREFERENCEVALUE('Finish',$,$,#6);
#22= IFCPROPERTYSET('0Pset00000000000000022A',$,'Pset_Test',$,(#21));
#23= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000023A',$,$,$,(#20),#22);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function names(rule: FilterRule): Promise<string[]> {
  return evaluateFilterRules('m', await parse(), [rule], 'AND').map((e) => e.name).sort();
}

describe('reference property values (#5475)', () => {
  it('the parser reads the referenced Name, falling back to Identification', async () => {
    const store = await parse();
    const props = extractPropertiesOnDemand(store, 10)[0].properties;
    assert.deepEqual(props.map((p) => [p.name, p.value, p.structure]), [
      ['Finish', 'Oak', 'reference'],
      ['Spec', 'Ss_25', 'reference'],
    ]);
  });

  it('search matches the referenced object\'s name', async () => {
    const finish = { kind: 'property', setName: 'Pset_Test', propertyName: 'Finish' } as const;
    assert.deepEqual(await names({ ...finish, op: 'eq', value: 'Oak' }), ['Wall A']);
    assert.deepEqual(await names({ ...finish, op: 'isSet', value: '' }), ['Wall A', 'Wall B']);
    assert.deepEqual(await names({ kind: 'property', setName: 'Pset_Test', propertyName: 'Spec', op: 'eq', value: 'Ss_25' }), ['Wall A']);
  });

  it('validation reads it too', async () => {
    const ruleSet: RuleSetFile = {
      version: 1, name: 'x',
      rules: [{
        id: 'r', name: 'oak finish',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [{ kind: 'property', setName: 'Pset_Test', propertyName: 'Finish', op: 'eq', value: 'Oak' }], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    };
    const report = await runRuleSet({ ruleSet, models: [{ id: 'm', store: await parse() }] });
    const rows = report.specificationResults[0].entityResults;
    assert.deepEqual(Object.fromEntries(rows.map((e) => [e.entityName, e.passed])), { 'Wall A': true, 'Wall B': false });
    assert.equal(rows.find((e) => e.entityName === 'Wall B')?.requirementResults[0].actualValue, 'Steel');
  });
});
