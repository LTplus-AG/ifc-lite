/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `runRuleSet` — `unique` (plan §4.5), `aggregate` (§4.6) and `compare`
 * (§4.7) requirement kinds (#5138 PR 3).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { runRuleSet } from './rule-engine.js';
import type { InformationRule, RuleSetFile } from './rule-set.js';
import { Rule } from '../search/filter-rules.js';
import type { ModelTagState } from '../model-tags/evaluator-models.js';

const HEADER = `ISO-10303-21;
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
`;
const FOOTER = `ENDSEC;
END-ISO-10303-21;
`;

async function parse(body: string): Promise<IfcDataStore> {
  const text = HEADER + body + FOOTER;
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function stateFor(stores: Record<string, IfcDataStore>): ModelTagState {
  const models = new Map(Object.entries(stores).map(([id, store]) => [id, { id, sourceFingerprint: undefined, ifcDataStore: store }]));
  return { models, modelTags: new Map(), modelTagAssignments: new Map() };
}

async function run(stores: Record<string, IfcDataStore>, ruleSet: RuleSetFile) {
  return runRuleSet({ ruleSet, models: stateFor(stores) });
}

// ── unique (plan §4.5) ──────────────────────────────────────────────────────

describe('runRuleSet — unique (#5138, plan §4.5)', () => {
  const SPACES = `
#501= IFCSPACE('0Space00000000000000501',$,'Office',$,$,#40,$,$,.ELEMENT.,$);
#502= IFCSPACE('0Space00000000000000502',$,'Office',$,$,#40,$,$,.ELEMENT.,$);
#503= IFCSPACE('0Space00000000000000503',$,'Lobby',$,$,#40,$,$,.ELEMENT.,$);
`;

  function uniqueNameRuleSet(): RuleSetFile {
    const rule: InformationRule = {
      id: 'r1', name: 'unique names',
      applicability: { groups: [{ rules: [Rule.ifcType(['IfcSpace'])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'unique', subject: { kind: 'name' } },
    };
    return { version: 1, name: 'test', rules: [rule] };
  }

  it('unique.name.duplicates: two IfcSpace sharing Name → one SetResult, two duplicate rows with "(2×)"', async () => {
    const store = await parse(SPACES);
    const report = await run({ m1: store }, uniqueNameRuleSet());
    const spec = report.specificationResults[0];
    assert.equal(spec.setResults?.length, 1);
    assert.equal(spec.setResults?.[0].label, 'Office');
    assert.equal(spec.setResults?.[0].members.length, 2);
    const dupRows = spec.entityResults.filter((e) => e.requirementResults[0].failureReason === 'duplicate');
    assert.equal(dupRows.length, 2);
    for (const row of dupRows) assert.equal(row.requirementResults[0].actualValue, 'Office (2×)');
    assert.equal(spec.status, 'fail');
  });

  it('unique.federation: the same Name in two parsed models is a duplicate; perModel scope is not', async () => {
    const storeA = await parse(`#501= IFCSPACE('0Space00000000000000601',$,'Office',$,$,#40,$,$,.ELEMENT.,$);\n`);
    const storeB = await parse(`#501= IFCSPACE('0Space00000000000000602',$,'Office',$,$,#40,$,$,.ELEMENT.,$);\n`);

    const federated = await run({ m1: storeA, m2: storeB }, uniqueNameRuleSet());
    const fedSpec = federated.specificationResults[0];
    assert.equal(fedSpec.setResults?.length, 1, 'federation scope (default) sees one duplicate across the two models');
    assert.equal(fedSpec.setResults?.[0].members.length, 2);

    const perModelRule: InformationRule = {
      id: 'r1', name: 'unique names per model',
      applicability: { groups: [{ rules: [Rule.ifcType(['IfcSpace'])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'unique', subject: { kind: 'name' }, scope: 'perModel' },
    };
    const perModel = await run({ m1: storeA, m2: storeB }, { version: 1, name: 'test', rules: [perModelRule] });
    const pmSpec = perModel.specificationResults[0];
    assert.equal(pmSpec.setResults?.length ?? 0, 0, 'perModel scope: one Office per model is not a duplicate');
  });
});

// ── aggregate (plan §4.6) ────────────────────────────────────────────────────

describe('runRuleSet — aggregate (#5138, plan §4.6)', () => {
  it('aggregate.sum.threshold: 100 + 100 + 87.4 vs > 300 fails, >= 287 passes', async () => {
    const body = `
#501= IFCSPACE('0Space00000000000000701',$,'Space A',$,$,#40,$,$,.ELEMENT.,$);
#502= IFCSPACE('0Space00000000000000702',$,'Space B',$,$,#40,$,$,.ELEMENT.,$);
#503= IFCSPACE('0Space00000000000000703',$,'Space C',$,$,#40,$,$,.ELEMENT.,$);
#520= IFCQUANTITYAREA('NetFloorArea',$,$,100.,$);
#521= IFCELEMENTQUANTITY('0Qto000000000000000721',$,'Qto_SpaceBaseQuantities',$,'BaseQuantities',(#520));
#522= IFCRELDEFINESBYPROPERTIES('0Rel0000000000000722A',$,$,$,(#501),#521);
#530= IFCQUANTITYAREA('NetFloorArea',$,$,100.,$);
#531= IFCELEMENTQUANTITY('0Qto000000000000000731',$,'Qto_SpaceBaseQuantities',$,'BaseQuantities',(#530));
#532= IFCRELDEFINESBYPROPERTIES('0Rel0000000000000732A',$,$,$,(#502),#531);
#540= IFCQUANTITYAREA('NetFloorArea',$,$,87.4,$);
#541= IFCELEMENTQUANTITY('0Qto000000000000000741',$,'Qto_SpaceBaseQuantities',$,'BaseQuantities',(#540));
#542= IFCRELDEFINESBYPROPERTIES('0Rel0000000000000742A',$,$,$,(#503),#541);
`;
    const store = await parse(body);
    function sumRule(op: 'gt' | 'gte', value: number): RuleSetFile {
      const rule: InformationRule = {
        id: 'r1', name: 'total area',
        applicability: { groups: [{ rules: [Rule.ifcType(['IfcSpace'])], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'aggregate', fn: 'sum', subject: { kind: 'quantity', setName: 'Qto_SpaceBaseQuantities', quantityName: 'NetFloorArea' }, op, value },
      };
      return { version: 1, name: 'test', rules: [rule] };
    }

    const failing = await run({ m1: store }, sumRule('gt', 300));
    const failSpec = failing.specificationResults[0];
    assert.equal(failSpec.setResults?.[0].passed, false, '287.4 is not > 300');
    assert.equal(failSpec.status, 'fail');

    const passing = await run({ m1: store }, sumRule('gte', 287));
    const passSpec = passing.specificationResults[0];
    assert.equal(passSpec.setResults?.[0].passed, true, '287.4 >= 287');
    assert.equal(passSpec.status, 'pass');
  });

  it('aggregate.count.groupBy.parent: with and without universe — the empty-group assembly only shows up (and fails) WITH universe', async () => {
    const body = `
#600= IFCELEMENTASSEMBLY('0Assembly000000000000600',$,'Assembly-1',$,$,#40,$,$,$);
#601= IFCPLATE('0Plate0000000000000000601',$,'Plate-1',$,$,#40,$,$,$);
#602= IFCRELAGGREGATES('0RelAgg000000000000000602',$,$,$,#600,(#601));
#610= IFCELEMENTASSEMBLY('0Assembly000000000000610',$,'Assembly-2',$,$,#40,$,$,$);
`;
    const store = await parse(body);
    const universeBlock = { groups: [{ rules: [Rule.ifcType(['IfcElementAssembly'])], combinator: 'AND' as const }], authoredAs: 'chips' as const };

    function countRule(withUniverse: boolean): RuleSetFile {
      const rule: InformationRule = {
        id: 'r1', name: 'plates per assembly',
        applicability: { groups: [{ rules: [Rule.ifcType(['IfcPlate'])], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: {
          kind: 'aggregate', fn: 'count',
          groupBy: { subject: { kind: 'parent' }, ...(withUniverse ? { universe: universeBlock } : {}) },
          op: 'gte', value: 1,
        },
      };
      return { version: 1, name: 'test', rules: [rule] };
    }

    const without = await run({ m1: store }, countRule(false));
    const withoutGroups = without.specificationResults[0].setResults ?? [];
    assert.equal(withoutGroups.length, 1, 'without universe, an assembly with zero plates never appears as a group');
    assert.equal(withoutGroups[0].groupKey, 'Assembly-1');
    assert.equal(withoutGroups[0].passed, true);

    const withUniverse = await run({ m1: store }, countRule(true));
    const withGroups = withUniverse.specificationResults[0].setResults ?? [];
    assert.equal(withGroups.length, 2, 'with universe, Assembly-2 is seeded with an empty (count 0) group');
    const assembly2 = withGroups.find((g) => g.groupKey === 'Assembly-2');
    assert.ok(assembly2, 'Assembly-2 must appear as its own group');
    assert.equal(assembly2!.passed, false, 'count 0 fails gte 1');
    assert.equal(assembly2!.actual, '0');
  });

  it('aggregate.count.groupBy.material: an element with two materials lands in BOTH groups (plan §3, review)', async () => {
    // Wall M1 carries Concrete AND Brick (two IfcRelAssociatesMaterial), so
    // it must contribute to BOTH groups — plan §3: "an element contributes
    // to every key it carries" for multi-valued groupBy subjects.
    const body = `
#910= IFCMATERIAL('Concrete',$,$);
#911= IFCMATERIAL('Brick',$,$);
#920= IFCWALL('0Wall0000000000000000920',$,'Wall M1',$,$,#40,$,'tag',$);
#921= IFCRELASSOCIATESMATERIAL('0RelM00000000000000921',$,$,$,(#920),#910);
#922= IFCRELASSOCIATESMATERIAL('0RelM00000000000000922',$,$,$,(#920),#911);
#930= IFCWALL('0Wall0000000000000000930',$,'Wall M2',$,$,#40,$,'tag',$);
#931= IFCRELASSOCIATESMATERIAL('0RelM00000000000000931',$,$,$,(#930),#910);
#940= IFCWALL('0Wall0000000000000000940',$,'Wall M3',$,$,#40,$,'tag',$);
#941= IFCRELASSOCIATESMATERIAL('0RelM00000000000000941',$,$,$,(#940),#911);
`;
    const store = await parse(body);
    const rule: InformationRule = {
      id: 'r1', name: 'walls per material',
      applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: {
        kind: 'aggregate', fn: 'count',
        groupBy: { subject: { kind: 'material' } },
        op: 'gte', value: 1,
      },
    };
    const report = await run({ m1: store }, { version: 1, name: 'test', rules: [rule] });
    const groups = report.specificationResults[0].setResults ?? [];
    assert.equal(groups.length, 2, 'two material groups: Concrete and Brick');

    const concrete = groups.find((g) => g.groupKey === 'Concrete');
    const brick = groups.find((g) => g.groupKey === 'Brick');
    assert.ok(concrete && brick);
    assert.equal(concrete!.actual, '2', 'Concrete: Wall M1 + Wall M2');
    assert.equal(brick!.actual, '2', 'Brick: Wall M1 + Wall M3');

    const concreteIds = concrete!.members.map((m) => m.expressId).sort((a, b) => a - b);
    const brickIds = brick!.members.map((m) => m.expressId).sort((a, b) => a - b);
    assert.deepEqual(concreteIds, [920, 930], 'Wall M1 (920) appears in the Concrete group alongside Wall M2 (930)');
    assert.deepEqual(brickIds, [920, 940], 'Wall M1 (920) ALSO appears in the Brick group, alongside Wall M3 (940)');
  });
});

// ── compare (plan §4.7) ──────────────────────────────────────────────────────

describe('runRuleSet — compare (#5138, plan §4.7)', () => {
  it('compare.volume: GrossVolume > NetVolume — a violating wall reports mismatch with both numbers', async () => {
    const body = `
#700= IFCWALL('0Wall0000000000000000700',$,'Wall Q',$,$,#40,$,'tag',$);
#720= IFCQUANTITYVOLUME('GrossVolume',$,$,10.,$);
#721= IFCQUANTITYVOLUME('NetVolume',$,$,12.,$);
#722= IFCELEMENTQUANTITY('0Qto000000000000000722',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#720,#721));
#723= IFCRELDEFINESBYPROPERTIES('0Rel0000000000000723A',$,$,$,(#700),#722);
`;
    const store = await parse(body);
    const rule: InformationRule = {
      id: 'r1', name: 'gross > net',
      applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: {
        kind: 'compare', op: 'gt',
        left: { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'GrossVolume' },
        right: { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'NetVolume' },
      },
    };
    const report = await run({ m1: store }, { version: 1, name: 'test', rules: [rule] });
    const row = report.specificationResults[0].entityResults.find((e) => e.entityName === 'Wall Q');
    assert.ok(row);
    assert.equal(row!.passed, false, '10 is not > 12');
    assert.equal(row!.requirementResults[0].failureReason, 'mismatch');
    assert.match(row!.requirementResults[0].actualValue ?? '', /10.*12/);
  });

  it('compare.date.notDate: a non-ISO date fails notDate; a valid ISO pair passes', async () => {
    const body = `
#800= IFCWALL('0Wall0000000000000000800',$,'Wall Bad Date',$,$,#40,$,'tag',$);
#810= IFCPROPERTYSINGLEVALUE('Start',$,IFCLABEL('2026-01-01'),$);
#811= IFCPROPERTYSINGLEVALUE('End',$,IFCLABEL('01/02/2026'),$);
#812= IFCPROPERTYSET('0Pset000000000000000812',$,'Pset_Dates',$,(#810,#811));
#813= IFCRELDEFINESBYPROPERTIES('0Rel0000000000000813A',$,$,$,(#800),#812);
#801= IFCWALL('0Wall0000000000000000801',$,'Wall Good Date',$,$,#40,$,'tag',$);
#820= IFCPROPERTYSINGLEVALUE('Start',$,IFCLABEL('2026-01-01'),$);
#821= IFCPROPERTYSINGLEVALUE('End',$,IFCLABEL('2027-01-01'),$);
#822= IFCPROPERTYSET('0Pset000000000000000822',$,'Pset_Dates',$,(#820,#821));
#823= IFCRELDEFINESBYPROPERTIES('0Rel0000000000000823A',$,$,$,(#801),#822);
`;
    const store = await parse(body);
    const rule: InformationRule = {
      id: 'r1', name: 'start before end',
      applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: {
        kind: 'compare', op: 'lt', valueType: 'date',
        left: { kind: 'property', setName: 'Pset_Dates', propertyName: 'Start' },
        right: { kind: 'property', setName: 'Pset_Dates', propertyName: 'End' },
      },
    };
    const report = await run({ m1: store }, { version: 1, name: 'test', rules: [rule] });
    const spec = report.specificationResults[0];
    const bad = spec.entityResults.find((e) => e.entityName === 'Wall Bad Date');
    const good = spec.entityResults.find((e) => e.entityName === 'Wall Good Date');
    assert.ok(bad && good);
    assert.equal(bad!.passed, false);
    assert.equal(bad!.requirementResults[0].failureReason, 'notDate');
    assert.equal(good!.passed, true, '2026-01-01 < 2027-01-01');
  });
});
