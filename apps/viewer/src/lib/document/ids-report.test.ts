/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `idsReportBlockFromReport` (#5125) is a pure mapping from a
 * `ValidationReport` to an `IdsReportBlock`, but before this file it was
 * referenced only by `BlockEditor.tsx` and `DocumentPanel.tsx` — no test
 * called it. Two mutations survived unnoticed as a result: swapping
 * `passed`/`failed` in the per-check mapping, and breaking the
 * zero-checked-entities guard so the pass rate divides by zero.
 *
 * The fixtures below are built directly, not through a real IDS
 * validation run — this is a pure mapping and is tested as one. Every
 * fixture keeps `passed !== failed` and mixes specs with and without a
 * `description`, on purpose: a fixture with `passed === failed` or where
 * every spec has a description cannot tell a correct mapping from a
 * swapped or invented one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { idsReportBlockFromReport } from './ids-report.js';

/** A `SpecificationResult` with deliberately distinct passed/failed counts, so a passed/failed swap is detectable. */
function spec(overrides: Partial<SpecificationResult> & { id: string; name: string }): SpecificationResult {
  return {
    specification: { id: overrides.id, name: overrides.name, description: overrides.description },
    status: 'fail',
    applicableCount: overrides.applicableCount ?? 0,
    passedCount: overrides.passedCount ?? 0,
    failedCount: overrides.failedCount ?? 0,
    passRate: overrides.passRate ?? 0,
    entityResults: [],
  } as SpecificationResult;
}

function report(specificationResults: SpecificationResult[]): ValidationReport {
  return {
    source: { kind: 'rules', ruleSet: { name: 'Test Rule Set' } },
    modelInfo: [],
    timestamp: new Date('2026-01-15T10:00:00.000Z'),
    // `idsReportBlockFromReport` recomputes the summary from `specificationResults`
    // via `calculateSummary` — this field is never read, so it is left zeroed
    // rather than duplicating that computation here.
    summary: {
      totalSpecifications: 0,
      passedSpecifications: 0,
      failedSpecifications: 0,
      totalEntitiesChecked: 0,
      totalEntitiesPassed: 0,
      totalEntitiesFailed: 0,
      overallPassRate: 0,
    },
    specificationResults,
  };
}

describe('idsReportBlockFromReport', () => {
  it('maps each check with passed and failed in the right fields (asymmetric counts catch a swap)', () => {
    // 3 passed / 7 failed: swapping the two fields in the mapping changes the
    // output, unlike a fixture where passed === failed would.
    const fireRating = spec({
      id: 'spec-fire-rating',
      name: 'Fire rating present',
      description: 'Every wall must declare a fire rating',
      applicableCount: 10,
      passedCount: 3,
      failedCount: 7,
      passRate: 30,
    });
    const block = idsReportBlockFromReport(report([fireRating]), 'block-1');

    assert.equal(block.kind, 'ids-report');
    assert.equal(block.id, 'block-1');
    assert.equal(block.sourceName, 'Test Rule Set');
    assert.equal(block.generatedAt, '2026-01-15T10:00:00.000Z');
    assert.equal(block.checks.length, 1);
    const check = block.checks[0];
    assert.equal(check.id, 'spec-fire-rating');
    assert.equal(check.checked, 10);
    assert.equal(check.passed, 3);
    assert.equal(check.failed, 7);
    assert.equal(check.passRate, 30);
  });

  it('takes the short description from the specification name and the long one from its description', () => {
    const withDescription = spec({
      id: 'spec-with-desc',
      name: 'Load-bearing flag',
      description: 'Structural walls must be marked load-bearing',
      applicableCount: 4,
      passedCount: 1,
      failedCount: 3,
      passRate: 25,
    });
    const block = idsReportBlockFromReport(report([withDescription]), 'block-2');
    const check = block.checks[0];
    assert.equal(check.shortDescription, 'Load-bearing flag');
    assert.equal(check.longDescription, 'Structural walls must be marked load-bearing');
  });

  it('carries longDescription as undefined, not an invented empty string, when the specification has no description', () => {
    const noDescription = spec({
      id: 'spec-no-desc',
      name: 'Naming convention',
      description: undefined,
      applicableCount: 2,
      passedCount: 2,
      failedCount: 0,
      passRate: 100,
    });
    const block = idsReportBlockFromReport(report([noDescription]), 'block-3');
    const check = block.checks[0];
    assert.equal(check.shortDescription, 'Naming convention');
    assert.equal(check.longDescription, undefined);
    assert.notEqual(check.longDescription, '');
  });

  it('reports a 100 pass rate, never NaN, when no entities were checked (zero-checked-entities guard)', () => {
    const zeroChecked = spec({
      id: 'spec-zero',
      name: 'Unreachable rule',
      applicableCount: 0,
      passedCount: 0,
      failedCount: 0,
      passRate: 100,
    });
    const block = idsReportBlockFromReport(report([zeroChecked]), 'block-4');

    assert.equal(block.summary.checked, 0);
    assert.equal(block.summary.passed, 0);
    assert.equal(block.summary.failed, 0);
    assert.equal(block.summary.passRate, 100);
    assert.equal(Number.isNaN(block.summary.passRate), false);
  });

  it('sums checked/passed/failed and floors the overall pass rate across more than one specification', () => {
    // 3 passed / 7 failed and 5 passed / 0 failed: totals are 8 passed, 7
    // failed out of 15 checked. floor(8/15*100) = 53, not the average of
    // the two specs' own pass rates (30 and 100) and not a round number
    // that a bug in the summation would coincidentally also produce.
    const fireRating = spec({
      id: 'spec-fire-rating',
      name: 'Fire rating present',
      description: 'Every wall must declare a fire rating',
      applicableCount: 10,
      passedCount: 3,
      failedCount: 7,
      passRate: 30,
    });
    const loadBearing = spec({
      id: 'spec-load-bearing',
      name: 'Load-bearing flag',
      applicableCount: 5,
      passedCount: 5,
      failedCount: 0,
      passRate: 100,
    });
    const block = idsReportBlockFromReport(report([fireRating, loadBearing]), 'block-5');

    assert.equal(block.checks.length, 2);
    assert.equal(block.summary.checked, 15);
    assert.equal(block.summary.passed, 8);
    assert.equal(block.summary.failed, 7);
    assert.equal(block.summary.passRate, 53);
  });
});
