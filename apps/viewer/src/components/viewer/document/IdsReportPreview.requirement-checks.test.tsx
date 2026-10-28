/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8204: the IDS report block (preview and PDF) printed only entity rates,
 * so a specification whose entities each miss one of eleven requirements read
 * 0/128 · 0% while the panel card read 90% for the same run, and specifications
 * that matched nothing printed 0/0 · 0%. The report now uses the panel's units.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateIDS, type IDSDocument } from '@ifc-lite/ids';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { composeDocument, estimateTextWidth } from '@/lib/document/compose';
import { idsReportBlockFromReport } from '@/lib/document/ids-report';
import type { IdsReportBlock } from '@/lib/document/types';
import { cleanup, render } from '@/test/render.js';
import { IdsReportPreview } from './IdsReportPreview.js';

afterEach(cleanup);

function pdfTexts(block: IdsReportBlock): string[] {
  const layout = composeDocument({ name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth, blocks: [block] });
  return layout.pages.flatMap((page) => page.items).flatMap((item) => (item.kind === 'text' ? [item.text] : []));
}

/** 128 entities each pass ten of eleven requirements: 0% of entities, 90% of checks (the reporter's specification). */
const rules = Array.from({ length: 11 }, (_, i) => ({
  id: `r${i}`, name: `Property${i}`, shortDescription: `Property${i}`, checked: 128,
  passed: i === 10 ? 0 : 128, failed: i === 10 ? 128 : 0, passRate: i === 10 ? 0 : 100,
}));
const synthetic: IdsReportBlock = {
  kind: 'ids-report', id: 'ids', variant: 'compact', benchmarks: true, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 128, passed: 0, failed: 128, passRate: 0 },
  checks: [
    { id: 'walls', shortDescription: 'Walls', checked: 128, passed: 0, failed: 128, passRate: 0, rules },
    { id: 'rails', shortDescription: 'Rails', checked: 0, passed: 0, failed: 0, passRate: 0,
      rules: [{ id: 'tag', name: 'Tag', shortDescription: 'Tag', checked: 0, passed: 0, failed: 0, passRate: 0 }] },
  ],
};
const rowText = (ui: HTMLElement, spec: string) => ui.querySelector(`[data-ids-report-spec="${spec}"] > ul > [data-ids-report-row]`)?.textContent ?? '';

describe('IDS report requirement checks (#8204)', () => {
  it('compact preview rates a specification by its requirement checks and names unmatched ones Not checked', () => {
    const ui = render(<IdsReportPreview block={synthetic} />);
    assert.match(rowText(ui, 'walls'), /1,280\/1,408 · 90%$/);
    assert.ok(ui.querySelector('[data-ids-report-spec="walls"] [data-ids-report-bar="90"]'));
    assert.match(rowText(ui, 'rails'), /Not checked$/);
    const rails = ui.querySelector('[data-ids-report-spec="rails"]')?.textContent ?? '';
    assert.doesNotMatch(rails, /0\/0/, 'neither the specification nor its requirement reads 0/0 · 0%');
    assert.equal(ui.querySelector('[data-ids-report-requirement-checks]')?.textContent, '1,280/1,408 checks passed (90%)');
    assert.match(ui.textContent ?? '', /2 specifications/);
    assert.doesNotMatch(ui.textContent ?? '', /2 checks/);
  });

  it('classic preview keeps the entity verdict beside the requirement checks', () => {
    const ui = render(<IdsReportPreview block={{ ...synthetic, variant: undefined }} />);
    const walls = ui.querySelector('[data-ids-report-check="walls"]')?.textContent ?? '';
    assert.match(walls, /128 · 0 \/ 128 · 1,280\/1,408 checks passed \(90%\)/);
    assert.match(ui.querySelector('[data-ids-report-check="rails"]')?.textContent ?? '', /Not checked/);
  });

  it('the PDF prints the same units as the preview', () => {
    const texts = pdfTexts(synthetic);
    assert.ok(texts.includes('1280/1408 checks passed (90%)'), 'block summary line');
    assert.ok(texts.some((text) => text === '1280/1408 · 90%' || text === '90%'), 'specification bar label');
    assert.ok(!texts.some((text) => /^0\/0 · 0%$/.test(text)), 'no unmatched 0/0 · 0% rows');
    assert.equal(texts.filter((text) => text === 'Not checked').length, 2, 'unmatched specification and its requirement');
    const classic = pdfTexts({ ...synthetic, variant: undefined });
    assert.ok(classic.some((text) => text.endsWith('Failed 128 · 1280/1408 checks passed (90%)')));
  });

  it('falls back to the entity rate when a requirement count is unavailable, and leaves rule sets alone', () => {
    const partial: IdsReportBlock = { ...synthetic, checks: [{ ...synthetic.checks[0],
      rules: [...rules.slice(0, 10), { ...rules[10], passed: null, failed: null, passRate: null }] }] };
    const ui = render(<IdsReportPreview block={partial} />);
    assert.match(rowText(ui, 'walls'), /0\/128 · 0%$/);
    assert.equal(ui.querySelector('[data-ids-report-requirement-checks]'), null);
    assert.ok(!pdfTexts(partial).some((text) => text.includes('checks passed')));
    cleanup();
    const rulesBlock: IdsReportBlock = { ...synthetic, sourceKind: 'rules', checks: [synthetic.checks[0], { ...synthetic.checks[1], rules: [] }] };
    const rulesUi = render(<IdsReportPreview block={rulesBlock} />);
    assert.match(rowText(rulesUi, 'walls'), /0\/128 · 0%$/);
    assert.match(rowText(rulesUi, 'rails'), /0\/0 · 0%$/, 'a rule set has no IDS unmatched state');
    assert.match(rulesUi.textContent ?? '', /2 checks/);
    assert.equal(rulesUi.querySelector('[data-ids-report-requirement-checks]'), null);
  });
});

// The second run gives both requirements one id: IDS ids need not be unique, and the row must still count every check (#8204 review).
for (const ids of [['global-id', 'missing-property'], ['same', 'same']]) it(`reports real SketchUp IFC validation in the panel units with requirement ids ${ids.join(', ')} (#8204)`, async () => {
  const bytes = readFileSync(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
  const document: IDSDocument = {
    info: { title: 'Report regression' },
    specifications: ['IFCWALL', 'IFCRAIL'].map((entityType) => ({
      id: entityType, name: entityType, ifcVersions: ['IFC4'],
      applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: entityType } }] },
      requirements: [
        { id: ids[0], optionality: 'required', facet: { type: 'attribute', name: { type: 'simpleValue', value: 'GlobalId' } } },
        { id: ids[1], optionality: 'required', facet: { type: 'property',
          propertySet: { type: 'simpleValue', value: 'Regression_8204_Absent' }, baseName: { type: 'simpleValue', value: 'Missing' } } },
      ],
    })),
  };
  const report = await validateIDS(document, createDataAccessor(store, 'model'),
    { modelId: 'model', schemaVersion: 'IFC4', entityCount: store.entityIndex.byId.size });
  const walls = report.specificationResults[0];
  assert.ok(walls.applicableCount > 0);
  assert.equal(walls.passedCount, 0, 'every wall misses the absent property');
  assert.equal(report.specificationResults[1].applicableCount, 0);
  const block = { ...idsReportBlockFromReport(report, 'ids', 'compact'), benchmarks: true };
  const n = walls.applicableCount;
  const ui = render(<IdsReportPreview block={block} />);
  assert.match(rowText(ui, 'IFCWALL'), new RegExp(`${n}/${2 * n} · 50%$`), 'half of the requirement checks pass');
  assert.match(rowText(ui, 'IFCRAIL'), /Not checked$/);
  assert.equal(ui.querySelector('[data-ids-report-requirement-checks]')?.textContent, `${n}/${2 * n} checks passed (50%)`);
  assert.ok(pdfTexts(block).includes(`${n}/${2 * n} checks passed (50%)`));
});

it('counts each specification from its own requirements when two specifications share an id (#8204 review)', async () => {
  const bytes = readFileSync(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
  const globalId = { id: 'r', optionality: 'required' as const, facet: { type: 'attribute' as const, name: { type: 'simpleValue' as const, value: 'GlobalId' } } };
  const missing = { id: 'q', optionality: 'required' as const, facet: { type: 'property' as const,
    propertySet: { type: 'simpleValue' as const, value: 'Regression_8204_Absent' }, baseName: { type: 'simpleValue' as const, value: 'Missing' } } };
  const wall = { type: 'entity' as const, name: { type: 'simpleValue' as const, value: 'IFCWALL' } };
  const document: IDSDocument = { info: { title: 'Shared ids' }, specifications: [
    { id: 'dup', name: 'First', ifcVersions: ['IFC4'], applicability: { facets: [wall] }, requirements: [globalId, globalId, missing] },
    { id: 'dup', name: 'Second', ifcVersions: ['IFC4'], applicability: { facets: [wall] }, requirements: [globalId, missing] },
  ] };
  const report = await validateIDS(document, createDataAccessor(store, 'model'),
    { modelId: 'model', schemaVersion: 'IFC4', entityCount: store.entityIndex.byId.size });
  const n = report.specificationResults[0].applicableCount;
  assert.ok(n > 0);
  const ui = render(<IdsReportPreview block={idsReportBlockFromReport(report, 'ids', 'compact')} />);
  const rows = [...ui.querySelectorAll('[data-ids-report-spec="dup"] > ul > [data-ids-report-row]')].map((row) => row.textContent ?? '');
  assert.equal(rows.length, 2);
  assert.match(rows[0], new RegExp(`${2 * n}/${3 * n} · 66%$`));
  assert.match(rows[1], new RegExp(`${n}/${2 * n} · 50%$`), 'the second specification is not measured against the first one’s requirements');
});
