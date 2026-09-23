/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `unit` requirement (#5300): "Width is recorded in mm".
 *
 * Fixture project length unit is MILLIMETRE, area unit is SQUARE_METRE.
 *   Wall A  Width 300 (no explicit unit → project mm), Height IFCLENGTHMEASURE
 *           2500 (→ mm), Label IFCLABEL, NetSideArea 7.5 (→ m²)
 *   Wall B  Width 0.3 with an explicit METRE unit, Height 2.5 with an
 *           explicit METRE unit
 *   Wall C  no quantities or properties at all
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { runRuleSet } from './rule-engine.js';
import { parseRuleSetFile } from '../rule-set/rule-set-io.js';
import type { InformationRule, Requirement, RuleSetFile } from '../rule-set/rule-set.js';
import { Rule } from '../filter/filter-rules.js';

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
#30= IFCUNITASSIGNMENT((#31,#32));
#31= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#32= IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#33= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#401= IFCWALL('0WallA0000000000000001A',$,'Wall A',$,$,#40,$,'tag',$);
#410= IFCQUANTITYLENGTH('Width',$,$,300.,$);
#411= IFCQUANTITYAREA('NetSideArea',$,$,7.5,$);
#412= IFCELEMENTQUANTITY('0Qto00000000000000412A',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#410,#411));
#413= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000413A',$,$,$,(#401),#412);
#414= IFCPROPERTYSINGLEVALUE('Height',$,IFCLENGTHMEASURE(2500.),$);
#415= IFCPROPERTYSINGLEVALUE('Label',$,IFCLABEL('A'),$);
#416= IFCPROPERTYSET('0Pset00000000000000416A',$,'Pset_Dims',$,(#414,#415));
#417= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000417A',$,$,$,(#401),#416);
#402= IFCWALL('0WallB0000000000000002A',$,'Wall B',$,$,#40,$,'tag',$);
#420= IFCQUANTITYLENGTH('Width',$,#33,0.3,$);
#421= IFCELEMENTQUANTITY('0Qto00000000000000421A',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#420));
#422= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000422A',$,$,$,(#402),#421);
#424= IFCPROPERTYSINGLEVALUE('Height',$,IFCLENGTHMEASURE(2.5),#33);
#426= IFCPROPERTYSET('0Pset00000000000000426A',$,'Pset_Dims',$,(#424));
#427= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000427A',$,$,$,(#402),#426);
#403= IFCWALL('0WallC0000000000000003A',$,'Wall C',$,$,#40,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function unitRule(requirement: Requirement): RuleSetFile {
  const rule: InformationRule = {
    id: 'u1',
    name: 'unit rule',
    applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
    requirement,
  };
  return { version: 1, name: 'units', rules: [rule] };
}

async function verdicts(requirement: Requirement) {
  const store = await parse();
  const report = await runRuleSet({ ruleSet: unitRule(requirement), models: [{ id: 'm1', store }] });
  const [spec] = report.specificationResults;
  assert.equal(spec.error, undefined, `rule errored: ${spec.error}`);
  const byName = Object.fromEntries(spec.entityResults.map((e) => [e.entityName, e]));
  return { spec, byName };
}

const width = { kind: 'quantity' as const, setName: 'Qto_WallBaseQuantities', quantityName: 'Width' };
const height = { kind: 'property' as const, setName: 'Pset_Dims', propertyName: 'Height' };

describe('unit requirement (#5300)', () => {
  it('a quantity without an explicit unit is recorded in the project unit; an explicit Unit overrides it', async () => {
    const { spec, byName } = await verdicts({ kind: 'unit', subject: width, unit: 'mm' });
    assert.equal(byName['Wall A'].passed, true);
    assert.equal(byName['Wall B'].passed, false);
    assert.equal(byName['Wall B'].requirementResults[0].failureReason, 'mismatch');
    assert.equal(byName['Wall B'].requirementResults[0].actualValue, '0.3 m');
    assert.equal(byName['Wall B'].requirementResults[0].expectedValue, 'mm');
    assert.equal(byName['Wall C'].passed, false);
    assert.equal(byName['Wall C'].requirementResults[0].failureReason, 'absent');
    assert.equal(spec.passedCount, 1);
    assert.equal(spec.failedCount, 2);
    assert.equal(spec.status, 'fail');
  });

  it('checks a property the same way: measure type → project unit, explicit Unit wins', async () => {
    const mm = await verdicts({ kind: 'unit', subject: height, unit: 'mm' });
    assert.equal(mm.byName['Wall A'].passed, true);
    assert.equal(mm.byName['Wall B'].passed, false);
    const m = await verdicts({ kind: 'unit', subject: height, unit: 'm' });
    assert.equal(m.byName['Wall A'].passed, false);
    assert.equal(m.byName['Wall B'].passed, true);
  });

  it('a value with no unit at all fails and says so', async () => {
    const { byName } = await verdicts({ kind: 'unit', subject: { kind: 'property', setName: 'Pset_Dims', propertyName: 'Label' }, unit: 'mm' });
    assert.equal(byName['Wall A'].passed, false);
    assert.equal(byName['Wall A'].requirementResults[0].actualValue, 'A no unit');
  });

  it('accepts the ASCII spelling of an exponent (m2 for m²)', async () => {
    const area = { kind: 'quantity' as const, setName: 'Qto_WallBaseQuantities', quantityName: 'NetSideArea' };
    for (const spelling of ['m²', 'm2', 'm^2']) {
      const { byName } = await verdicts({ kind: 'unit', subject: area, unit: spelling });
      assert.equal(byName['Wall A'].passed, true, `"${spelling}" should read as m²`);
    }
  });

  it('is case-sensitive about the unit itself (mm is not Mm)', async () => {
    const { byName } = await verdicts({ kind: 'unit', subject: width, unit: 'MM' });
    assert.equal(byName['Wall A'].passed, false);
  });
});

describe('unit requirement in a .rules.json file (#5300)', () => {
  const file = (requirement: unknown) => ({
    version: 1,
    name: 'units',
    rules: [{
      id: 'u1', name: 'unit rule',
      applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
      requirement,
    }],
  });

  it('round-trips a property or quantity subject', () => {
    const parsed = parseRuleSetFile(file({ kind: 'unit', subject: width, unit: ' mm ' }));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    assert.deepEqual(parsed.file.rules[0].requirement, { kind: 'unit', subject: width, unit: 'mm' });
  });

  it('rejects a subject that carries no unit', () => {
    const parsed = parseRuleSetFile(file({ kind: 'unit', subject: { kind: 'name' }, unit: 'mm' }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.error, /"unit" needs a property or quantity subject/);
  });

  it('rejects an empty unit', () => {
    const parsed = parseRuleSetFile(file({ kind: 'unit', subject: width, unit: '  ' }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.error, /"unit" must be a non-empty string/);
  });
});
