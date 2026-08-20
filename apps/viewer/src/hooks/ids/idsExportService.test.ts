/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the requirement-level HTML report restructuring.
 *
 * The IDS report has three nested levels: specification -> requirement ->
 * check (one entity measured against one requirement). These tests build
 * minimal, fully-typed `IDSValidationReport` fixtures — not run through the
 * real validator — and assert on the rendered HTML string, because the
 * report is a presentation layer over already-computed validation results
 * and the thing that ships to a reader IS the markup.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  IDSEntityFacet,
  IDSEntityResult,
  IDSRequirement,
  IDSRequirementResult,
  IDSSpecification,
  IDSSpecificationResult,
  IDSValidationReport,
} from '@ifc-lite/ids';
import { buildReportHTML } from './idsExportService.js';

// ----------------------------------------------------------------------------
// Fixture builders — minimal, fully-typed, no validator involved.
// ----------------------------------------------------------------------------

function makeFacet(name = 'IFCWALL'): IDSEntityFacet {
  return { type: 'entity', name: { type: 'simpleValue', value: name } };
}

function makeRequirement(id: string, description = 'Entity check'): IDSRequirement {
  return { id, facet: makeFacet(), optionality: 'required', description };
}

function makeReqResult(
  requirement: IDSRequirement,
  status: 'pass' | 'fail' | 'not_applicable',
  overrides: Partial<IDSRequirementResult> = {},
): IDSRequirementResult {
  return {
    requirement,
    status,
    facetType: 'entity',
    checkedDescription: overrides.checkedDescription ?? requirement.description ?? 'check',
    failureReason: overrides.failureReason,
    actualValue: overrides.actualValue,
    expectedValue: overrides.expectedValue,
  };
}

function makeEntity(
  expressId: number,
  requirementResults: IDSRequirementResult[],
  overrides: Partial<IDSEntityResult> = {},
): IDSEntityResult {
  return {
    expressId,
    modelId: overrides.modelId ?? 'model-1',
    entityType: overrides.entityType ?? 'IfcWall',
    entityName: overrides.entityName,
    globalId: overrides.globalId,
    passed: requirementResults.every(r => r.status !== 'fail'),
    requirementResults,
  };
}

function makeSpecification(id: string, name: string, requirements: IDSRequirement[]): IDSSpecification {
  return {
    id,
    name,
    ifcVersions: ['IFC4'],
    applicability: { facets: [makeFacet()] },
    requirements,
  };
}

function makeSpecResult(specification: IDSSpecification, entityResults: IDSEntityResult[]): IDSSpecificationResult {
  const applicableCount = entityResults.length;
  const passedCount = entityResults.filter(e => e.passed).length;
  const failedCount = applicableCount - passedCount;
  const passRate = applicableCount > 0 ? Math.floor((passedCount / applicableCount) * 100) : 100;
  const status: IDSSpecificationResult['status'] =
    applicableCount === 0 ? 'not_applicable' : failedCount > 0 ? 'fail' : 'pass';
  return { specification, status, applicableCount, passedCount, failedCount, passRate, entityResults };
}

function makeReport(specResults: IDSSpecificationResult[]): IDSValidationReport {
  const totalSpecifications = specResults.length;
  const passedSpecifications = specResults.filter(s => s.status === 'pass').length;
  const failedSpecifications = specResults.filter(s => s.status === 'fail').length;
  const totalEntitiesChecked = specResults.reduce((s, sp) => s + sp.applicableCount, 0);
  const totalEntitiesPassed = specResults.reduce((s, sp) => s + sp.passedCount, 0);
  const totalEntitiesFailed = specResults.reduce((s, sp) => s + sp.failedCount, 0);
  return {
    document: { info: { title: 'Test IDS' }, specifications: specResults.map(s => s.specification) },
    modelInfo: { modelId: 'model-1', schemaVersion: 'IFC4', entityCount: 1000 },
    timestamp: new Date('2026-01-01T00:00:00Z'),
    summary: {
      totalSpecifications,
      passedSpecifications,
      failedSpecifications,
      totalEntitiesChecked,
      totalEntitiesPassed,
      totalEntitiesFailed,
      overallPassRate: totalEntitiesChecked > 0 ? Math.round((totalEntitiesPassed / totalEntitiesChecked) * 100) : 100,
    },
    specificationResults: specResults,
  };
}

function extractRate(html: string, label: string): number {
  const re = new RegExp(`rate-value">(\\d+)%</span>\\s*<span class="rate-label">${label}`);
  const m = html.match(re);
  if (!m) throw new Error(`rate not found for label: ${label}`);
  return Number(m[1]);
}

// ----------------------------------------------------------------------------

describe('buildReportHTML — requirement-level grouping', () => {
  it('computes check-level, entity-level, and specification-level pass rates independently, and they legitimately diverge', () => {
    const reqA = makeRequirement('req-a', 'Requirement A');
    const reqB = makeRequirement('req-b', 'Requirement B');
    // 100 entities, 2 requirements each. Entities 0 and 1 fail requirement A
    // only (requirement B always passes) — so 2 of 100 entities fail the
    // specification, but only 2 of 200 individual checks fail.
    const spec0Entities = Array.from({ length: 100 }, (_, i) =>
      makeEntity(
        i,
        [
          makeReqResult(reqA, i < 2 ? 'fail' : 'pass', i < 2 ? { failureReason: 'bad wall' } : {}),
          makeReqResult(reqB, 'pass'),
        ],
        { entityName: `Wall ${i}`, globalId: `GID-${i}` },
      ),
    );
    const spec0 = makeSpecResult(makeSpecification('spec-0', 'Mostly Passing Spec', [reqA, reqB]), spec0Entities);

    const otherSpecs = [1, 2, 3].map(n => {
      const req = makeRequirement(`req-${n}`);
      const entities = Array.from({ length: 10 }, (_, i) =>
        makeEntity(i, [makeReqResult(req, 'pass')], { entityName: `E${n}-${i}`, globalId: `G${n}-${i}` }),
      );
      return makeSpecResult(makeSpecification(`spec-${n}`, `Passing Spec ${n}`, [req]), entities);
    });

    const report = makeReport([spec0, ...otherSpecs]);
    const html = buildReportHTML(report, 'en');

    // Check level (finest): 198 of 200 element-requirement checks in spec-0,
    // plus 30 of 30 in the other specs = 228 of 230 = 99%.
    const checkRate = extractRate(html, 'Check pass rate');
    assert.equal(checkRate, 99);

    // Entity level: an entity passes only if ALL its requirements pass, so
    // the 2 entities failing requirement A fail entirely — 128 of 130 = 98%.
    const entityRate = extractRate(html, 'Entity pass rate');
    assert.equal(entityRate, 98);

    // Specification level (coarsest): spec-0 has 2 failing entities and so
    // fails outright — only 3 of 4 specifications fully passed = 75%.
    const specRate = extractRate(html, 'Specification pass rate');
    assert.equal(specRate, 75);

    assert.notEqual(checkRate, entityRate, 'check and entity rates must be shown independently, not conflated');
    assert.notEqual(entityRate, specRate, 'entity and specification rates must be shown independently, not conflated');
    assert.notEqual(checkRate, specRate, 'check and specification rates must be shown independently, not conflated');
  });

  it('does not count a not_applicable requirement result as a pass', () => {
    const req = makeRequirement('req-na');
    const naEntity = makeEntity(1, [makeReqResult(req, 'not_applicable')], {
      entityName: 'NA Wall',
      globalId: 'GID-NA',
    });
    const passEntity = makeEntity(2, [makeReqResult(req, 'pass')], {
      entityName: 'Pass Wall',
      globalId: 'GID-PASS',
    });
    const spec = makeSpecResult(makeSpecification('spec-na', 'NA Spec', [req]), [naEntity, passEntity]);
    const report = makeReport([spec]);
    const html = buildReportHTML(report, 'en');

    // Exactly one real check (the pass); the not_applicable result must not
    // inflate either the passed count or the denominator.
    assert.match(
      html,
      /<span class="pass-count">1<\/span>\/<span class="total-count">1<\/span> checks passed \(100%\)/,
    );
    assert.match(html, /1 not applicable/);
    assert.ok(
      !/<span class="total-count">2<\/span>/.test(html),
      'not_applicable must not be counted toward the checked total',
    );
  });

  it('truncates a requirement failing across many entities, grouping by type and stating the hidden count', () => {
    const req = makeRequirement('req-bulk');
    const entities = Array.from({ length: 300 }, (_, i) =>
      makeEntity(i, [makeReqResult(req, 'fail', { failureReason: `Missing FireRating on wall ${i}` })], {
        entityType: 'IfcWall',
        entityName: `Wall ${i}`,
        globalId: `GID-fail-${i}`,
      }),
    );
    const spec = makeSpecResult(makeSpecification('spec-bulk', 'Bulk Fail Spec', [req]), entities);
    const report = makeReport([spec]);
    const html = buildReportHTML(report, 'en');

    assert.match(html, /Showing 5 of 300 IfcWall failures/);
    assert.match(html, /Showing 5 of 300 failing elements for this requirement \(295 hidden\)/);

    const failuresBlock = html.match(/<div class="req-group-failures">([\s\S]*?)<\/table>/);
    assert.ok(failuresBlock, 'requirement failures block must be present');
    const rowCount = (failuresBlock![1].match(/<tr class="entity-row"/g) ?? []).length;
    assert.equal(rowCount, 5, 'only ~5 example rows are rendered per type, not all 300');

    // The examples shown are the first 5 encountered, not an arbitrary slice.
    assert.ok(failuresBlock![1].includes('GID-fail-0'));
    assert.ok(failuresBlock![1].includes('GID-fail-4'));
    assert.ok(!failuresBlock![1].includes('GID-fail-5'), 'the 6th example must be hidden, not shown');
  });

  it('HTML-escapes every interpolated value used in a requirement failure', () => {
    const req = makeRequirement('req-esc', 'Name must not contain <script>');
    const evilName = `<script>alert(1)</script>"'`;
    const entity = makeEntity(
      1,
      [makeReqResult(req, 'fail', { failureReason: `Bad name: ${evilName}` })],
      { entityName: evilName, globalId: `GID"'<script>` },
    );
    const spec = makeSpecResult(makeSpecification('spec-esc', 'Spec <b>bold</b>', [req]), [entity]);
    const report = makeReport([spec]);
    const html = buildReportHTML(report, 'en');

    assert.ok(!html.includes('<script>alert(1)</script>'), 'a raw <script> tag must never appear unescaped');
    assert.ok(!html.includes('<b>bold</b>'), 'the specification name must be escaped, not raw HTML');

    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'entity name is escaped');
    assert.ok(html.includes('Spec &lt;b&gt;bold&lt;/b&gt;'), 'specification name is escaped');
    assert.ok(html.includes('Bad name: &lt;script&gt;alert(1)&lt;/script&gt;'), 'failure reason is escaped');
    assert.ok(html.includes('Name must not contain &lt;script&gt;'), 'checkedDescription is escaped');
  });
});
