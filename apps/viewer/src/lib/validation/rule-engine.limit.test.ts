/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `runRuleSet` must see EVERY applicable element, not the search UI's
 * 5 000-row result cap (#5138 PR 3, plan §4 item 1: `limit: Number.
 * MAX_SAFE_INTEGER`). A generated 6 000-`IfcWall` model is the only way to
 * tell "capped at 5 000" from "uncapped" apart from a correctness bug.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { runRuleSet } from './rule-engine.js';
import type { InformationRule, RuleSetFile } from './rule-set.js';
import { Rule } from '../search/filter-rules.js';
import type { ModelTagState } from '../model-tags/evaluator-models.js';

const WALL_COUNT = 6_000;

function generateWallsStep(count: number): string {
  const lines: string[] = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);",
    "#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);",
    '#21= IFCAXIS2PLACEMENT3D(#22,$,$);',
    '#22= IFCCARTESIANPOINT((0.,0.,0.));',
    '#30= IFCUNITASSIGNMENT((#31));',
    '#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    '#40= IFCLOCALPLACEMENT($,#21);',
  ];
  // GlobalIds must be valid 22-char IFC base64-ish identifiers; a
  // zero-padded numeric suffix keeps them unique and simple to generate.
  for (let i = 0; i < count; i++) {
    const id = 1000 + i;
    const gid = `0Wall${String(i).padStart(17, '0')}`;
    lines.push(`#${id}= IFCWALL('${gid}',$,'Wall ${i}',$,$,#40,$,'tag',$);`);
  }
  lines.push('ENDSEC;', 'END-ISO-10303-21;', '');
  return lines.join('\n');
}

async function parseGeneratedWalls(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(generateWallsStep(WALL_COUNT));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function stateFor(store: IfcDataStore): ModelTagState {
  return {
    models: new Map([['m1', { id: 'm1', sourceFingerprint: undefined, ifcDataStore: store }]]),
    modelTags: new Map(),
    modelTagAssignments: new Map(),
  };
}

describe('runRuleSet — no 5 000-row search cap (#5138)', () => {
  it(`applicableCount === ${WALL_COUNT} on a generated model, above the search UI's DEFAULT_LIMIT`, async () => {
    const store = await parseGeneratedWalls();
    const rule: InformationRule = {
      id: 'r1', name: 'every wall',
      applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ rules: [Rule.name('contains', '')], combinator: 'AND' }], authoredAs: 'chips' } },
    };
    const ruleSet: RuleSetFile = { version: 1, name: 'test', rules: [rule] };
    const report = await runRuleSet({ ruleSet, models: stateFor(store) });
    assert.equal(report.specificationResults[0].applicableCount, WALL_COUNT);
    assert.equal(report.specificationResults[0].entityResults.length, WALL_COUNT);
  });
});
