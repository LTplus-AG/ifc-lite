/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `runRuleSet` — targeting by `sourceFingerprint` across two federated
 * models (#5138 PR 3, plan §4 item 9, `RuleSetTargets.modelFingerprints`).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { runRuleSet, resolveTargetModels } from './rule-engine.js';
import type { InformationRule, RuleSetFile } from '../rule-set/rule-set.js';
import { Rule } from '../filter/filter-rules.js';
import type { EvaluatorModel } from '../filter/filter-evaluate.js';

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

function stateFor(models: { id: string; fingerprint?: string; store: IfcDataStore }[]): EvaluatorModel[] {
  return models.map((m) => ({ id: m.id, filterIdentity: m.fingerprint, store: m.store }));
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
  it('uses effective classes and entity counts independently for two edited models (#5249)', async () => {
    const storeA = await parseWall('0WallA0000000000000000A', 'Wall in A');
    const storeB = await parseWall('0WallB0000000000000000B', 'Wall in B');
    const viewA = new MutablePropertyView(null, 'm1');
    const viewB = new MutablePropertyView(null, 'm2');
    viewA.setExpressIdWatermark(100);
    viewB.setExpressIdWatermark(100);
    viewA.deleteEntity(100);
    viewB.setEntityType(100, 'IfcDoor', undefined, 'IfcWall');
    const createdA = viewA.createEntity('IfcWall', ['0NewWallA0000000000001', '$', 'New A', '$', '$', '#40', '$', 'tag', '$']);
    const createdB = viewB.createEntity('IfcWall', ['0NewWallB0000000000001', '$', 'New B', '$', '$', '#40', '$', 'tag', '$']);
    const ruleSet = allWallsRuleSet();
    ruleSet.rules[0].applicability.groups[0].rules[0] = {
      kind: 'ifcType', values: ['IfcWall'], op: 'in', exactClass: true,
    };

    const report = await runRuleSet({ ruleSet, models: [
      { id: 'm1', store: storeA, mutationView: viewA },
      { id: 'm2', store: storeB, mutationView: viewB },
    ] });
    assert.deepEqual(report.modelInfo.map(({ modelId, entityCount }) => [modelId, entityCount]), [
      ['m1', storeA.entityCount], // one source delete and one authored create
      ['m2', storeB.entityCount + 1], // retype preserves the source row
    ]);
    assert.deepEqual(report.specificationResults[0].entityResults.map(({ modelId, expressId }) => [modelId, expressId]), [
      ['m1', createdA.expressId], ['m2', createdB.expressId],
    ]);
  });

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

  it('targets naming a fingerprint that matches NO loaded model report `error` on every rule, never a silent not_applicable pass (#5138 PR 7b review)', async () => {
    // A caller's `filterIdentity` can legitimately fail to match a rule
    // set's saved `targets.modelFingerprints` — e.g. the CLI hashing the
    // model differently than the viewer did when the set was authored.
    // That mismatch must read as UNEVALUATED, not as a clean pass: with
    // zero applicable entities and no min/maxApplicable cardinality, the
    // old behaviour was `status: 'not_applicable'` for every rule, which a
    // caller's exit-code logic could not distinguish from "genuinely
    // nothing to check".
    const storeA = await parseWall('0WallA0000000000000000A', 'Wall in A');
    const state = stateFor([{ id: 'm1', fingerprint: 'fp-a', store: storeA }]);

    const report = await runRuleSet({ ruleSet: allWallsRuleSet({ modelFingerprints: ['fp-does-not-exist'] }), models: state });
    assert.equal(report.modelInfo.length, 0);
    assert.equal(report.specificationResults.length, 1);
    const spec = report.specificationResults[0];
    assert.equal(spec.error, 'no loaded model matches the rule set targets');
    assert.equal(spec.status, 'fail');
    assert.equal(spec.applicableCount, 0);
  });

  it('empty/absent targets still resolve to every loaded model (unresolved-targets error is scoped to DECLARED targets)', async () => {
    const storeA = await parseWall('0WallA0000000000000000A', 'Wall in A');
    const state = stateFor([{ id: 'm1', fingerprint: 'fp-a', store: storeA }]);

    const report = await runRuleSet({ ruleSet: allWallsRuleSet(undefined), models: state });
    assert.equal(report.specificationResults[0].error, undefined);
    assert.equal(report.specificationResults[0].applicableCount, 1);
  });
});
