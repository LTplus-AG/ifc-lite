/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `runRuleSet` — the `element` requirement kind (#5138 PR 3, plan §4.4).
 *
 * Fixture: three `IfcWall`s (Wall A `FireRating='2HR'` + `Width=0.3m`, Wall B
 * `FireRating='1HR'` + `Width=0.2m`, Wall C no `Pset_WallCommon` and no
 * `Qto_WallBaseQuantities` at all — the "absent" case for both a property
 * and a quantity), one `IfcWallStandardCase` (Wall D, for `exactClass`) and
 * one plain `IfcWall` named "Basement level 1" (Wall E, for `caseSensitive`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { runRuleSet } from './rule-engine.js';
import type { InformationRule, RuleSetFile } from './rule-set.js';
import { Rule, type FilterRule } from '../search/filter-rules.js';
import type { ModelTagState } from '../model-tags/evaluator-models.js';

const WALLS_IFC = `ISO-10303-21;
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
#100= IFCBUILDINGSTOREY('0Storey0000000000000100',$,'Level 1',$,$,#40,$,$,.ELEMENT.,0.);
#401= IFCWALL('0WallA0000000000000001A',$,'Wall A',$,$,#40,$,'tag',$);
#410= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2HR'),$);
#411= IFCPROPERTYSINGLEVALUE('EmptyProp',$,IFCLABEL(''),$);
#412= IFCPROPERTYSET('0Pset00000000000000412A',$,'Pset_WallCommon',$,(#410,#411));
#413= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000413A',$,$,$,(#401),#412);
#420= IFCQUANTITYLENGTH('Width',$,$,0.3,$);
#421= IFCELEMENTQUANTITY('0Qto00000000000000421A',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#420));
#422= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000422A',$,$,$,(#401),#421);
#402= IFCWALL('0WallB0000000000000002A',$,'Wall B',$,$,#40,$,'tag',$);
#430= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'),$);
#431= IFCPROPERTYSET('0Pset00000000000000431A',$,'Pset_WallCommon',$,(#430));
#432= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000432A',$,$,$,(#402),#431);
#440= IFCQUANTITYLENGTH('Width',$,$,0.2,$);
#441= IFCELEMENTQUANTITY('0Qto00000000000000441A',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#440));
#442= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000442A',$,$,$,(#402),#441);
#403= IFCWALL('0WallC0000000000000003A',$,'Wall C',$,$,#40,$,'tag',$);
#404= IFCDOORSTANDARDCASE('0DoorD000000000000004A',$,'Door D',$,$,#40,$,'tag',$);
#406= IFCDOOR('0DoorE000000000000006A',$,'Door E',$,$,#40,$,'tag',$);
#405= IFCWALL('0WallE0000000000000005A',$,'Basement level 1',$,$,#40,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

async function parseWalls(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(WALLS_IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function stateFor(store: IfcDataStore, id = 'm1'): ModelTagState {
  return {
    models: new Map([[id, { id, sourceFingerprint: undefined, ifcDataStore: store }]]),
    modelTags: new Map(),
    modelTagAssignments: new Map(),
  };
}

function wallApplicability(extra: FilterRule[] = []) {
  return { groups: [{ rules: [Rule.ifcType(['IfcWall']), ...extra], combinator: 'AND' as const }], authoredAs: 'chips' as const };
}

function elementRuleSet(rule: FilterRule, options: Partial<InformationRule> = {}): RuleSetFile {
  const informationRule: InformationRule = {
    id: 'r1',
    name: 'test rule',
    applicability: wallApplicability(),
    requirement: { kind: 'element', block: { groups: [{ rules: [rule], combinator: 'AND' }], authoredAs: 'chips' } },
    ...options,
  };
  return { version: 1, name: 'test', rules: [informationRule] };
}

async function run(store: IfcDataStore, ruleSet: RuleSetFile) {
  return runRuleSet({ ruleSet, models: stateFor(store) });
}

function entityByName(spec: Awaited<ReturnType<typeof run>>['specificationResults'][number], name: string) {
  const row = spec.entityResults.find((e) => e.entityName === name);
  assert.ok(row, `no entity row for ${name}`);
  return row!;
}

describe('runRuleSet — element requirement, nine issue operators (#5138)', () => {
  it('eq: matches only Wall A, absent Wall C fails with reason absent', async () => {
    const store = await parseWalls();
    const report = await run(store, elementRuleSet(Rule.property('Pset_WallCommon', 'FireRating', 'eq', '2HR')));
    const spec = report.specificationResults[0];
    assert.equal(entityByName(spec, 'Wall A').passed, true);
    assert.equal(entityByName(spec, 'Wall B').passed, false);
    const c = entityByName(spec, 'Wall C');
    assert.equal(c.passed, false);
    assert.equal(c.requirementResults[0].failureReason, 'absent');
    assert.equal(c.requirementResults[0].actualValue, '""');
  });

  it('ne: Wall B matches, Wall A fails (equal), absent Wall C FAILS (not vacuously true)', async () => {
    const store = await parseWalls();
    const report = await run(store, elementRuleSet(Rule.property('Pset_WallCommon', 'FireRating', 'ne', '2HR')));
    const spec = report.specificationResults[0];
    assert.equal(entityByName(spec, 'Wall A').passed, false);
    assert.equal(entityByName(spec, 'Wall B').passed, true);
    const c = entityByName(spec, 'Wall C');
    assert.equal(c.passed, false, 'ne must fail on absent, not pass vacuously (plan §4 item 2)');
    assert.equal(c.requirementResults[0].failureReason, 'absent');
  });

  it('contains: 2HR and 1HR both contain "HR"', async () => {
    const store = await parseWalls();
    const report = await run(store, elementRuleSet(Rule.property('Pset_WallCommon', 'FireRating', 'contains', 'HR')));
    const spec = report.specificationResults[0];
    assert.equal(entityByName(spec, 'Wall A').passed, true);
    assert.equal(entityByName(spec, 'Wall B').passed, true);
    assert.equal(entityByName(spec, 'Wall C').passed, false);
  });

  it('exists (isSet): fails on the absent wall', async () => {
    const store = await parseWalls();
    const report = await run(store, elementRuleSet(Rule.property('Pset_WallCommon', 'FireRating', 'isSet', '')));
    const spec = report.specificationResults[0];
    assert.equal(entityByName(spec, 'Wall A').passed, true);
    assert.equal(entityByName(spec, 'Wall C').passed, false);
  });

  it('gt / gte / lt / lte: numeric quantity Width, actualValue carries the unit', async () => {
    const store = await parseWalls();
    const gt = await run(store, elementRuleSet(Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gt', 0.25)));
    const gtSpec = gt.specificationResults[0];
    assert.equal(entityByName(gtSpec, 'Wall A').passed, true, '0.3 > 0.25');
    assert.equal(entityByName(gtSpec, 'Wall B').passed, false, '0.2 > 0.25 is false');
    const aRow = entityByName(gtSpec, 'Wall A');
    assert.match(aRow.requirementResults[0].actualValue ?? '', /^0\.3(\s?m)?$/, `expected a unit-suffixed actual, got "${aRow.requirementResults[0].actualValue}"`);

    const gte = await run(store, elementRuleSet(Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gte', 0.3)));
    assert.equal(entityByName(gte.specificationResults[0], 'Wall A').passed, true);

    const lt = await run(store, elementRuleSet(Rule.quantity('Qto_WallBaseQuantities', 'Width', 'lt', 0.25)));
    assert.equal(entityByName(lt.specificationResults[0], 'Wall B').passed, true, '0.2 < 0.25');
    assert.equal(entityByName(lt.specificationResults[0], 'Wall A').passed, false);

    const lte = await run(store, elementRuleSet(Rule.quantity('Qto_WallBaseQuantities', 'Width', 'lte', 0.2)));
    assert.equal(entityByName(lte.specificationResults[0], 'Wall B').passed, true);
    assert.equal(entityByName(lte.specificationResults[0], 'Wall C').passed, false, 'absent quantity always fails');
  });

  it('between (gte + lte pair on the identical subject, plan §5): inclusive both bounds', async () => {
    const store = await parseWalls();
    const rule: InformationRule = {
      id: 'r1', name: 'between',
      applicability: wallApplicability(),
      requirement: {
        kind: 'element',
        block: {
          groups: [{
            rules: [
              Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gte', 0.25),
              Rule.quantity('Qto_WallBaseQuantities', 'Width', 'lte', 0.35),
            ],
            combinator: 'AND',
          }],
          authoredAs: 'chips',
        },
      },
    };
    const report = await run(store, { version: 1, name: 'test', rules: [rule] });
    const spec = report.specificationResults[0];
    assert.equal(entityByName(spec, 'Wall A').passed, true, '0.3 is within [0.25, 0.35]');
    assert.equal(entityByName(spec, 'Wall B').passed, false, '0.2 is below the lower bound');
    assert.equal(entityByName(spec, 'Wall C').passed, false, 'absent fails between too');
    assert.match(entityByName(spec, 'Wall A').requirementResults[0].expectedValue ?? '', />=\s*0\.25.*<=\s*0\.35/);
  });

  it('notNumeric: a numeric op against the non-numeric FireRating string', async () => {
    const store = await parseWalls();
    const report = await run(store, elementRuleSet(Rule.property('Pset_WallCommon', 'FireRating', 'gt', '5')));
    const spec = report.specificationResults[0];
    const a = entityByName(spec, 'Wall A');
    assert.equal(a.passed, false);
    assert.equal(a.requirementResults[0].failureReason, 'notNumeric');
  });

  it('present.empty-string: an explicitly empty property fails isSet with reason absent', async () => {
    const store = await parseWalls();
    const report = await run(store, elementRuleSet(Rule.property('Pset_WallCommon', 'EmptyProp', 'isSet', '')));
    const spec = report.specificationResults[0];
    const a = entityByName(spec, 'Wall A');
    assert.equal(a.passed, false, 'an empty string is not "set" (plan §4 item 2, stricter than IDS)');
    assert.equal(a.requirementResults[0].failureReason, 'absent');
    assert.equal(a.requirementResults[0].actualValue, '""');
  });
});

describe('runRuleSet — exactClass applicability (#5138, bSI #356)', () => {
  // `IfcDoorStandardCase` COALESCES with `IfcDoor` under the entity table's
  // `getTypeName` grouping (`packages/data/src/exact-type-name.ts`'s module
  // doc names it explicitly, alongside `IfcSlabStandardCase`/`IfcSlab`) —
  // unlike `IfcWallStandardCase`, which holds its own distinct enum value
  // and so is never grouped in the first place. Door D exercises the actual
  // grouping `exactClass` has to see through; Door E is the control (a
  // plain `IfcDoor`, must match either way).
  //
  // `combinator: 'OR'` (not `AND`) — `selectIterationSource`
  // (`lib/search/filter-iteration-source.ts`) only prefilters via the raw
  // `entityIndex.byType` bucket under `AND`, and that bucket is keyed by
  // the entity's LITERAL declared class ('IFCDOORSTANDARDCASE' for Door D),
  // never reaching the grouped `getTypeName` comparison at all — so an
  // `AND`-combined single `ifcType` rule would exclude Door D from the
  // iteration source before `exactClass` (or its absence) ever mattered,
  // testing nothing. `OR` forces the full-scan path, where the per-entity
  // check genuinely runs `getTypeName`/`exactTypeName` against `rule.values`.
  function doorApplicability(exactClass: boolean) {
    return { groups: [{ rules: [{ kind: 'ifcType' as const, values: ['IfcDoor'], op: 'in' as const, ...(exactClass ? { exactClass: true } : {}) }], combinator: 'OR' as const }], authoredAs: 'chips' as const };
  }
  function doorRuleSet(exactClass: boolean): RuleSetFile {
    const rule: InformationRule = {
      id: 'r1', name: 'door isSet',
      applicability: doorApplicability(exactClass),
      requirement: { kind: 'element', block: { groups: [{ rules: [Rule.property('Pset_DoorCommon', 'FireRating', 'isSet', '')], combinator: 'AND' }], authoredAs: 'chips' } },
    };
    return { version: 1, name: 'test', rules: [rule] };
  }

  it('default (no exactClass) includes IfcDoorStandardCase via the getTypeName grouping', async () => {
    const store = await parseWalls();
    const report = await run(store, doorRuleSet(false));
    const spec = report.specificationResults[0];
    assert.ok(spec.entityResults.some((e) => e.entityName === 'Door D'), 'IfcDoorStandardCase must be applicable by default');
    assert.ok(spec.entityResults.some((e) => e.entityName === 'Door E'));
  });

  it('exactClass: true excludes IfcDoorStandardCase', async () => {
    const store = await parseWalls();
    const report = await run(store, doorRuleSet(true));
    const spec = report.specificationResults[0];
    assert.ok(!spec.entityResults.some((e) => e.entityName === 'Door D'), 'exactClass must exclude the StandardCase subtype');
    assert.ok(spec.entityResults.some((e) => e.entityName === 'Door E'), 'a plain IfcDoor still matches exactClass IfcDoor');
  });
});

describe('runRuleSet — caseSensitive default (#5138, bSI #346)', () => {
  it('default (caseSensitive omitted = true) fails on a case difference; caseSensitive:false passes', async () => {
    const store = await parseWalls();
    const strict = elementRuleSet(Rule.name('eq', 'Basement Level 1'));
    const strictReport = await run(store, strict);
    assert.equal(entityByName(strictReport.specificationResults[0], 'Basement level 1').passed, false);

    const loose = elementRuleSet(Rule.name('eq', 'Basement Level 1'), { caseSensitive: false });
    const looseReport = await run(store, loose);
    assert.equal(entityByName(looseReport.specificationResults[0], 'Basement level 1').passed, true);
  });
});
