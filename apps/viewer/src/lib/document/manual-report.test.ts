/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The manual-validation report block (#6401): a frozen snapshot of the
 * checklist and one model's answers, validated on load, carried by
 * document format v7, laid out on the page model and printed with its rings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME } from '@ifc-lite/charts';
import { CHECKLIST_VERSION, type ChecklistTemplate, type ManualAnswerMap } from '../validation/manual/checklist.js';
import { resolveReportModel, type ManualModelOption } from '../validation/manual/manual-model.js';
import { REPORT_MARGIN } from '../export/report/compose.js';
import { composeDocument, estimateTextWidth } from './compose.js';
import { generateDocumentPdf, type DocumentPdfSeams } from './generate-document-pdf.js';
import { manualReportBlockFromChecklist } from './manual-report.js';
import type { ManualReportBlock } from './manual-report-types.js';
import { parseDocumentFile } from './persistence.js';
import { DOCUMENT_VERSION, migrateDocumentSpec, validateDocumentSpec, type DocumentSpec } from './types.js';

const CHECKLIST: ChecklistTemplate = {
  version: CHECKLIST_VERSION,
  name: 'Coordination round 3',
  groups: [
    { id: 'delivery', name: 'Delivery', items: [
      { id: 'on-time', text: 'Uploaded to the CDE on time' },
      { id: 'naming', text: 'File naming follows the convention', description: 'See the BEP, section 4' },
    ] },
    { id: 'structure', name: 'Model structure', items: [
      { id: 'storey', text: 'Objects are on the right storey' },
      { id: 'dupes', text: 'No duplicate elements' },
    ] },
  ],
};

const ANSWERS: ManualAnswerMap = {
  'on-time': { status: 'pass', updatedAt: 1 },
  naming: { status: 'warning', comment: 'Two files use the old prefix', updatedAt: 1 },
  storey: { status: 'fail', comment: 'Level 2 is named "OG1 neu"', updatedAt: 1 },
};

const block = (): ManualReportBlock => manualReportBlockFromChecklist({ checklist: CHECKLIST, answers: ANSWERS, modelName: 'tower.ifc', now: new Date(Date.UTC(2026, 8, 29)) }, 'b1');
const docWith = (blocks: DocumentSpec['blocks']): DocumentSpec => ({ version: DOCUMENT_VERSION, id: 'd', name: 'Round 3', page: { size: 'A4', orientation: 'portrait' }, blocks });

describe('manual report snapshot (#6401)', () => {
  it('copies groups, verdicts, comments and counts; a warning is its own count and an unanswered check stays unanswered', () => {
    const b = block();
    assert.equal(b.checklistName, 'Coordination round 3');
    assert.equal(b.modelName, 'tower.ifc');
    assert.equal(b.generatedAt, '2026-09-29T00:00:00.000Z');
    assert.deepEqual(b.summary, { total: 4, pass: 1, fail: 1, warning: 1, unanswered: 1 });
    assert.deepEqual(b.groups.map((g) => g.counts), [
      { total: 2, pass: 1, fail: 0, warning: 1, unanswered: 0 },
      { total: 2, pass: 0, fail: 1, warning: 0, unanswered: 1 },
    ]);
    assert.deepEqual(b.groups[0].items[1], { id: 'naming', text: 'File naming follows the convention', description: 'See the BEP, section 4', status: 'warning', comment: 'Two files use the old prefix' });
    assert.deepEqual(b.groups[1].items[1], { id: 'dupes', text: 'No duplicate elements', status: null });
  });

  it('is frozen: later answers do not reach a block already taken', () => {
    const answers = { ...ANSWERS };
    const b = manualReportBlockFromChecklist({ checklist: CHECKLIST, answers }, 'b1');
    answers.dupes = { status: 'pass', updatedAt: 2 };
    assert.equal(b.groups[1].items[1].status, null);
  });
});

describe('manual report in the document format (#6401)', () => {
  it('is a valid block of the current document version and survives a file round trip', () => {
    assert.deepEqual(validateDocumentSpec(docWith([block()])), []);
    // A saved version-7 manual report must retain its verdicts after later format additions (#6485).
    const reopened = parseDocumentFile(JSON.stringify({ ...docWith([block()]), version: 7 }));
    assert.equal(reopened.version, DOCUMENT_VERSION);
    const b = reopened.blocks[0];
    assert.equal(b.kind, 'manual-report');
    assert.deepEqual(b.kind === 'manual-report' ? b.summary : null, block().summary);
  });

  it('refuses a block whose counts contradict its verdicts, or an unknown verdict, naming the path', () => {
    const tampered = block();
    tampered.groups[0].counts = { total: 2, pass: 2, fail: 0, warning: 0, unanswered: 0 };
    const errors = validateDocumentSpec(docWith([tampered]));
    assert.deepEqual(errors.map((e) => `${e.path}: ${e.message}`), [
      'blocks[0].groups[0].counts: does not match the verdicts of its items',
      'blocks[0].summary: does not match the sum of its groups',
    ]);
    const badStatus = block() as unknown as { groups: Array<{ items: Array<{ status: unknown }> }> };
    badStatus.groups[0].items[0].status = 'maybe';
    const statusErrors = validateDocumentSpec(docWith([badStatus as unknown as ManualReportBlock]));
    assert.ok(statusErrors.some((e) => e.path === 'blocks[0].groups[0].items[0].status'), JSON.stringify(statusErrors));
  });

  // CodeRabbit on #6486: ids were only checked non-empty, so a hand-edited file with a reused id
  // passed although the checklist parser refuses one and the preview keys its rows by id.
  it('refuses a reused group or check id across the whole block, as the checklist parser does', () => {
    const dupItem = block();
    dupItem.groups[1].items[0].id = 'on-time';
    const dupGroup = block();
    dupGroup.groups[1].id = 'naming';
    assert.deepEqual(validateDocumentSpec(docWith([dupItem])).map((e) => `${e.path}: ${e.message}`), ['blocks[0].groups[1].items[0].id: duplicate id "on-time"']);
    assert.deepEqual(validateDocumentSpec(docWith([dupGroup])).map((e) => `${e.path}: ${e.message}`), ['blocks[0].groups[1].id: duplicate id "naming"']);
  });

  it('carries the model fingerprint the answers were keyed by, and still opens a block without one', () => {
    const bound = manualReportBlockFromChecklist({ checklist: CHECKLIST, answers: ANSWERS, modelName: 'tower.ifc', modelFingerprint: 'fp-tower' }, 'b1');
    assert.equal(bound.modelFingerprint, 'fp-tower');
    assert.equal(block().modelFingerprint, undefined);
    assert.deepEqual(validateDocumentSpec(docWith([bound, { ...block(), id: 'b2' }])), []);
    const reopened = parseDocumentFile(JSON.stringify(docWith([bound]))).blocks[0];
    assert.equal(reopened.kind === 'manual-report' ? reopened.modelFingerprint : null, 'fp-tower');
    const empty = { ...bound, modelFingerprint: '' };
    assert.deepEqual(validateDocumentSpec(docWith([empty])).map((e) => e.path), ['blocks[0].modelFingerprint']);
  });

  it('opens a v6 document by raising its version, and a v7 block in a v6 viewer is "newer", not broken', () => {
    const v6 = { ...docWith([]), version: 6 };
    assert.equal((migrateDocumentSpec(v6) as DocumentSpec).version, DOCUMENT_VERSION);
    const fromNewer = validateDocumentSpec({ ...docWith([]), version: DOCUMENT_VERSION + 1 });
    assert.match(fromNewer[0].message, /newer version of ifc-lite/);
  });
});

describe('manual report on the page (#6401)', () => {
  it('lays out an overall ring, one ring per group, and every verdict as a word', () => {
    const layout = composeDocument({ name: 'Round 3', page: { size: 'A4', orientation: 'portrait' }, blocks: [block()], generatedAt: 'now', measure: estimateTextWidth });
    const items = layout.pages.flatMap((p) => p.items);
    const rings = items.filter((i) => i.kind === 'ring');
    assert.equal(rings.length, 3);
    assert.deepEqual(rings[0].kind === 'ring' ? rings[0].counts : null, block().summary);
    const texts = items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));
    assert.ok(texts.includes('Manual validation: Coordination round 3'));
    assert.ok(texts.includes('25% passed (1 of 4 checks)'));
    assert.deepEqual(texts.filter((t) => /^(PASS|FAIL|WARNING|NOT CHECKED)$/.test(t)), ['PASS', 'WARNING', 'FAIL', 'NOT CHECKED']);
    assert.ok(texts.includes('Comment: Level 2 is named "OG1 neu"'));
  });

  it('paginates a long checklist without printing into the footer band', () => {
    const many: ChecklistTemplate = { ...CHECKLIST, groups: Array.from({ length: 6 }, (_, g) => ({
      id: `g${g}`, name: `Group ${g}`, items: Array.from({ length: 15 }, (_, i) => ({ id: `g${g}i${i}`, text: `Check ${i} of group ${g}` })),
    })) };
    const b = manualReportBlockFromChecklist({ checklist: many, answers: {} }, 'b');
    const layout = composeDocument({ name: 'Long', page: { size: 'A4', orientation: 'portrait' }, blocks: [b], generatedAt: 'now', measure: estimateTextWidth });
    assert.ok(layout.pages.length > 1);
    const bottom = layout.size.h - REPORT_MARGIN - 24;
    for (const item of layout.pages.flatMap((p) => p.items)) {
      const end = item.kind === 'ring' ? item.y + item.size : item.y;
      assert.ok(end <= bottom, `item ending at ${end} is past ${bottom}`);
    }
    assert.equal(layout.pages.flatMap((p) => p.items).filter((i) => i.kind === 'text' && i.text === 'NOT CHECKED').length, 90);
  });

  it('prints each ring as an SVG in the status colours', async () => {
    const svgs: string[] = [];
    const seams: DocumentPdfSeams = {
      createDoc: async () => ({
        addPage: () => {}, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {}, fillRect: () => {}, text: () => {}, addImage: () => {},
        svg: async (svg) => { svgs.push(svg); }, table: () => {}, pageCount: () => 1, output: () => new Blob(['pdf']),
      }),
      renderSvg: () => '', capture: null, theme: DEFAULT_THEME, now: () => new Date(0), imageSize: async () => ({ w: 1, h: 1 }),
    };
    await generateDocumentPdf({ document: docWith([block()]), bindings: { models: [], activeModelId: null, today: new Date(0) }, aggregations: new Map(), chartMessages: new Map(), snapshotIds: () => [], topics: new Map(), tables: new Map() }, seams);
    assert.equal(svgs.length, 3);
    // The overall ring holds all four buckets; the "Delivery" ring only pass and warning.
    assert.ok(['#16a34a', '#e0a100', '#dc2626'].every((c) => svgs[0].includes(c)));
    assert.ok(svgs[1].includes('#16a34a') && svgs[1].includes('#e0a100') && !svgs[1].includes('#dc2626'));
  });
});

// CodeRabbit on #6486: Refresh matched the model by display name and fell back to the active
// model, so it could snapshot another model's answers and still report success.
describe('which model a manual report block refreshes from (#6401)', () => {
  const tower: ManualModelOption = { id: 'm1', name: 'model.ifc', fingerprint: 'fp-tower' };
  const annex: ManualModelOption = { id: 'm2', name: 'model.ifc', fingerprint: 'fp-annex' };

  it('reads the model the block was taken from, by fingerprint, even when another shares its name and is active', () => {
    assert.deepEqual(resolveReportModel([tower, annex], 'fp-annex', null, 'm1'), { kind: 'model', model: annex });
  });

  it('is "missing", never a stand-in, when that model is not loaded', () => {
    assert.deepEqual(resolveReportModel([tower], 'fp-annex', null, 'm1'), { kind: 'missing' });
    assert.deepEqual(resolveReportModel([], 'fp-annex', null, null), { kind: 'missing' });
  });

  it('takes an explicit pick over the bound model, and an unbound block follows the default', () => {
    assert.deepEqual(resolveReportModel([tower], 'fp-annex', 'm1', 'm1'), { kind: 'model', model: tower });
    assert.deepEqual(resolveReportModel([tower, annex], undefined, null, 'm2'), { kind: 'model', model: annex });
    assert.deepEqual(resolveReportModel([], undefined, null, null), { kind: 'model', model: null });
  });
});
