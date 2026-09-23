/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `group` rules (#5226): membership in an `IfcGroup` via
 * `IfcRelAssignsToGroup`, in search/applicability and as a validation
 * requirement ("every AHU is assigned to a system").
 *
 *   AHU-1  in "Supply Air" (IfcDistributionSystem, a subclass of IfcSystem)
 *   AHU-2  in "Spares" (plain IfcGroup) only
 *   AHU-3  in nothing
 *   AHU-4  in an IfcSystem with no Name
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { isFilterRule, type FilterRule } from './filter-rules.js';
import { runRuleSet } from '../engine/rule-engine.js';
import { parseRuleSetFile } from '../rule-set/rule-set-io.js';
import { parseRequirementText, requirementToText } from '../rule-set/requirement-text.js';
import type { RuleSetFile } from '../rule-set/rule-set.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#101= IFCUNITARYEQUIPMENT('0Ahu100000000000000001',$,'AHU-1',$,$,#40,$,$,.AIRHANDLER.);
#102= IFCUNITARYEQUIPMENT('0Ahu200000000000000002',$,'AHU-2',$,$,#40,$,$,.AIRHANDLER.);
#103= IFCUNITARYEQUIPMENT('0Ahu300000000000000003',$,'AHU-3',$,$,#40,$,$,.AIRHANDLER.);
#104= IFCUNITARYEQUIPMENT('0Ahu400000000000000004',$,'AHU-4',$,$,#40,$,$,.AIRHANDLER.);
#201= IFCDISTRIBUTIONSYSTEM('0Sys100000000000000001',$,'Supply Air',$,$,$,.VENTILATION.);
#202= IFCGROUP('0Grp200000000000000002',$,'Spares',$,$);
#203= IFCSYSTEM('0Sys300000000000000003',$,$,$,$);
#301= IFCRELASSIGNSTOGROUP('0Rel100000000000000001',$,$,$,(#101),$,#201);
#302= IFCRELASSIGNSTOGROUP('0Rel200000000000000002',$,$,$,(#102),$,#202);
#303= IFCRELASSIGNSTOGROUP('0Rel300000000000000003',$,$,$,(#104),$,#203);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const AHUS: FilterRule = { kind: 'ifcType', op: 'in', values: ['IfcUnitaryEquipment'] };

async function matching(rule: FilterRule): Promise<string[]> {
  const store = await parse();
  return evaluateFilterRules('m1', store, [AHUS, rule], 'AND').map((e) => e.name).sort();
}

describe('group filter rule (#5226)', () => {
  it('isSet: assigned to any group, named or not', async () => {
    assert.deepEqual(await matching({ kind: 'group', op: 'isSet', value: '' }), ['AHU-1', 'AHU-2', 'AHU-4']);
  });

  it('isSet with groupClass IfcSystem takes subclasses (IfcDistributionSystem) and skips plain groups', async () => {
    assert.deepEqual(await matching({ kind: 'group', groupClass: 'IfcSystem', op: 'isSet', value: '' }), ['AHU-1', 'AHU-4']);
  });

  it('isNotSet', async () => {
    assert.deepEqual(await matching({ kind: 'group', op: 'isNotSet', value: '' }), ['AHU-3']);
    assert.deepEqual(await matching({ kind: 'group', groupClass: 'IfcSystem', op: 'isNotSet', value: '' }), ['AHU-2', 'AHU-3']);
  });

  it('value ops match the group Name', async () => {
    assert.deepEqual(await matching({ kind: 'group', op: 'eq', value: 'Supply Air' }), ['AHU-1']);
    assert.deepEqual(await matching({ kind: 'group', op: 'contains', value: 'pare' }), ['AHU-2']);
  });

  it('is a valid persisted rule, and a malformed one is not', () => {
    assert.equal(isFilterRule({ kind: 'group', groupClass: 'IfcSystem', op: 'isSet', value: '' }), true);
    assert.equal(isFilterRule({ kind: 'group', op: 'startsWith', value: 'x' }), false);
    assert.equal(isFilterRule({ kind: 'group', op: 'eq', value: 3 }), false);
    assert.equal(isFilterRule({ kind: 'group', op: 'eq', value: 'x', groupClass: 7 }), false);
  });
});

function ruleSet(requirementRules: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    name: 'MEP checks',
    rules: [{
      id: 'g1', name: 'Every AHU is assigned to a system',
      applicability: { groups: [{ rules: [AHUS], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ rules: requirementRules, combinator: 'AND' }], authoredAs: 'chips' } },
      ...extra,
    }],
  };
}

describe('group as a validation requirement (#5226)', () => {
  it('"every AHU is assigned to a system" passes exactly the AHUs in an IfcSystem', async () => {
    const parsed = parseRuleSetFile(ruleSet([{ kind: 'group', groupClass: 'IfcSystem', op: 'isSet', value: '' }]));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    const store = await parse();
    const report = await runRuleSet({ ruleSet: parsed.file, models: [{ id: 'm1', store }] });
    const [spec] = report.specificationResults;
    assert.equal(spec.error, undefined);
    const verdicts = Object.fromEntries(spec.entityResults.map((e) => [e.entityName, e.passed]));
    assert.deepEqual(verdicts, { 'AHU-1': true, 'AHU-2': false, 'AHU-3': false, 'AHU-4': true });
    const ahu3 = spec.entityResults.find((e) => e.entityName === 'AHU-3');
    assert.equal(ahu3?.requirementResults[0].failureReason, 'absent');
    assert.equal(ahu3?.requirementResults[0].checkedDescription, 'Group[IfcSystem] is set');
  });

  it('a group subject counts per group in an aggregate, and has a text spelling', async () => {
    const file: RuleSetFile = {
      version: 1, name: 'MEP checks',
      rules: [{
        id: 'g2', name: 'At most one AHU per group',
        applicability: { groups: [{ rules: [AHUS], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'aggregate', fn: 'count', op: 'lte', value: 1, groupBy: { subject: { kind: 'group' } } },
      }],
    };
    const parsed = parseRuleSetFile(JSON.parse(JSON.stringify(file)));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    const store = await parse();
    const report = await runRuleSet({ ruleSet: parsed.file, models: [{ id: 'm1', store }] });
    assert.equal(report.specificationResults[0].error, undefined);
    assert.equal(report.specificationResults[0].status, 'pass');

    const requirement = parsed.file.rules[0].requirement;
    assert.equal(requirement.kind, 'aggregate');
    if (requirement.kind !== 'aggregate') return;
    const text = requirementToText(requirement);
    assert.equal(text, 'count() <= 1 by group');
    const back = parseRequirementText(text);
    assert.ok(back.ok);
    assert.deepEqual(back.requirement, { kind: 'aggregate', fn: 'count', op: 'lte', value: 1, groupBy: { subject: { kind: 'group' } } });
  });

  it('a group subject rejects a non-string groupClass', () => {
    const parsed = parseRuleSetFile({
      version: 1, name: 'x',
      rules: [{
        id: 'g3', name: 'x',
        applicability: { groups: [{ rules: [AHUS], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'unique', subject: { kind: 'group', groupClass: 3 } },
      }],
    });
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.error, /"groupClass" must be a string/);
  });
});
