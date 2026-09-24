/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `modelFact` (#5442): georeferencing, project units and STEP header fields
 * as a rule subject every value op works on, in search, validation, the
 * rule-set file and the requirement text.
 *
 * GEO: a millimetre model with an IfcMapConversion to "EPSG:2056" (eastings
 * 2600000), authored by "Jane" in "ACME CAD".
 * PLAIN: a metre model with no georeferencing and an empty header author.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { isFilterRule, type FilterRule } from './filter-rules.js';
import { readModelFact } from './filter-model-fact.js';
import { runRuleSet } from '../engine/rule-engine.js';
import { parseRuleSetFile } from '../rule-set/rule-set-io.js';
import { parseRequirementText, requirementToText } from '../rule-set/requirement-text.js';
import type { RuleSetFile } from '../rule-set/rule-set.js';
import { ruleSetToIds } from '../ids/rule-set-to-ids.js';

const GEO = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('geo.ifc','2026-01-01T00:00:00',('Jane'),('ACME'),'pre','ACME CAD','auth');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Geo',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#40= IFCPROJECTEDCRS('EPSG:2056',$,'CH1903+',$,$,$,$);
#41= IFCMAPCONVERSION(#20,#40,2600000.,1200000.,400.,$,$,$);
#50= IFCWALL('0Wall000000000000000050',$,'W',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const PLAIN = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('plain.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000002',$,'Plain',$,$,$,$,$,#30);
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#50= IFCWALL('0Wall000000000000000051',$,'W',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function matchesWall(text: string, rule: FilterRule): Promise<boolean> {
  const walls: FilterRule = { kind: 'ifcType', op: 'in', values: ['IfcWall'] };
  return evaluateFilterRules('m', await parse(text), [walls, rule], 'AND').length === 1;
}

describe('model facts (#5442)', () => {
  it('reads georeferencing, units and header fields', async () => {
    const geo = await parse(GEO);
    assert.deepEqual(readModelFact(geo, 'georef.crs'), ['EPSG:2056']);
    assert.deepEqual(readModelFact(geo, 'georef.eastings'), [2600000]);
    assert.deepEqual(readModelFact(geo, 'units.length'), ['mm']);
    assert.deepEqual(readModelFact(geo, 'header.author'), ['Jane']);
    assert.deepEqual(readModelFact(geo, 'header.originatingSystem'), ['ACME CAD']);
    assert.deepEqual(readModelFact(geo, 'header.schema'), ['IFC4']);
    const plain = await parse(PLAIN);
    assert.deepEqual(readModelFact(plain, 'georef.crs'), []);
    assert.deepEqual(readModelFact(plain, 'units.length'), ['m']);
    assert.deepEqual(readModelFact(plain, 'header.author'), []);
  });

  it('every value op works on a fact in search', async () => {
    assert.equal(await matchesWall(GEO, { kind: 'modelFact', fact: 'georef.crs', op: 'isSet', value: '' }), true);
    assert.equal(await matchesWall(PLAIN, { kind: 'modelFact', fact: 'georef.crs', op: 'isSet', value: '' }), false);
    assert.equal(await matchesWall(PLAIN, { kind: 'modelFact', fact: 'georef.crs', op: 'isNotSet', value: '' }), true);
    assert.equal(await matchesWall(GEO, { kind: 'modelFact', fact: 'units.length', op: 'eq', value: 'mm' }), true);
    assert.equal(await matchesWall(GEO, { kind: 'modelFact', fact: 'georef.eastings', op: 'gt', value: '2500000' }), true);
    assert.equal(await matchesWall(GEO, { kind: 'modelFact', fact: 'header.originatingSystem', op: 'contains', value: 'CAD' }), true);
    assert.equal(await matchesWall(GEO, { kind: 'modelFact', fact: 'georef.crs', op: 'matches', value: '^EPSG:\\d+$', valueKind: 'regex' }), true);
  });

  it('validates "the project is georeferenced and in millimetres" per model', async () => {
    const parsed = parseRuleSetFile({
      version: 1, name: 'model checks',
      rules: [{
        id: 'g', name: 'Georeferenced, mm',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcProject'] }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [
          { kind: 'modelFact', fact: 'georef.crs', op: 'isSet', value: '' },
          { kind: 'modelFact', fact: 'units.length', op: 'eq', value: 'mm' },
        ], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    });
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    const report = await runRuleSet({ ruleSet: parsed.file, models: [{ id: 'geo', store: await parse(GEO) }, { id: 'plain', store: await parse(PLAIN) }] });
    const verdicts = Object.fromEntries(report.specificationResults[0].entityResults.map((e) => [e.modelId, e.passed]));
    assert.deepEqual(verdicts, { geo: true, plain: false });
    const plainRow = report.specificationResults[0].entityResults.find((e) => e.modelId === 'plain');
    assert.equal(plainRow?.requirementResults[0].facetType, 'model');
    assert.equal(plainRow?.requirementResults[0].failureReason, 'absent');
  });

  it('is a subject with a text spelling, rejects unknown facts, and is refused by the IDS export', () => {
    const text = 'unique(model.header.author)';
    const parsedText = parseRequirementText(text);
    assert.ok(parsedText.ok);
    assert.deepEqual(parsedText.requirement, { kind: 'unique', subject: { kind: 'modelFact', fact: 'header.author' } });
    assert.equal(requirementToText(parsedText.requirement), text);
    assert.equal(isFilterRule({ kind: 'modelFact', fact: 'georef.crs', op: 'isSet', value: '' }), true);
    assert.equal(isFilterRule({ kind: 'modelFact', fact: 'georef.nope', op: 'isSet', value: '' }), false);
    const file: RuleSetFile = {
      version: 1, name: 'x',
      rules: [{
        id: 'r', name: 'r',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcProject'], exactClass: true }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [{ kind: 'modelFact', fact: 'georef.crs', op: 'isSet', value: '' }], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    };
    assert.ok(ruleSetToIds(file).refused[0].reasons.some((r) => /model-level fact/.test(r)));
  });
});
