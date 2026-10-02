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
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec, type IdsReportBlock } from './types.js';
import { parseDocumentFile } from './persistence.js';
import { PAGE_SIZES_PT, REPORT_MARGIN } from '../export/report/compose.js';
import type { DrawnItem } from './compose.js';

// Read dynamically, with a fallback that fails by assertion, so the file still loads without the production change.
const idsReportExports: { replaceIdsReportSnapshot?: (current: IdsReportBlock, snapshot: IdsReportBlock) => IdsReportBlock } = await import('./ids-report.js');
const replaceIdsReportSnapshot = idsReportExports.replaceIdsReportSnapshot ?? ((_current: IdsReportBlock, snapshot: IdsReportBlock) => snapshot);

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
    const fills = rects.filter((r) => r.color === '#ef4444');
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

/** Ten specifications with twenty requirements each: the long report #6560 describes. */
function manySpecifications(specificationsOnly?: boolean): IdsReportBlock {
  const ids = block('compact');
  if (specificationsOnly !== undefined) ids.specificationsOnly = specificationsOnly;
  ids.checks = Array.from({ length: 10 }, (_, s) => ({
    id: `s${s}`, shortDescription: `Spec ${s}`, checked: 63, passed: 55, failed: 8, passRate: 87,
    rules: Array.from({ length: 20 }, (_, r) => ({ id: `s${s}r${r}`, name: `Req ${s}.${r}`, shortDescription: `Req ${s}.${r}`, checked: 63, passed: 63, failed: 0, passRate: 100 })),
  }));
  return ids;
}

describe('compact IDS report with specifications only (#6560)', () => {
  it('prints one bar row per specification and no requirement rows', () => {
    const { texts, rects } = compose(manySpecifications(true));
    assert.equal(texts.filter((t) => /^Spec \d$/.test(t.text)).length, 10);
    assert.equal(texts.filter((t) => t.text.startsWith('Req ')).length, 0, 'no requirement rows');
    assert.equal(texts.filter((t) => t.text === '55/63 · 87%').length, 10, 'each specification keeps its own pass rate');
    assert.equal(rects.length, 20, 'a track and a fill per specification');
  });

  it('is much shorter than the same report with requirements', () => {
    const pages = (ids: IdsReportBlock) => composeDocument({ name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth, blocks: [ids] }).pages.length;
    assert.equal(pages(manySpecifications(true)), 1);
    assert.ok(pages(manySpecifications()) > 1, 'with requirements it spills onto further pages');
  });

  it('applies only to the compact layout', () => {
    const ids = manySpecifications(true);
    ids.variant = 'long';
    assert.ok(compose(ids).texts.some((t) => t.text.startsWith('Req ')), 'the long layout still lists requirements');
  });

  it('is validated as a boolean, and absent in documents saved before it existed', () => {
    const doc = (ids: unknown) => ({ version: DOCUMENT_VERSION, id: 'd', name: 'IDS', page: { size: 'A4', orientation: 'portrait' }, blocks: [ids] });
    assert.deepEqual(validateDocumentSpec(doc({ ...block('compact'), specificationsOnly: true })), []);
    assert.deepEqual(validateDocumentSpec(doc(block('compact'))), []);
    assert.deepEqual(validateDocumentSpec(doc({ ...block('compact'), specificationsOnly: 'yes' })).map((e) => e.path), ['blocks[0].specificationsOnly']);
  });
});

describe('IDS report layout edge cases (review of #6494)', () => {
  it('long paginates a requirement taller than a page without leaving the printable area', () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ');
    const ids = block('long');
    ids.checks[0].rules[0].shortDescription = huge;
    const layout = composeDocument({ name: 'Doc', page: { size: 'A4', orientation: 'landscape' }, generatedAt: 'now', measure: estimateTextWidth, blocks: [ids] });
    assert.ok(layout.pages.length >= 2);
    for (const page of layout.pages) for (const item of page.items) assert.ok(item.y <= layout.size.h - 40, `y=${item.y} on page ${page.index}`);
    const words = layout.pages.flatMap((p) => p.items.flatMap((i) => (i.kind === 'text' && i.size === 8.5 ? i.text.split(' ') : []))).filter((w) => /^word\d+$/.test(w));
    assert.equal(words.length, 4000);
  });

  it('compact marks a warning check in the PDF', () => {
    const ids = block('compact');
    ids.checks[0].severity = 'warning';
    assert.ok(compose(ids).texts.some((t) => t.text === '(Warning) Walls'));
  });

  it('compact keeps only the percent when the counts would overflow the label column', () => {
    const ids = block('compact');
    ids.checks[0] = { ...ids.checks[0], checked: 123456789, passed: 123456788, failed: 1, passRate: 99 };
    const { texts } = compose(ids);
    assert.ok(texts.some((t) => t.text === '99%'), 'percent only');
    assert.ok(!texts.some((t) => t.text.includes('123456788/')), 'no overflowing counts');
  });
});

describe('compact IDS report separates specifications from requirements (#6550)', () => {
  it('leaves a larger gap before the next specification than between a specification and its requirements', () => {
    const ids = block('compact');
    const rule = (id: string, name: string) => ({ id, name, shortDescription: name, checked: 6, passed: 6, failed: 0, passRate: 100 });
    ids.checks = [
      { ...ids.checks[0], id: 'a', shortDescription: 'Geschoss', rules: [rule('r1', 'Status')] },
      { ...ids.checks[0], id: 'b', shortDescription: 'Raum', rules: [rule('r2', 'Raumname')] },
    ];
    const { texts } = compose(ids);
    const at = (label: string) => texts.find((t) => t.text === label)!;
    const intoRequirements = at('Status').y - at('Geschoss').y;
    const nextSpecification = at('Raum').y - at('Status').y;
    assert.ok(nextSpecification > intoRequirements, `specification gap ${nextSpecification} must exceed in-group gap ${intoRequirements}`);
    assert.ok(at('Status').x > at('Geschoss').x, 'requirements are indented');
  });
});

/**
 * The stamp of an IDS / information-validation block (#6678): the run time and the evaluated
 * models, hidden together by `showStamp: false`, exactly like the manual block's (#6566).
 * One block kind serves both sources, so each is composed here.
 */
const SCOPE = ['discipline-architecture-coordination-model-delivery-final.ifc', 'discipline-structure-coordination-model-delivery-final.ifc'];
function stamped(sourceKind: 'ids' | 'rules', variant: IdsReportBlock['variant'], extra: Partial<IdsReportBlock> = {}): IdsReportBlock {
  const base = block(variant);
  return { ...base, sourceKind, sourceName: sourceKind === 'rules' ? 'Quality rules' : 'Design IDS', reportModels: SCOPE.map((name, i) => ({ name, fingerprint: `fp-${i}` })), ...extra };
}
const compose2 = (ids: IdsReportBlock, page: DocumentSpec['page'] = { size: 'A4', orientation: 'portrait' }) =>
  composeDocument({ name: 'Doc', page, generatedAt: 'now', measure: estimateTextWidth, blocks: [ids] }).pages.flatMap((p) => p.items);
const words = (items: DrawnItem[]) => items.flatMap((item) => (item.kind === 'text' ? [item.text] : []));
// The models row wraps over several lines when long, so a continuation line is a fragment of the scope text.
const SCOPE_TEXT = `Models: ${SCOPE.join(', ')}`;
const isStamp = (text: string) => text.startsWith('Validation run:') || SCOPE_TEXT.includes(text);

/** Where a drawn item ends: a text by its measured width at its drawn size, a ring or box by its extent. */
function extent(item: DrawnItem): { right: number; bottom: number } {
  if (item.kind === 'text') return { right: item.x + estimateTextWidth(item.text, item.size, item.bold), bottom: item.y };
  if (item.kind === 'ring') return { right: item.x + item.size, bottom: item.y + item.size };
  if ('w' in item && 'h' in item) return { right: item.x + item.w, bottom: item.y + item.h };
  return { right: item.x, bottom: item.y };
}

describe('IDS and information-validation report stamps (#6678)', () => {
  for (const sourceKind of ['ids', 'rules'] as const) for (const variant of [undefined, 'compact', 'long'] as const) for (const benchmarks of [false, true]) {
    it(`hides only the run and models rows of a ${sourceKind} report in the ${variant ?? 'classic'} layout, benchmarks ${benchmarks}`, () => {
      const shown = stamped(sourceKind, variant, { benchmarks });
      const original = structuredClone(shown);
      const on = compose2(shown);
      const off = compose2({ ...shown, showStamp: false });
      assert.deepEqual(words(on).filter(isStamp).length >= 2, true, 'an unchanged block prints the run row and at least one models line');
      assert.ok(words(on).some((t) => t.startsWith('Validation run: 2026-01-15T10:00:00.000Z')), 'the run time is the block\'s own, never the render time');
      assert.deepEqual(words(off).filter(isStamp), [], 'the stamp reaches the PDF composer');
      assert.equal(words(on).filter((t) => !isStamp(t)).join('\n'), words(off).join('\n'), 'the heading, summary and every check remain');
      const heading = (items: DrawnItem[]) => items.find((i) => i.kind === 'text' && i.text.startsWith(sourceKind === 'rules' ? 'Information validation report' : 'IDS report'));
      assert.ok(heading(off), 'the heading names the source kind');
      const firstCheck = (items: DrawnItem[]) => items.find((i) => i.kind === 'text' && i.text.startsWith('Walls'));
      assert.ok(firstCheck(off)!.y < firstCheck(on)!.y, 'no empty gap is left where the stamp was');
      assert.deepEqual(shown, original, 'composition never mutates the block');
    });
  }

  it('without showStamp an older block prints what it always printed', () => {
    const older = stamped('ids', undefined);
    assert.equal('showStamp' in older, false);
    assert.deepEqual(compose2(older), compose2({ ...older, showStamp: true }));
  });

  it('a report without a recorded model scope prints only the run row, and hiding removes it', () => {
    const { reportModels: _scope, ...bare } = stamped('rules', 'compact');
    assert.deepEqual(words(compose2(bare)).filter(isStamp), ['Validation run: 2026-01-15T10:00:00.000Z']);
    assert.deepEqual(words(compose2({ ...bare, showStamp: false })).filter(isStamp), []);
  });

  it('stays inside the printable frame at every layout, scale and page when the stamp is shown', () => {
    const TOP = REPORT_MARGIN + 30;
    for (const [size, orientation] of [['A4', 'portrait'], ['A4', 'landscape'], ['A3', 'portrait']] as const) {
      const w = orientation === 'landscape' ? PAGE_SIZES_PT[size].h : PAGE_SIZES_PT[size].w;
      const h = orientation === 'landscape' ? PAGE_SIZES_PT[size].w : PAGE_SIZES_PT[size].h;
      const BOTTOM = h - REPORT_MARGIN - 24;
      for (const sourceKind of ['ids', 'rules'] as const) for (const variant of [undefined, 'compact', 'long'] as const) for (const scale of [0.5, 1, 1.5, 2]) for (const showStamp of [true, false]) {
        const where = `${sourceKind} ${variant ?? 'classic'} x${scale} ${size} ${orientation} stamp ${showStamp}`;
        const items = compose2(stamped(sourceKind, variant, { benchmarks: true, showStamp, scale }), { size, orientation });
        const extra = 1e-6;
        if (showStamp) assert.ok(words(items).some(isStamp), `${where}: the stamp is drawn`);
        for (const item of items) {
          const { right, bottom } = extent(item);
          assert.ok(item.x >= REPORT_MARGIN - extra, `${where}: ${item.kind} starts inside the left margin`);
          assert.ok(right <= w - REPORT_MARGIN + extra, `${where}: ${item.kind} ends at ${right}, past the right margin ${w - REPORT_MARGIN}`);
          assert.ok(item.y >= TOP - extra && bottom <= BOTTOM + extra, `${where}: ${item.kind} at y ${item.y} leaves the frame ${TOP}..${BOTTOM}`);
        }
      }
    }
  });

  it('stays inside the printable frame with the stamp shown and specifications-only on, at every scale and page', () => {
    const TOP = REPORT_MARGIN + 30;
    for (const [size, orientation] of [['A4', 'portrait'], ['A4', 'landscape'], ['A3', 'portrait']] as const) {
      const w = orientation === 'landscape' ? PAGE_SIZES_PT[size].h : PAGE_SIZES_PT[size].w;
      const h = orientation === 'landscape' ? PAGE_SIZES_PT[size].w : PAGE_SIZES_PT[size].h;
      for (const scale of [0.5, 1, 1.5, 2]) for (const showStamp of [true, false]) {
        const where = `${size} ${orientation} x${scale} stamp ${showStamp}`;
        const items = compose2(stamped('ids', 'compact', { benchmarks: true, showStamp, specificationsOnly: true, scale }), { size, orientation });
        assert.equal(words(items).some(isStamp), showStamp, `${where}: the stamp is drawn exactly when shown`);
        assert.ok(!words(items).includes('FireRating'), `${where}: requirement rows are omitted`);
        for (const item of items) {
          const { right, bottom } = extent(item);
          assert.ok(item.x >= REPORT_MARGIN - 1e-6 && right <= w - REPORT_MARGIN + 1e-6, `${where}: ${item.kind} stays between the margins`);
          assert.ok(item.y >= TOP - 1e-6 && bottom <= h - REPORT_MARGIN - 24 + 1e-6, `${where}: ${item.kind} stays inside the frame`);
        }
      }
    }
  });

  it('is persisted: a boolean survives a file round trip and anything else is refused, for both source kinds', () => {
    const doc = (b: unknown) => ({ version: DOCUMENT_VERSION, id: 'd', name: 'IDS', page: { size: 'A4', orientation: 'portrait' }, blocks: [b] });
    for (const sourceKind of ['ids', 'rules'] as const) {
      const hidden = stamped(sourceKind, 'compact', { showStamp: false });
      const reopened = parseDocumentFile(JSON.stringify(doc(hidden))).blocks[0];
      assert.equal(reopened.kind, 'ids-report');
      assert.equal(reopened.showStamp, false);
      assert.equal(reopened.generatedAt, hidden.generatedAt, 'hiding never erases the recorded time');
      assert.deepEqual(reopened.reportModels, hidden.reportModels, 'nor the recorded models');
      for (const invalid of ['false', 0, null]) {
        assert.deepEqual(validateDocumentSpec(doc({ ...hidden, showStamp: invalid })).map((e) => e.path), ['blocks[0].showStamp']);
      }
    }
  });

  it('replacing a snapshot keeps the destination block\'s stamp choice as well as its other presentation', () => {
    const destination = stamped('ids', 'long', { id: 'keep', title: 'Authored', benchmarks: false, scale: 1.5, showStamp: false });
    const source = stamped('rules', 'compact', { id: 'other', title: 'Source', benchmarks: true, scale: 2, showStamp: true });
    const replaced = replaceIdsReportSnapshot(destination, source);
    assert.deepEqual([replaced.id, replaced.title, replaced.variant, replaced.benchmarks, replaced.scale, replaced.showStamp], ['keep', 'Authored', 'long', false, 1.5, false]);
    assert.equal(replaced.sourceKind, 'rules', 'the evidence itself is the source\'s');
    assert.equal(replaceIdsReportSnapshot({ ...destination, showStamp: undefined }, source).showStamp, undefined, 'an absent choice stays absent');
  });
});
