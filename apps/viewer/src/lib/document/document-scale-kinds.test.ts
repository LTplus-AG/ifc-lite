/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-block size (#6548) for every kind, from the saved block to the text the PDF prints, and the gap that
 * follows a scaled report: the gap between blocks does not scale, only the block does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeDocument, estimateTextWidth, BLOCK_GAP, type ResolvedBlock } from './compose.js';
import { generateDocumentPdf, type DocumentPdfSeams } from './generate-document-pdf.js';
import { manualReportBlockFromChecklist } from './manual-report.js';
import { CHECKLIST_VERSION } from '../validation/manual/checklist.js';
import { DOCUMENT_VERSION, type DocumentBlock, type DocumentSpec, type IdsReportBlock } from './types.js';

const PAGE = { size: 'A4', orientation: 'portrait' } as const;
const TOP = 40 + 30;

const IDS: IdsReportBlock = {
  kind: 'ids-report', id: 'b', variant: 'compact', benchmarks: true, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 10, passed: 7, failed: 3, passRate: 70 },
  checks: [0, 1].map((i) => ({ id: `c${i}`, shortDescription: `Specification ${i}`, checked: 10, passed: 7, failed: 3, passRate: 70,
    rules: [{ id: `r${i}`, name: 'Rule', shortDescription: `Requirement of ${i}`, checked: 10, passed: 7, failed: 3, passRate: 70 }] })),
};
const MANUAL = { ...manualReportBlockFromChecklist({
  checklist: { version: CHECKLIST_VERSION, name: 'Round 3', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'a', text: 'On time' }, { id: 'b', text: 'Named well' }] }] },
  answers: { a: { status: 'pass', updatedAt: 1 } }, modelName: 'tower.ifc', now: new Date(Date.UTC(2026, 8, 29)),
}, 'b') };

/** Text sizes printed for one saved block, through the real resolution of the block and the composer. */
async function printedSizes(block: DocumentBlock, scale: number | undefined, tables: ReadonlyMap<string, unknown>): Promise<number[]> {
  const sizes: number[] = [];
  let size = 0;
  const seams: DocumentPdfSeams = {
    createDoc: async () => ({
      addPage: () => {}, setFont: () => {}, setFontSize: (n) => { size = n; }, setTextColor: () => {}, fillRect: () => {},
      text: () => { sizes.push(size); }, addImage: () => {}, svg: async () => {}, table: () => {}, pageCount: () => 1, output: () => new Blob(['pdf']),
    }),
    renderSvg: () => '<svg/>', capture: null,
    theme: { text: '#000', mutedText: '#666', axis: '#999', grid: '#eee', background: 'transparent', fontFamily: 'Helvetica' },
    now: () => new Date('2026-09-12T10:00:00Z'), imageSize: async () => ({ w: 200, h: 100 }),
  };
  const topic = { guid: 'G1', title: 'Clash', description: 'The duct passes through the wall.', topicType: 'Error', topicStatus: 'Open', priority: 'High', comments: [], viewpoints: [], documentReferences: [], relatedTopics: [], labels: [], bimSnippets: [] };
  const document: DocumentSpec = { version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page: PAGE, blocks: [{ ...block, ...(scale ? { scale } : {}) } as DocumentBlock] };
  await generateDocumentPdf({ document, bindings: { models: [], activeModelId: null, today: new Date('2026-09-12') }, aggregations: new Map(), chartMessages: new Map(),
    snapshotIds: () => [], topics: new Map([['G1', topic as never]]), tables: tables as never }, seams);
  return sizes;
}

describe('every kind of block reaches the PDF at its size (#6548)', () => {
  const state = { status: 'ok' as const, kind: 'validation' as const, model: { columns: [{ label: 'Rule', numeric: false }], rows: [{ role: 'row' as const, cells: ['R1'] }], totalRows: 1 } };
  const kinds: Array<[string, DocumentBlock, ReadonlyMap<string, unknown>]> = [
    ['text', { kind: 'text', id: 'b', style: 'body', text: 'hello' }, new Map()],
    ['topic', { kind: 'topic', id: 'b', guid: 'G1', snapshot: false }, new Map()],
    ['table', { kind: 'table', id: 'b', source: { kind: 'validation', rows: 'all', columns: ['rule'] } }, new Map([['b', state]])],
    ['topic that is not loaded (its placeholder)', { kind: 'topic', id: 'b', guid: 'NOT-LOADED', snapshot: false }, new Map()],
    ['table with no rows to print (its message)', { kind: 'table', id: 'b', source: { kind: 'validation', rows: 'all', columns: ['rule'] } }, new Map()],
    ['ids-report', IDS, new Map()],
    ['manual-report', MANUAL, new Map()],
  ];
  for (const [name, block, tables] of kinds) {
    it(`${name}: the largest text printed at 1.5x is 1.5 times the one printed at 1x, the page header and footer staying at 8pt`, async () => {
      const one = await printedSizes(block, undefined, tables);
      const scaled = await printedSizes(block, 1.5, tables);
      assert.equal(one.filter((s) => s === 8).length >= 3, true, 'the header, footer and counter print at 8pt');
      assert.equal(Math.max(...scaled), Math.max(...one) * 1.5);
      assert.equal(scaled.filter((s) => s === 8).length >= 3, true, 'the page furniture does not scale');
    });
  }
});

describe('the gap that follows a scaled report does not scale (#6548)', () => {
  const after: ResolvedBlock = { kind: 'text', id: 'after', style: 'body', text: 'after' };
  /** Where the following block starts, less the gap, as a multiple of the report's own height at 1x. */
  const reportHeight = (report: ResolvedBlock, scale: number): number => {
    const layout = composeDocument({ name: 'Doc', page: PAGE, generatedAt: 'now', measure: estimateTextWidth, blocks: [{ ...report, ...(scale === 1 ? {} : { scale }) } as ResolvedBlock, after] });
    const text = layout.pages.flatMap((p) => p.items).find((i) => i.kind === 'text' && i.text === 'after');
    assert.ok(text && text.kind === 'text');
    assert.equal(layout.pages.length, 1);
    return text.y - text.size - TOP - BLOCK_GAP;
  };
  for (const [name, report] of [['ids-report', IDS], ['manual-report', MANUAL]] as const) {
    it(`${name}: the distance to the next block is the report at its size plus one unscaled gap`, () => {
      const height = reportHeight(report, 1);
      for (const scale of [0.5, 1.5]) assert.ok(Math.abs(reportHeight(report, scale) - height * scale) < 1e-6, `${scale}x`);
    });
  }

  it('a compact IDS report gives each specification after the first its group gap at the size of the block', () => {
    const gap = (scale: number): number => {
      const layout = composeDocument({ name: 'Doc', page: PAGE, generatedAt: 'now', measure: estimateTextWidth, blocks: [{ ...IDS, ...(scale === 1 ? {} : { scale }) }] });
      const y = (text: string): number => (layout.pages[0].items.find((i) => i.kind === 'text' && i.text === text) as { y: number }).y;
      return y('Specification 1') - y('Rule');
    };
    for (const scale of [0.5, 1.5, 2]) assert.ok(Math.abs(gap(scale) - gap(1) * scale) < 1e-6, `${scale}x`);
  });
});
