/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS report layouts (#6470): the original layout for documents saved without
 * a `variant`, `compact` bars, and `long` text that wraps instead of being cut.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { composeDocument, estimateTextWidth } from './compose.js';
import { idsReportBlockFromReport } from './ids-report.js';
import { DOCUMENT_VERSION, validateDocumentSpec, type IdsReportBlock } from './types.js';

const LONG = 'The property FireRating in the property set Pset_WallCommon must exist and must be one of the enumerated values 30, 60, 90 or 120 minutes';

function block(variant?: IdsReportBlock['variant']): IdsReportBlock {
  return {
    kind: 'ids-report', id: 'ids', ...(variant ? { variant } : {}), sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
    summary: { checked: 7972, passed: 70, failed: 7902, passRate: 1 },
    checks: [{
      id: 'walls', shortDescription: 'Walls', checked: 7972, passed: 70, failed: 7902, passRate: 1,
      rules: [
        { id: 'r1', name: 'FireRating', shortDescription: LONG, checked: 7972, passed: 70, failed: 7902, passRate: 1 },
        { id: 'r2', shortDescription: 'Legacy rule without a name', checked: 7972, passed: null, failed: null, passRate: null },
      ],
    }],
  };
}

function compose(ids: IdsReportBlock, width = 'portrait' as const) {
  const layout = composeDocument({ name: 'Doc', page: { size: 'A4', orientation: width }, generatedAt: 'now', measure: estimateTextWidth, blocks: [ids] });
  const items = layout.pages.flatMap((page) => page.items);
  return {
    texts: items.flatMap((item) => (item.kind === 'text' ? [item] : [])),
    rects: items.flatMap((item) => (item.kind === 'rect' ? [item] : [])),
  };
}

describe('IDS report layouts in the PDF composer (#6470)', () => {
  it('without a variant keeps the original layout: one truncated line, no bars', () => {
    const { texts, rects } = compose(block());
    assert.equal(rects.length, 0);
    assert.ok(!texts.some((t) => t.text === LONG), 'the long requirement is cut with an ellipsis');
    assert.ok(texts.some((t) => t.text.startsWith('The property FireRating') && t.text.endsWith('…')));
  });

  it('long wraps the full requirement text over several lines, losing no words', () => {
    const { texts, rects } = compose(block('long'));
    assert.equal(rects.length, 0);
    const lines = texts.filter((t) => t.size === 8.5 && t.bold).map((t) => t.text).filter((t) => t !== 'Legacy rule without a name');
    assert.ok(lines.length > 1, 'wrapped');
    assert.equal(lines.join(' ').replace(/\s+/g, ' ').trim(), LONG);
    assert.ok(!texts.some((t) => t.text.includes('…')));
  });

  it('compact prints one row per check and requirement with a bar, showing only the property name', () => {
    const { texts, rects } = compose(block('compact'));
    assert.ok(texts.some((t) => t.text === 'Walls'));
    assert.ok(texts.some((t) => t.text === 'FireRating'), 'the bare property name');
    assert.ok(!texts.some((t) => t.text.includes('must exist')), 'no requirement sentence');
    assert.ok(texts.some((t) => t.text === '70/7972 · 1%'));
    assert.ok(texts.some((t) => t.text === 'n/a'), 'partial report rows have no percent');
    // check and named rule each get a track and a fill, the unavailable rule only a track
    assert.equal(rects.length, 5);
    const fills = rects.filter((r) => r.rgb[0] === 239);
    assert.equal(fills.length, 2, 'a 1% pass rate is in the red band');
  });
});

describe('IDS report snapshot (#6470)', () => {
  it('names a requirement by its property and refreshing keeps the chosen layout', () => {
    const entityResults: SpecificationResult['entityResults'] = [
      { expressId: 1, modelId: 'm', entityType: 'IfcWall', passed: true, requirementResults: [
        { requirement: { id: 'r1', label: LONG, optionality: 'required' }, status: 'pass', facetType: 'property', checkedDescription: LONG },
      ] },
    ];
    const spec = { id: 's', name: 'Walls', ifcVersions: ['IFC4'], applicability: { facets: [] }, requirements: [
      { id: 'r1', optionality: 'required', facet: { type: 'property', propertySet: { type: 'simpleValue', value: 'Pset_WallCommon' }, baseName: { type: 'simpleValue', value: 'FireRating' } } },
    ] };
    const report = {
      source: { kind: 'ids', document: { info: { title: 'Design IDS' }, specifications: [spec] } },
      modelInfo: [], timestamp: new Date('2026-01-15T10:00:00.000Z'),
      summary: { totalSpecifications: 1, passedSpecifications: 1, failedSpecifications: 0, totalEntitiesChecked: 1, totalEntitiesPassed: 1, totalEntitiesFailed: 0, overallPassRate: 100 },
      specificationResults: [{ specification: spec, status: 'pass', applicableCount: 1, passedCount: 1, failedCount: 0, passRate: 100, entityResults }],
    } as unknown as ValidationReport;
    const compact = idsReportBlockFromReport(report, 'b', 'compact');
    assert.equal(compact.variant, 'compact');
    assert.equal(compact.checks[0].rules[0].name, 'FireRating');
    assert.equal(compact.checks[0].rules[0].shortDescription, LONG);
    assert.equal('variant' in idsReportBlockFromReport(report, 'b'), false, 'no variant unless one is chosen');
  });

  it('a per-requirement rate of 70 of 7,972 reads 1%, not 0%', () => {
    const spec = { id: 's', name: 'Walls' };
    const req = { id: 'r1', label: 'FireRating', optionality: 'required' };
    const entityResults = Array.from({ length: 7972 }, (_, i) => ({
      expressId: i, modelId: 'm', entityType: 'IfcWall', passed: i < 70,
      requirementResults: [{ requirement: req, status: i < 70 ? 'pass' : 'fail', facetType: 'property', checkedDescription: 'x' }],
    }));
    const report = {
      source: { kind: 'ids', document: { info: { title: 'Rules' }, specifications: [] } }, modelInfo: [], timestamp: new Date(0),
      summary: {}, specificationResults: [{ specification: spec, status: 'fail', applicableCount: 7972, passedCount: 70, failedCount: 7902, passRate: 1, entityResults }],
    } as unknown as ValidationReport;
    const out = idsReportBlockFromReport(report, 'b');
    assert.equal(out.summary.passRate, 1);
    assert.equal(out.checks[0].rules[0].passRate, 1);
  });
});

describe('IDS report block validation (#6470)', () => {
  const doc = (ids: unknown) => ({ version: DOCUMENT_VERSION, id: 'd', name: 'IDS', page: { size: 'A4', orientation: 'portrait' }, blocks: [ids] });

  it('accepts no variant (older documents), compact and long; rejects anything else', () => {
    assert.deepEqual(validateDocumentSpec(doc(block())), []);
    assert.deepEqual(validateDocumentSpec(doc(block('compact'))), []);
    assert.deepEqual(validateDocumentSpec(doc(block('long'))), []);
    assert.deepEqual(validateDocumentSpec(doc({ ...block(), variant: 'wide' })).map((e) => e.path), ['blocks[0].variant']);
  });
});
