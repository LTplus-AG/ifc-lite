/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IDSEntityResult, IDSRequirementResult, IDSRequirement } from '@ifc-lite/ids';
import { groupRequirementResults, computeCheckStats } from './idsRequirementGrouping.js';

/**
 * Contract tests for the IDS panel's requirement-grouping helpers.
 *
 * The IDSPanel used to only expose `requirementResults` inside a
 * per-entity expander — the same defect the HTML export had. These
 * helpers re-slice a specification's entity results by requirement so a
 * user can see, per requirement, how many checks passed/failed and which
 * elements failed, without drilling into every entity individually.
 */

function makeRequirement(id: string): IDSRequirement {
  return {
    id,
    facet: { type: 'attribute', name: { simpleValue: 'Name' } } as unknown as IDSRequirement['facet'],
    optionality: 'required',
  };
}

const fireRating = makeRequirement('req-0');
const certificateRef = makeRequirement('req-1');
const width = makeRequirement('req-2');

function reqResult(
  requirement: IDSRequirement,
  status: IDSRequirementResult['status'],
  overrides: Partial<IDSRequirementResult> = {}
): IDSRequirementResult {
  return {
    requirement,
    status,
    facetType: 'attribute',
    checkedDescription: `Checks ${requirement.id}`,
    ...overrides,
  };
}

function entity(
  expressId: number,
  requirementResults: IDSRequirementResult[],
  overrides: Partial<IDSEntityResult> = {}
): IDSEntityResult {
  return {
    expressId,
    modelId: 'model-1',
    entityType: 'IfcDoor',
    entityName: `Door ${expressId}`,
    globalId: `GID-${expressId}`,
    passed: requirementResults.every((r) => r.status !== 'fail'),
    requirementResults,
    ...overrides,
  };
}

describe('groupRequirementResults', () => {
  it('groups per-entity requirement results by requirement, not by entity', () => {
    // 3 doors, each checked against 2 requirements (fire rating, width).
    const entities: IDSEntityResult[] = [
      entity(1, [reqResult(fireRating, 'pass'), reqResult(width, 'pass')]),
      entity(2, [reqResult(fireRating, 'fail', { failureReason: 'Missing FireRating' }), reqResult(width, 'pass')]),
      entity(3, [reqResult(fireRating, 'pass'), reqResult(width, 'fail', { failureReason: 'Width too small' })]),
    ];

    const groups = groupRequirementResults(entities);

    assert.strictEqual(groups.length, 2, 'one group per requirement, not per entity');
    const byKey = new Map(groups.map((g) => [g.key, g]));

    const fireGroup = byKey.get('req-0')!;
    assert.strictEqual(fireGroup.passedCount, 2);
    assert.strictEqual(fireGroup.failedCount, 1);
    assert.strictEqual(fireGroup.failingEntities.length, 1);
    assert.strictEqual(fireGroup.failingEntities[0].expressId, 2);
    assert.strictEqual(fireGroup.failingEntities[0].failureReason, 'Missing FireRating');

    const widthGroup = byKey.get('req-2')!;
    assert.strictEqual(widthGroup.passedCount, 2);
    assert.strictEqual(widthGroup.failedCount, 1);
    assert.strictEqual(widthGroup.failingEntities[0].expressId, 3);
  });

  it('does not count not_applicable as a pass, in either the group counts or its rate', () => {
    // certificateRef is only applicable to 2 of 3 doors.
    const entities: IDSEntityResult[] = [
      entity(1, [reqResult(certificateRef, 'not_applicable')]),
      entity(2, [reqResult(certificateRef, 'pass')]),
      entity(3, [reqResult(certificateRef, 'fail', { failureReason: 'No certificate' })]),
    ];

    const [group] = groupRequirementResults(entities);

    assert.strictEqual(group.notApplicableCount, 1);
    assert.strictEqual(group.passedCount, 1);
    assert.strictEqual(group.failedCount, 1);
    // Rate is passed / (passed + failed) = 1/2 = 50, NOT 1/3 (which would
    // silently treat not_applicable as a passing check) and NOT 2/3
    // (which would silently treat it as a failing one).
    assert.strictEqual(group.passRate, 50);
  });

  it('grouping is order-independent of pre-filtering: not_applicable entities still register in the right group', () => {
    // Regression guard for the "grouping trap": filtering not_applicable
    // OUT before grouping would misalign per-requirement counts. Here we
    // deliberately interleave entities whose FIRST requirement result is
    // not_applicable to prove the grouping keys off requirement id, not
    // array position filtered by status.
    const entities: IDSEntityResult[] = [
      entity(1, [reqResult(certificateRef, 'not_applicable'), reqResult(width, 'pass')]),
      entity(2, [reqResult(certificateRef, 'pass'), reqResult(width, 'fail', { failureReason: 'too narrow' })]),
    ];

    const groups = groupRequirementResults(entities);
    assert.strictEqual(groups.length, 2);

    const widthGroup = groups.find((g) => g.key === 'req-2')!;
    assert.strictEqual(widthGroup.passedCount, 1);
    assert.strictEqual(widthGroup.failedCount, 1);
    assert.strictEqual(widthGroup.failingEntities[0].expressId, 2);
  });
});

describe('computeCheckStats', () => {
  it('check-level pass rate legitimately differs from (and is <=) an entity-level rate', () => {
    // 3 doors x 3 requirements = 9 checks. Only 1 check fails, but it's
    // spread across a single entity, so entity-level (2/3 = 67%) and
    // check-level (8/9 = 88%) intentionally disagree.
    const entities: IDSEntityResult[] = [
      entity(1, [reqResult(fireRating, 'pass'), reqResult(certificateRef, 'pass'), reqResult(width, 'pass')]),
      entity(2, [reqResult(fireRating, 'pass'), reqResult(certificateRef, 'pass'), reqResult(width, 'pass')]),
      entity(3, [
        reqResult(fireRating, 'fail', { failureReason: 'Missing FireRating' }),
        reqResult(certificateRef, 'pass'),
        reqResult(width, 'pass'),
      ]),
    ];

    const stats = computeCheckStats(entities);
    assert.strictEqual(stats.passedChecks, 8);
    assert.strictEqual(stats.failedChecks, 1);
    assert.strictEqual(stats.checkPassRate, 88);

    // Entity-level rate computed the way the validator computes
    // specification.passRate (passed entities / total entities, floored).
    const passedEntities = entities.filter((e) => e.passed).length;
    const entityPassRate = Math.floor((passedEntities / entities.length) * 100);
    assert.strictEqual(entityPassRate, 66);
    assert.notStrictEqual(stats.checkPassRate, entityPassRate);
  });

  it('excludes not_applicable checks from both the numerator and denominator', () => {
    const entities: IDSEntityResult[] = [
      entity(1, [reqResult(certificateRef, 'not_applicable')]),
      entity(2, [reqResult(certificateRef, 'not_applicable')]),
      entity(3, [reqResult(certificateRef, 'pass')]),
    ];

    const stats = computeCheckStats(entities);
    assert.strictEqual(stats.notApplicableChecks, 2);
    assert.strictEqual(stats.passedChecks, 1);
    assert.strictEqual(stats.failedChecks, 0);
    // 1/1 applicable check passed = 100%, not 1/3 (33%).
    assert.strictEqual(stats.checkPassRate, 100);
  });

  it('defaults to a 100% rate when there are no applicable checks at all', () => {
    const entities: IDSEntityResult[] = [entity(1, [reqResult(certificateRef, 'not_applicable')])];
    const stats = computeCheckStats(entities);
    assert.strictEqual(stats.checkPassRate, 100);
  });
});
