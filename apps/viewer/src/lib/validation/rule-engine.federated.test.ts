/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `runRuleSet` — targeting by `sourceFingerprint` across two federated
 * models (#5138 PR 3, plan §4 item 9, `RuleSetTargets.modelFingerprints`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { runRuleSet, resolveTargetModels } from './rule-engine.js';
import type { InformationRule, RuleSetFile } from './rule-set.js';
import { Rule } from '../search/filter-rules.js';
import type { ModelTagState } from '../model-tags/evaluator-models.js';

function wallStep(globalId: string, name: string): string {
  return `ISO-10303-21;
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
#100= IFCWALL('${globalId}',$,'${name}',$,$,#40,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;
}

async function parseWall(globalId: string, name: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(wallStep(globalId, name));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function stateFor(models: { id: string; fingerprint?: string; store: IfcDataStore }[]): ModelTagState {
  return {
    models: new Map(models.map((m) => [m.id, { id: m.id, sourceFingerprint: m.fingerprint, ifcDataStore: m.store }])),
    modelTags: new Map(),
    modelTagAssignments: new Map(),
  };
}

function allWallsRuleSet(targets?: RuleSetFile['targets']): RuleSetFile {
  const rule: InformationRule = {
    id: 'r1', name: 'all walls',
    applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
    requirement: { kind: 'element', block: { groups: [{ rules: [Rule.name('contains', '')], combinator: 'AND' }], authoredAs: 'chips' } },
  };
  return { version: 1, name: 'test', rules: [rule], targets };
}

describe('runRuleSet — federated targeting by sourceFingerprint (#5138)', () => {
  it('resolveTargetModels narrows to the fingerprint named in targets.modelFingerprints', async () => {
    const storeA = await parseWall('0WallA0000000000000000A', 'Wall in A');
    const storeB = await parseWall('0WallB0000000000000000B', 'Wall in B');
    const state = stateFor([
      { id: 'm1', fingerprint: 'fp-a', store: storeA },
      { id: 'm2', fingerprint: 'fp-b', store: storeB },
    ]);

    const onlyA = resolveTargetModels(state, { modelFingerprints: ['fp-a'] });
    assert.deepEqual(onlyA.map((m) => m.id), ['m1']);

    const both = resolveTargetModels(state, undefined);
    assert.deepEqual(both.map((m) => m.id).sort(), ['m1', 'm2']);
  });

  it('runRuleSet reports modelInfo and entity rows for both federated models by default, one when targeted', async () => {
    const storeA = await parseWall('0WallA0000000000000000A', 'Wall in A');
    const storeB = await parseWall('0WallB0000000000000000B', 'Wall in B');
    const state = stateFor([
      { id: 'm1', fingerprint: 'fp-a', store: storeA },
      { id: 'm2', fingerprint: 'fp-b', store: storeB },
    ]);

    const both = await runRuleSet({ ruleSet: allWallsRuleSet(), models: state });
    assert.equal(both.modelInfo.length, 2);
    const bothSpec = both.specificationResults[0];
    assert.equal(bothSpec.applicableCount, 2);
    assert.ok(bothSpec.entityResults.some((e) => e.modelId === 'm1'));
    assert.ok(bothSpec.entityResults.some((e) => e.modelId === 'm2'));

    const targeted = await runRuleSet({ ruleSet: allWallsRuleSet({ modelFingerprints: ['fp-a'] }), models: state });
    assert.equal(targeted.modelInfo.length, 1);
    assert.equal(targeted.modelInfo[0].modelId, 'm1');
    const targetedSpec = targeted.specificationResults[0];
    assert.equal(targetedSpec.applicableCount, 1);
    assert.ok(targetedSpec.entityResults.every((e) => e.modelId === 'm1'));
  });
});
