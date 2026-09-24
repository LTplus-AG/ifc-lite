/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The exported IDS checks what the rule checks (#5225): run the rule set
 * through the rule engine and its IDS export through `@ifc-lite/ids`'s own
 * validator on the same model, and every element must get the same verdict
 * from both. This is the oracle behind "never approximated".
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { Rule, type FilterRule } from '../filter/filter-rules.js';
import type { InformationRule, RuleSetFile } from '../rule-set/rule-set.js';
import { runRuleSet } from '../engine/rule-engine.js';

// The changed-test oracle deletes new production files before re-running
// this test. Load them at runtime so a missing module fails an assertion
// instead of preventing collection (same pattern as
// `packages/mutations/src/effective-entity-enumeration.test.ts`).
const fromIdsPath = './ids-to-rule-set.js';
const fromIds: typeof import('./ids-to-rule-set.js') | null = await import(fromIdsPath).catch(() => null);
function idsToRuleSet(...args: Parameters<typeof import('./ids-to-rule-set.js').idsToRuleSet>): ReturnType<typeof import('./ids-to-rule-set.js').idsToRuleSet> {
  assert.ok(fromIds, './ids-to-rule-set.js must exist');
  return fromIds.idsToRuleSet(...args);
}
const toIdsPath = './rule-set-to-ids.js';
const toIds: typeof import('./rule-set-to-ids.js') | null = await import(toIdsPath).catch(() => null);
function ruleSetToIds(...args: Parameters<typeof import('./rule-set-to-ids.js').ruleSetToIds>): ReturnType<typeof import('./rule-set-to-ids.js').ruleSetToIds> {
  assert.ok(toIds, './rule-set-to-ids.js must exist');
  return toIds.ruleSetToIds(...args);
}

// Four walls and a wall subclass, authored in metres or in millimetres
// (\`k\` = stored units per metre): A rated 2HR, 0.3 m wide, 2.5 m high,
// described; B rated 1HR, 0.2 m wide; C with nothing; D ("W-104") rated 2HR;
// the IfcWallStandardCase must stay out of an exact-class applicability on
// both sides.
const IFC = (k: 1 | 1000) => `ISO-10303-21;
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
#31= IFCSIUNIT(*,.LENGTHUNIT.,${k === 1 ? '$' : '.MILLI.'},.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#401= IFCWALL('0WallA0000000000000001A',$,'Wall A','External',$,#40,$,'tag',$);
#410= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2HR'),$);
#412= IFCPROPERTYSET('0Pset00000000000000412A',$,'Pset_WallCommon',$,(#410));
#413= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000413A',$,$,$,(#401),#412);
#420= IFCQUANTITYLENGTH('Width',$,$,${0.3 * k},$);
#415= IFCPROPERTYSINGLEVALUE('Height',$,IFCLENGTHMEASURE(${2.5 * k}),$);
#416= IFCPROPERTYSET('0Pset00000000000000416A',$,'Pset_Dims',$,(#415));
#417= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000417A',$,$,$,(#401),#416);
#421= IFCELEMENTQUANTITY('0Qto00000000000000421A',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#420));
#422= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000422A',$,$,$,(#401),#421);
#402= IFCWALL('0WallB0000000000000002A',$,'Wall B',$,$,#40,$,'tag',$);
#430= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'),$);
#431= IFCPROPERTYSET('0Pset00000000000000431A',$,'Pset_WallCommon',$,(#430));
#432= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000432A',$,$,$,(#402),#431);
#440= IFCQUANTITYLENGTH('Width',$,$,${0.2 * k},$);
#441= IFCELEMENTQUANTITY('0Qto00000000000000441A',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#440));
#442= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000442A',$,$,$,(#402),#441);
#403= IFCWALL('0WallC0000000000000003A',$,'Wall C',$,$,#40,$,'tag',$);
#404= IFCWALL('0WallD0000000000000004A',$,'W-104',$,$,#40,$,'tag',$);
#450= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2HR'),$);
#451= IFCPROPERTYSET('0Pset00000000000000451A',$,'Pset_WallCommon',$,(#450));
#452= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000452A',$,$,$,(#404),#451);
#405= IFCWALLSTANDARDCASE('0WallE0000000000000005A',$,'Wall E',$,$,#40,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(k: 1 | 1000): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC(k));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const exactWall: FilterRule = { kind: 'ifcType', op: 'in', values: ['IfcWall'], exactClass: true };

function rule(id: string, requirement: FilterRule[]): InformationRule {
  return {
    id,
    name: id,
    applicability: { groups: [{ rules: [exactWall], combinator: 'AND' }], authoredAs: 'chips' },
    requirement: { kind: 'element', block: { groups: [{ rules: requirement, combinator: 'AND' }], authoredAs: 'chips' } },
  };
}

/** The oracle rule set, its numeric operands in the model's own units (`k` per metre). */
const ruleSetFor = (k: 1 | 1000): RuleSetFile => ({
  version: 1,
  name: 'oracle',
  rules: [
    rule('fire-eq', [Rule.property('Pset_WallCommon', 'FireRating', 'eq', '2HR')]),
    rule('fire-set', [Rule.property('Pset_WallCommon', 'FireRating', 'isSet', '')]),
    rule('fire-contains', [Rule.property('Pset_WallCommon', 'FireRating', 'contains', 'HR')]),
    rule('name-regex', [Rule.name('matches', '^Wall [AB]$', 'regex')]),
    rule('name-regex-unanchored', [Rule.name('matches', '\\d{3}', 'regex')]),
    rule('name-starts', [Rule.name('startsWith', 'Wall')]),
    rule('description-set', [Rule.attribute('Description', 'isSet', '')]),
    rule('width-between', [
      Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gte', 0.25 * k),
      Rule.quantity('Qto_WallBaseQuantities', 'Width', 'lte', 0.35 * k),
    ]),
    rule('width-gt', [Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gt', 0.2 * k)]),
    rule('height-gte', [Rule.property('Pset_Dims', 'Height', 'gte', String(2 * k))]),
    rule('fire-and-name', [Rule.property('Pset_WallCommon', 'FireRating', 'eq', '2HR'), Rule.name('contains', 'Wall')]),
  ],
});

const verdicts = (spec: { entityResults: ReadonlyArray<{ globalId?: string; passed: boolean }> }) =>
  Object.fromEntries(spec.entityResults.map((e) => [e.globalId, e.passed]));

async function idsVerdicts(xml: string, store: IfcDataStore) {
  return validateIDS(parseIDS(xml), createDataAccessor(store), {
    modelId: 'm1',
    schemaVersion: 'IFC4',
    entityCount: store.entityCount,
  });
}

describe('exported IDS gives the rule engine\'s verdicts (#5225)', () => {
  for (const k of [1, 1000] as const) {
    it(`every exported rule passes and fails the same elements under the IDS validator (${k === 1 ? 'metres' : 'millimetres'})`, async () => {
      const store = await parse(k);
      const ruleSet = ruleSetFor(k);
      const models = [{ id: 'm1', store }];
      // Model-unit operands are written to the IDS in SI, converted with the
      // unit the model stores each value in (#5225 decision).
      const exported = ruleSetToIds(ruleSet, { models });
      assert.deepEqual(exported.refused, []);

      const ruleReport = await runRuleSet({ ruleSet, models });
      const idsReport = await idsVerdicts(exported.xml!, store);
      assert.equal(idsReport.specificationResults.length, ruleSet.rules.length);
      ruleSet.rules.forEach((r, i) => {
        const fromRules = verdicts(ruleReport.specificationResults[i]);
        const fromIds = verdicts(idsReport.specificationResults[i]);
        assert.equal(Object.keys(fromRules).length, 4, `${r.id}: the four exact IfcWalls are applicable`);
        assert.deepEqual(fromIds, fromRules, `${r.id}: IDS and rule verdicts differ`);
      });
    });
  }

  it('the same IDS imported back runs in SI on a millimetre model and agrees with the IDS validator', async () => {
    const store = await parse(1000);
    const models = [{ id: 'm1', store }];
    const xml = ruleSetToIds(ruleSetFor(1000), { models }).xml!;
    const imported = idsToRuleSet(parseIDS(xml));
    assert.ok(imported.file);
    const ruleReport = await runRuleSet({ ruleSet: imported.file, models });
    const idsReport = await idsVerdicts(xml, store);
    imported.file.rules.forEach((r, i) => {
      assert.deepEqual(verdicts(ruleReport.specificationResults[i]), verdicts(idsReport.specificationResults[i]), `${r.name}: verdicts differ`);
    });
    // The millimetre model fails a stored-unit reading of the SI bound:
    // Wall A's 300 mm width must pass "Width >= 0.25" only because it is compared in SI.
    const widthRule = imported.file.rules.find((r) => r.name === 'width-between');
    assert.ok(widthRule);
    const wallA = ruleReport.specificationResults[imported.file.rules.indexOf(widthRule)].entityResults.find((e) => e.entityName === 'Wall A');
    assert.equal(wallA?.passed, true);
  });

  it('refuses a model-unit numeric rule without models, and when the models store it in different units', async () => {
    const ruleSet = ruleSetFor(1);
    const noModels = ruleSetToIds(ruleSet);
    assert.ok(noModels.refused.some((r) => r.ruleId === 'width-gt' && r.reasons.some((x) => /needs a loaded model/.test(x))));
    const mixed = ruleSetToIds(ruleSet, { models: [{ id: 'm', store: await parse(1) }, { id: 'mm', store: await parse(1000) }] });
    assert.ok(mixed.refused.some((r) => r.ruleId === 'width-gt' && r.reasons.some((x) => /different units/.test(x))));
    // Unit-free checks are unaffected.
    assert.ok(mixed.exportedRuleIds.includes('fire-eq'));
  });
});
