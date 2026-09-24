/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `inherit` on property / quantity rules (#5433), in search and validation.
 *
 *   Assembly  IfcElementAssembly, Pset_Asm.FireRating = 'REI60'
 *     Plate P1 (part, no own FireRating)
 *     Plate P2 (part, own FireRating = 'REI30')
 *   Beam B    typed by BeamType, whose Qto_BeamBaseQuantities.Length = 6
 *             (the occurrence has no quantities of its own)
 *   A cyclic aggregation X <-> Y (a broken file) must not hang.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { isFilterRule, type FilterRule } from './filter-rules.js';
import { runRuleSet } from '../engine/rule-engine.js';
import type { RuleSetFile } from '../rule-set/rule-set.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#10= IFCELEMENTASSEMBLY('0Asm0000000000000000010',$,'Assembly',$,$,$,$,$,$,$);
#11= IFCPLATE('0Pl10000000000000000011',$,'P1',$,$,$,$,$,$);
#12= IFCPLATE('0Pl20000000000000000012',$,'P2',$,$,$,$,$,$);
#13= IFCRELAGGREGATES('0Agg0000000000000000013',$,$,$,#10,(#11,#12));
#20= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#21= IFCPROPERTYSET('0Ps10000000000000000021',$,'Pset_Asm',$,(#20));
#22= IFCRELDEFINESBYPROPERTIES('0Rd10000000000000000022',$,$,$,(#10),#21);
#23= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI30'),$);
#24= IFCPROPERTYSET('0Ps20000000000000000024',$,'Pset_Asm',$,(#23));
#25= IFCRELDEFINESBYPROPERTIES('0Rd20000000000000000025',$,$,$,(#12),#24);
#30= IFCBEAM('0Bm00000000000000000030',$,'B',$,$,$,$,$,$);
#31= IFCQUANTITYLENGTH('Length',$,$,6.,$);
#32= IFCELEMENTQUANTITY('0Qt00000000000000000032',$,'Qto_BeamBaseQuantities',$,$,(#31));
#33= IFCBEAMTYPE('0Bt00000000000000000033',$,'BeamType',$,$,(#32),$,$,$,.BEAM.);
#34= IFCRELDEFINESBYTYPE('0Rt00000000000000000034',$,$,$,(#30),#33);
#40= IFCMEMBER('0MbX0000000000000000040',$,'X',$,$,$,$,$,$);
#41= IFCMEMBER('0MbY0000000000000000041',$,'Y',$,$,$,$,$,$);
#42= IFCRELAGGREGATES('0Ag20000000000000000042',$,$,$,#40,(#41));
#43= IFCRELAGGREGATES('0Ag30000000000000000043',$,$,$,#41,(#40));
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function names(rules: FilterRule[]): Promise<string[]> {
  const store = await parse();
  return evaluateFilterRules('m', store, rules, 'AND').map((e) => e.name).sort();
}

const fire = { kind: 'property', setName: 'Pset_Asm', propertyName: 'FireRating', op: 'eq', value: 'REI60' } as const;
const plates: FilterRule = { kind: 'ifcType', op: 'in', values: ['IfcPlate'] };

describe('inherit in search (#5433)', () => {
  it('aggregation: a part with no value takes its assembly\'s; its own value wins', async () => {
    assert.deepEqual(await names([plates, fire]), []);
    assert.deepEqual(await names([plates, { ...fire, inherit: 'aggregation' }]), ['P1']);
    assert.deepEqual(await names([plates, { ...fire, value: 'REI30', inherit: 'aggregation' }]), ['P2']);
  });

  it('type: a quantity also reads the type\'s quantity sets', async () => {
    const length: FilterRule = { kind: 'quantity', setName: 'Qto_BeamBaseQuantities', quantityName: 'Length', op: 'gte', value: 5 };
    assert.deepEqual(await names([length]), []);
    assert.deepEqual(await names([{ ...length, inherit: 'type' }]), ['B']);
    // 'aggregation' reads the type first too, before any aggregate parent (review, #5440).
    assert.deepEqual(await names([{ ...length, inherit: 'aggregation' }]), ['B']);
  });

  it('a cyclic aggregation ends', async () => {
    const members: FilterRule = { kind: 'ifcType', op: 'in', values: ['IfcMember'] };
    assert.deepEqual(await names([members, { ...fire, inherit: 'aggregation' }]), []);
  });

  it('only known inherit values are valid', () => {
    assert.equal(isFilterRule({ ...fire, inherit: 'aggregation' }), true);
    assert.equal(isFilterRule({ ...fire, inherit: 'parent' }), false);
  });
});

describe('inherit in validation (#5433)', () => {
  it('"every plate has a fire rating, from its assembly if need be"', async () => {
    const ruleSet: RuleSetFile = {
      version: 1, name: 'x',
      rules: [{
        id: 'r', name: 'rated',
        applicability: { groups: [{ rules: [plates], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [{ ...fire, op: 'isSet', value: '', inherit: 'aggregation' }], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    };
    const report = await runRuleSet({ ruleSet, models: [{ id: 'm', store: await parse() }] });
    const verdicts = Object.fromEntries(report.specificationResults[0].entityResults.map((e) => [e.entityName, e.passed]));
    assert.deepEqual(verdicts, { P1: true, P2: true });
  });
});
