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
import '@/test/content-fixture.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { idsReportBlockFromReport } from './ids-report.js';
import { composeDocument, estimateTextWidth } from './compose.js';
import { validateDocumentSpec, DOCUMENT_VERSION, type IdsReportBlock } from './types.js';

/** A `SpecificationResult` with deliberately distinct passed/failed counts, so a passed/failed swap is detectable. */
function spec(overrides: Partial<SpecificationResult> & { id: string; name: string; description?: string }): SpecificationResult {
  return {
    specification: { id: overrides.id, name: overrides.name, description: overrides.description },
    status: overrides.status ?? 'fail',
    applicableCount: overrides.applicableCount ?? 0,
    passedCount: overrides.passedCount ?? 0,
    failedCount: overrides.failedCount ?? 0,
    passRate: overrides.passRate ?? 0,
    entityResults: overrides.entityResults ?? [],
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
  it('includes per-rule child rows with source descriptions and distinct pass/fail counts (#5125)', () => {
    const entityResults: SpecificationResult['entityResults'] = [
      { expressId: 1, modelId: 'm', entityType: 'IfcWall', passed: true, requirementResults: [
        { requirement: { id: 'r1', label: 'Fire rating', optionality: 'required' }, status: 'pass', facetType: 'property', checkedDescription: 'Check fire rating' },
        { requirement: { id: 'r2', label: 'Load bearing', optionality: 'required' }, status: 'pass', facetType: 'property', checkedDescription: 'Check structure' },
      ] },
      { expressId: 2, modelId: 'm', entityType: 'IfcWall', passed: false, requirementResults: [
        { requirement: { id: 'r1', label: 'Fire rating', optionality: 'required' }, status: 'fail', facetType: 'property', checkedDescription: 'Check fire rating' },
        { requirement: { id: 'r2', label: 'Load bearing', optionality: 'required' }, status: 'pass', facetType: 'property', checkedDescription: 'Check structure' },
      ] },
    ];
    const idsReport = report([spec({ id: 's1', name: 'Walls', applicableCount: 2, passedCount: 1, failedCount: 1, entityResults })]);
    idsReport.source = { kind: 'ids', document: { info: { title: 'Design IDS' }, specifications: [{
      id: 's1', name: 'Walls', ifcVersions: ['IFC4'], applicability: { facets: [] },
      requirements: [
        { id: 'r1', optionality: 'required', facet: { type: 'property', propertySet: { type: 'simpleValue', value: 'Pset' }, baseName: { type: 'simpleValue', value: 'FireRating' } }, description: 'Must survive 90 minutes' },
        { id: 'r2', optionality: 'required', facet: { type: 'property', propertySet: { type: 'simpleValue', value: 'Pset' }, baseName: { type: 'simpleValue', value: 'LoadBearing' } }, description: 'Structural support' },
      ],
    }] } };

    const rules = idsReportBlockFromReport(idsReport, 'block-rules').checks[0].rules;
    assert.deepEqual(rules.map((rule) => ({ id: rule.id, checked: rule.checked, passed: rule.passed, failed: rule.failed, passRate: rule.passRate })), [
      { id: 'r1', checked: 2, passed: 1, failed: 1, passRate: 50 },
      { id: 'r2', checked: 2, passed: 2, failed: 0, passRate: 100 },
    ]);
    assert.equal(rules[0].shortDescription, 'Fire rating');
    assert.equal(rules[0].longDescription, 'Must survive 90 minutes');
  });

  it('marks per-rule metrics unavailable when passing entities were omitted from the source report', () => {
    const entityResults: SpecificationResult['entityResults'] = [
      { expressId: 2, modelId: 'm', entityType: 'IfcWall', passed: false, requirementResults: [
        { requirement: { id: 'r1', label: 'Fire rating', optionality: 'required' }, status: 'fail', facetType: 'property', checkedDescription: 'Check fire rating' },
      ] },
    ];
    // An IDS report: a rule-set rule is its own single requirement and gets no child row at all (#6372).
    const partial = report([spec({ id: 's1', name: 'Walls', applicableCount: 2, passedCount: 1, failedCount: 1, entityResults })]);
    partial.source = { kind: 'ids', document: { info: { title: 'Design IDS' }, specifications: [] } };
    const rules = idsReportBlockFromReport(partial, 'partial').checks[0].rules;
    assert.deepEqual(rules.map((rule) => [rule.checked, rule.passed, rule.failed, rule.passRate]), [[2, null, null, null]]);
  });

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
      status: 'pass',
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

/**
 * #6372 gave the block a second source kind. The IDS side must print exactly
 * what it printed before: these pin the whole IDS snapshot and every PDF line
 * it lays out, including a single-requirement specification (which, unlike a
 * rule-set rule, keeps its requirement child row) and a failures-only report.
 */
describe('IDS report output is unchanged by the information-validation kind (#6372)', () => {
  function idsFixture(): ValidationReport {
    const requirementResult = (id: string, label: string, status: 'pass' | 'fail') => ({
      requirement: { id, label, optionality: 'required' as const }, status, facetType: 'property' as const, checkedDescription: `Check ${label}`,
    });
    const walls = spec({ id: 's1', name: 'Walls', description: 'Every wall', applicableCount: 2, passedCount: 1, failedCount: 1, passRate: 50, entityResults: [
      { expressId: 1, modelId: 'm', entityType: 'IfcWall', passed: true, requirementResults: [requirementResult('r1', 'Fire rating', 'pass')] },
      { expressId: 2, modelId: 'm', entityType: 'IfcWall', passed: false, requirementResults: [requirementResult('r1', 'Fire rating', 'fail')] },
    ] });
    const slabs = spec({ id: 's2', name: 'Slabs', applicableCount: 3, passedCount: 2, failedCount: 1, passRate: 66, entityResults: [
      { expressId: 3, modelId: 'm', entityType: 'IfcSlab', passed: false, requirementResults: [requirementResult('r2', 'Load bearing', 'fail')] },
    ] });
    const fixture = report([walls, slabs]);
    fixture.source = { kind: 'ids', document: { info: { title: 'Design IDS' }, specifications: [] } };
    return fixture;
  }

  it('snapshots an IDS report with the same fields as before, labelled ids', () => {
    const block = idsReportBlockFromReport(idsFixture(), 'b');
    assert.deepEqual(block, {
      kind: 'ids-report', id: 'b', sourceKind: 'ids', sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
      summary: { checked: 5, passed: 3, failed: 2, passRate: 60 },
      checks: [
        { id: 's1', shortDescription: 'Walls', longDescription: 'Every wall', checked: 2, passed: 1, failed: 1, passRate: 50,
          rules: [{ id: 'r1', shortDescription: 'Fire rating', longDescription: 'Check Fire rating', checked: 2, passed: 1, failed: 1, passRate: 50 }] },
        { id: 's2', shortDescription: 'Slabs', longDescription: undefined, checked: 3, passed: 2, failed: 1, passRate: 66,
          rules: [{ id: 'r2', shortDescription: 'Load bearing', longDescription: 'Check Load bearing', checked: 3, passed: null, failed: null, passRate: null }] },
      ],
    });
  });

  it('prints the same PDF lines for a new IDS snapshot and for a block saved before sourceKind existed', () => {
    const block = idsReportBlockFromReport(idsFixture(), 'b');
    const { sourceKind: _dropped, ...legacy } = block;
    void _dropped;
    const expected = [
      'IDS report: Design IDS',
      'Checked 5 · Passed 3 · Failed 2 · 60% passed',
      'Validation run: 2026-01-15T10:00:00.000Z',
      'Walls', 'Every wall', 'Checked 2 · Passed 1 · Failed 1 · 50%',
      'Fire rating', 'Check Fire rating', 'Checked 2 · Passed 1 · Failed 1 · 50%',
      'Slabs', 'Checked 3 · Passed 2 · Failed 1 · 66%',
      'Load bearing', 'Check Load bearing', 'Checked 3 · Passed/failed unavailable (partial report)',
    ];
    for (const printed of [block, legacy as IdsReportBlock]) {
      const layout = composeDocument({ name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth, blocks: [printed] });
      const lines = layout.pages.flatMap((page) => page.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])));
      // The page footer is the document's, not the block's.
      assert.deepEqual(lines.slice(0, expected.length), expected);
    }
  });

  it('accepts a saved block with or without sourceKind at the same document version, and rejects an unknown kind', () => {
    const block = idsReportBlockFromReport(idsFixture(), 'b');
    const doc = (b: unknown) => ({ version: DOCUMENT_VERSION, id: 'd', name: 'D', page: { size: 'A4', orientation: 'portrait' }, blocks: [b] });
    const { sourceKind: _dropped, ...legacy } = block;
    void _dropped;
    assert.deepEqual(validateDocumentSpec(doc(block)), []);
    assert.deepEqual(validateDocumentSpec(doc(legacy)), []);
    assert.deepEqual(validateDocumentSpec(doc({ ...block, sourceKind: 'bcf' })).map((e) => e.path), ['blocks[0].sourceKind']);
    assert.deepEqual(validateDocumentSpec(doc({ ...block, checks: [{ ...block.checks[0], severity: 'info' }] })).map((e) => e.path), ['blocks[0].checks[0].severity']);
  });
});
