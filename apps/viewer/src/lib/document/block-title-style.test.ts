/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Heading size, ink and background shared by every block kind with a heading (#6632): one reading
 * (`blockTitleStyle`), one drawing (`blockTitleItems`), in the composed pages, in what the PDF is asked
 * to draw, in the saved format and through every path that rebuilds a block.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_MARGIN } from '../export/report/compose.js';
import { composeDocument, estimateTextWidth, halfTextFitsPage, type DocumentLayout, type DrawnItem, type ResolvedBlock } from './compose.js';
import { generateDocumentPdf, type DocumentPdfSeams } from './generate-document-pdf.js';
import { buildReportDocument } from './build-report-document.js';
import { manualReportBlockFromChecklist, replaceManualReportSnapshot } from './manual-report.js';
import { parseDocumentFile } from './persistence.js';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec, type IdsReportBlock, type TableBlock, type TextBlock } from './types.js';
import { CHECKLIST_VERSION } from '../validation/manual/checklist.js';
import type { TableRowOut } from './resolve-table.js';
import { TABLE_ROW_HEIGHT } from './compose-table.js';

// Read dynamically, with fallbacks that make the assertions fail, so that with the production change
// reverted this file still loads and fails by assertion instead of dying at import.
type BlockTitleFields = { title?: string; titleFontSize?: number; titleTextColor?: string; titleBackgroundColor?: string };
const titleExports: {
  BLOCK_TITLE_SIZE_MIN?: number; BLOCK_TITLE_SIZE_MAX?: number; BLOCK_TITLE_SIZE_DEFAULT?: number;
  blockTitleFields?: (block: BlockTitleFields) => BlockTitleFields;
  blockTitleStyle?: (block: BlockTitleFields) => { size: number; extra: number; textColor?: string };
} = await import('./block-title.js');
const BLOCK_TITLE_SIZE_MIN = titleExports.BLOCK_TITLE_SIZE_MIN ?? 0;
const BLOCK_TITLE_SIZE_MAX = titleExports.BLOCK_TITLE_SIZE_MAX ?? 0;
const BLOCK_TITLE_SIZE_DEFAULT = titleExports.BLOCK_TITLE_SIZE_DEFAULT ?? 11;
const blockTitleFields = titleExports.blockTitleFields ?? ((block: BlockTitleFields): BlockTitleFields => ({ title: block.title }));
const blockTitleStyle = titleExports.blockTitleStyle ?? ((): { size: number; extra: number; textColor?: string } => ({ size: 0, extra: 0 }));

const STYLE = { titleFontSize: 20, titleTextColor: '#1264c8', titleBackgroundColor: '#f1c35a' } as const;
const FOOTER = 24;
const HEADER = 30;

// Compact with specifications only (#6670), so the heading style is also checked with that layout at every size.
const IDS: IdsReportBlock = { kind: 'ids-report', id: 'ids', variant: 'compact', specificationsOnly: true, benchmarks: true, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 10, passed: 7, failed: 3, passRate: 70 },
  checks: [{ id: 'walls', shortDescription: 'Walls', checked: 10, passed: 7, failed: 3, passRate: 70, rules: [] }] };
const MANUAL = manualReportBlockFromChecklist({
  checklist: { version: CHECKLIST_VERSION, name: 'Round 3', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'a', text: 'On time' }] }] },
  answers: { a: { status: 'pass', updatedAt: 1 } }, modelName: 'tower.ifc', now: new Date(Date.UTC(2026, 8, 29)),
}, 'manual');
const rows = (n: number): TableRowOut[] => Array.from({ length: n }, (_, i) => ({ role: 'row' as const, cells: [`Wall ${i}`] }));
/** One block of every kind that has a heading, each with the heading text `H:<kind>` and `style` applied. */
const blocksOfEveryHeadedKind = (style: object = STYLE, scale?: number): ResolvedBlock[] => {
  const s = { ...style, ...(scale === undefined ? {} : { scale }) };
  return [
    { kind: 'text', id: 'text', style: 'body', text: 'One short line', title: 'H:text', ...s },
    { kind: 'image', id: 'image', height: 100, align: 'center', aspect: 2, title: 'H:image', ...s },
    { kind: 'chart', id: 'chart', title: 'H:chart', subtitle: '3 buckets', hasData: true, snapshot: false, height: 200, ...s },
    { kind: 'topic', id: 'topic', title: 'H:topic', authoredTitle: true, lines: ['Open'], snapshotAspect: 2, ...s },
    { kind: 'table', id: 'table', title: 'H:table', columns: [{ label: 'Name', numeric: false }], rows: rows(3), ...s },
    { ...IDS, title: 'H:ids', ...s },
    { ...MANUAL, title: 'H:manual', ...s },
  ];
};
const KINDS = ['text', 'image', 'chart', 'topic', 'table', 'ids', 'manual'] as const;

const PAGES = [['A4 portrait', 'A4', 'portrait'], ['A4 landscape', 'A4', 'landscape'], ['A3 landscape', 'A3', 'landscape'], ['A3 portrait', 'A3', 'portrait']] as const;
const compose = (blocks: ResolvedBlock[], size: 'A4' | 'A3' = 'A4', orientation: 'portrait' | 'landscape' = 'portrait'): DocumentLayout =>
  composeDocument({ name: 'Doc', page: { size, orientation }, generatedAt: 'now', measure: estimateTextWidth, blocks });
const itemsOf = (layout: DocumentLayout): DrawnItem[] => layout.pages.flatMap((page) => page.items);
const heading = (layout: DocumentLayout, kind: string) => {
  const found = itemsOf(layout).find((item) => item.kind === 'text' && item.text === `H:${kind}`);
  assert.ok(found && found.kind === 'text', `the ${kind} heading is drawn`);
  return found;
};
const strip = (layout: DocumentLayout, text: { x: number; y: number }) =>
  itemsOf(layout).find((item) => item.kind === 'rect' && item.x < text.x && item.y <= text.y && item.y + item.h >= text.y);

describe('heading style in the composed pages (#6632)', () => {
  for (const kind of KINDS) {
    it(`${kind}: draws the heading at the authored size and ink over an authored strip, and the default one when nothing is set`, () => {
      const styled = compose(blocksOfEveryHeadedKind());
      const text = heading(styled, kind);
      const size = STYLE.titleFontSize;
      assert.equal(text.size, size, 'authored size');
      assert.equal(text.color, STYLE.titleTextColor, 'authored ink');
      assert.equal(text.bold, true);
      const background = strip(styled, text);
      assert.ok(background && background.kind === 'rect', 'a background strip is drawn behind the heading');
      assert.equal(background.color, STYLE.titleBackgroundColor);
      assert.ok(background.h >= size, 'the strip is at least as tall as the heading text');
      const plain = heading(compose(blocksOfEveryHeadedKind({})), kind);
      assert.equal(plain.size, BLOCK_TITLE_SIZE_DEFAULT, 'absent size prints the default');
      assert.ok(!('color' in plain), 'absent colour leaves the ink to the default');
      const rects = (layout: DocumentLayout) => itemsOf(layout).filter((item) => item.kind === 'rect').length;
      assert.equal(rects(styled) - rects(compose(blocksOfEveryHeadedKind({}))), KINDS.length, 'absent background draws no strip: only the authored ones add rectangles (the compact report bars are the same)');
    });
  }

  it('with only a background, the ink is black or white by contrast and never the default black on a dark strip', () => {
    const dark = compose(blocksOfEveryHeadedKind({ titleBackgroundColor: '#0b1f4d' }));
    const light = compose(blocksOfEveryHeadedKind({ titleBackgroundColor: '#fff2b3' }));
    for (const kind of KINDS) {
      assert.equal(heading(dark, kind).color, '#ffffff', `${kind} on a dark strip`);
      assert.equal(heading(light, kind).color, '#000000', `${kind} on a light strip`);
    }
    assert.equal(blockTitleStyle({ titleBackgroundColor: '#0b1f4d', titleTextColor: '#0b1f4e' }).textColor, '#0b1f4e', 'an authored ink is never replaced');
  });

  it('a larger heading pushes the content below it down by exactly the height it adds, for every kind', () => {
    const added = (BLOCK_TITLE_SIZE_MAX - BLOCK_TITLE_SIZE_DEFAULT) * (16 / BLOCK_TITLE_SIZE_DEFAULT);
    const sentinel: ResolvedBlock = { kind: 'text', id: 'sentinel', style: 'body', text: 'After', title: 'H:sentinel' };
    for (const kind of KINDS) {
      // A topic's snapshot is taller than its heading and text, so it is measured without one.
      const block = (style: object): ResolvedBlock => { const b = blocksOfEveryHeadedKind(style)[KINDS.indexOf(kind)]; return b.kind === 'topic' ? { ...b, snapshotAspect: null } : b; };
      // The sentinel's heading sits one block-height below the block's own heading.
      const gap = (style: object): number => heading(compose([block(style), sentinel]), 'sentinel').y - heading(compose([block(style), sentinel]), kind).y;
      const grew: number = gap({ titleFontSize: BLOCK_TITLE_SIZE_MAX }) - gap({});
      // The two headings' own baselines move by their sizes; what is left is the block's growth.
      assert.ok(Math.abs(grew - (added - (BLOCK_TITLE_SIZE_MAX - BLOCK_TITLE_SIZE_DEFAULT))) < 1e-6, `${kind}: the content below moved down by ${added} (gap grew by ${grew})`);
    }
  });

  it('reads an invalid size or colour as absent, like a block size', () => {
    for (const bad of [Number.NaN, 5.9, 24.1, Infinity, '12' as unknown as number]) {
      assert.equal(blockTitleStyle({ titleFontSize: bad }).size, BLOCK_TITLE_SIZE_DEFAULT, String(bad));
    }
    assert.deepEqual(blockTitleStyle({ titleTextColor: 'red', titleBackgroundColor: '#fff' }), { size: 11, extra: 0 });
  });
});

describe('heading style scales with its block (#6632)', () => {
  for (const kind of KINDS) {
    it(`${kind}: at block size 2 the heading text and its strip are twice their size at 1`, () => {
      // Without a snapshot beside it, so the topic's heading is not truncated into the column the snapshot leaves.
      const blocks = (scale: number) => blocksOfEveryHeadedKind(STYLE, scale).map((block): ResolvedBlock => (block.kind === 'topic' ? { ...block, snapshotAspect: null } : block));
      const one = compose(blocks(1));
      const two = compose(blocks(2));
      assert.equal(heading(two, kind).size, 2 * heading(one, kind).size);
      const a = strip(one, heading(one, kind)); const b = strip(two, heading(two, kind));
      assert.ok(a && b && a.kind === 'rect' && b.kind === 'rect');
      assert.ok(Math.abs(b.h - 2 * a.h) < 1e-6, `strip ${b.h} vs ${a.h}`);
    });
  }
});

describe('a half-width text pairs only while its larger heading still fits the page (#6632)', () => {
  it('fits at the default heading, and no longer fits at the largest heading, when it fills the frame to the line', () => {
    const block = (lines: number, titleFontSize?: number) => ({ style: 'body' as const, text: Array.from({ length: lines }, () => 'x').join('\n'), title: 'Heading', ...(titleFontSize ? { titleFontSize } : {}) });
    let lines = 1;
    while (halfTextFitsPage(block(lines + 1), 841.89, 200)) lines += 1;
    assert.ok(lines > 10, `the probe found a full page of ${lines} lines`);
    assert.equal(halfTextFitsPage(block(lines), 841.89, 200), true, 'fits with the default heading');
    assert.equal(halfTextFitsPage(block(lines, BLOCK_TITLE_SIZE_MAX), 841.89, 200), false, 'the enlarged heading no longer fits, so the block is not paired');
  });
});

describe('heading style stays inside the printable frame (#6632)', () => {
  const MAX = { titleFontSize: BLOCK_TITLE_SIZE_MAX, titleTextColor: '#000000', titleBackgroundColor: '#ffff00' };
  for (const [label, size, orientation] of PAGES) {
    for (const scale of [1, 2]) {
      it(`${label}, scale ${scale}: every item of every kind, at the largest heading, lies between the margins and above the footer`, () => {
        const { w, h } = { A4: { portrait: { w: 595.28, h: 841.89 }, landscape: { w: 841.89, h: 595.28 } }, A3: { portrait: { w: 841.89, h: 1190.55 }, landscape: { w: 1190.55, h: 841.89 } } }[size][orientation];
        // A tall narrow image (its height, not its width, is what binds) and a tall chart, so a block really could outgrow the frame.
        const blocks = blocksOfEveryHeadedKind(MAX, scale).map((block): ResolvedBlock => (block.kind === 'image' ? { ...block, height: 3000, aspect: 0.2 } : block.kind === 'chart' ? { ...block, height: 600, snapshot: scale === 1 } : block));
        // A chart snapshot at scale 2 already leaves the frame on A4 landscape without any heading style; that is #6681's, not asserted here.
        const layout = compose(blocks, size, orientation);
        for (const item of itemsOf(layout)) {
          const bottom = item.kind === 'text' ? item.y : item.kind === 'ring' ? item.y + item.size : item.kind === 'table' ? item.y + (item.rows.length + 1) * TABLE_ROW_HEIGHT * (item.scale ?? 1) : item.y + item.h;
          assert.ok(bottom <= h - REPORT_MARGIN - FOOTER + 1e-6, `${item.kind} ends at ${bottom} but the frame ends at ${h - REPORT_MARGIN - FOOTER}`);
          assert.ok(item.y >= REPORT_MARGIN + HEADER - 1e-6, `${item.kind} starts below the header`);
          if ('w' in item) assert.ok(item.x + item.w <= w - REPORT_MARGIN + 1e-6, `${item.kind} ends at x ${item.x + item.w} inside the right margin`);
        }
        assert.equal(itemsOf(layout).filter((item) => item.kind === 'text' && item.text.startsWith('H:')).length, KINDS.length, 'every heading is drawn once, however far it was truncated');
      });
    }
  }
});

describe('heading style in what the PDF draws (#6632)', () => {
  const spec = (blocks: DocumentSpec['blocks']): DocumentSpec => ({ version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, blocks });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  it('hands the PDF the same size, ink and strip the composer chose, for every kind', async () => {
    const ops: Array<{ text?: string; size: number; ink: number | string; fill?: string }> = [];
    let size = 0; let ink: number | string = 0;
    const seams: DocumentPdfSeams = {
      createDoc: async () => ({ addPage: () => {}, setFont: () => {}, setFontSize: (s) => { size = s; }, setTextColor: (c) => { ink = c; },
        text: (text) => { ops.push({ text, size, ink }); }, fillRect: (_x, _y, _w, _h, color) => { ops.push({ size, ink, fill: color }); },
        addImage: () => {}, svg: async () => {}, table: () => {}, pageCount: () => 1, output: () => new Blob(['pdf']) }),
      renderSvg: () => '', capture: null, theme: undefined as never, now: () => new Date(0), imageSize: async () => ({ w: 2, h: 1 }),
    };
    const document = spec([
      { kind: 'text', id: 'text', style: 'body', text: 'Body', title: 'H:text', ...STYLE },
      { kind: 'image', id: 'image', dataUrl: png, height: 40, align: 'left', title: 'H:image', ...STYLE },
      { kind: 'chart', id: 'chart', chart: { id: 'c', title: 'Chart source', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } }, snapshot: false, title: 'H:chart', ...STYLE },
      { kind: 'table', id: 'table', source: { kind: 'validation', rows: 'failed', columns: ['rule'] }, title: 'H:table', ...STYLE } satisfies TableBlock,
      // The same kind with rows to print takes the other resolve branch.
      { kind: 'table', id: 'rows', source: { kind: 'validation', rows: 'failed', columns: ['rule'] }, title: 'H:rows', ...STYLE } satisfies TableBlock,
      { ...IDS, title: 'H:ids', ...STYLE },
      { ...MANUAL, title: 'H:manual', ...STYLE },
    ]);
    await generateDocumentPdf({ document, aggregations: new Map(), chartMessages: new Map(), topics: new Map(), tables: new Map([['rows', { status: 'ok' as const, kind: 'validation' as const, model: { columns: [{ label: 'Rule', numeric: false }], rows: rows(2), totalRows: 2 } }]]), bindings: { models: [], activeModelId: null, today: new Date(0) }, snapshotIds: () => [] }, seams);
    for (const kind of ['text', 'image', 'chart', 'table', 'rows', 'ids', 'manual']) {
      const op = ops.find((o) => o.text === `H:${kind}`);
      assert.ok(op, `${kind} heading reached the PDF`);
      assert.equal(op.size, STYLE.titleFontSize, `${kind} size`);
      assert.equal(op.ink, STYLE.titleTextColor, `${kind} ink`);
    }
    assert.equal(ops.filter((o) => o.fill === STYLE.titleBackgroundColor).length, 7, 'one strip per heading');
  });
});

describe('heading style in the saved format (#6632)', () => {
  const doc = (block: object) => ({ version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: 't', style: 'body', text: 'x', ...block }] });
  it('accepts the bounds and refuses a size outside them or a colour that is not #RRGGBB, naming the field', () => {
    assert.deepEqual(validateDocumentSpec(doc({ titleFontSize: BLOCK_TITLE_SIZE_MIN })), []);
    assert.deepEqual(validateDocumentSpec(doc({ titleFontSize: BLOCK_TITLE_SIZE_MAX, titleTextColor: '#aabbcc', titleBackgroundColor: '#000000' })), []);
    for (const bad of [BLOCK_TITLE_SIZE_MIN - 0.1, BLOCK_TITLE_SIZE_MAX + 0.1, Number.NaN, '12']) {
      assert.deepEqual(validateDocumentSpec(doc({ titleFontSize: bad })).map((e) => e.path), ['blocks[0].titleFontSize'], String(bad));
    }
    for (const key of ['titleTextColor', 'titleBackgroundColor']) {
      for (const bad of ['red', '#fff', '#12345g', 'rgba(0,0,0,.5)', 7]) assert.deepEqual(validateDocumentSpec(doc({ [key]: bad })).map((e) => e.path), [`blocks[0].${key}`], `${key} ${String(bad)}`);
    }
  });
  it('validates the same fields on every kind that has a heading, and rejects them on none that does not', () => {
    const base = (block: object): unknown => ({ version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, blocks: [block] });
    const bad = { titleFontSize: 99 };
    const tableSource = { kind: 'validation', rows: 'failed', columns: ['rule'] };
    for (const block of [
      { kind: 'text', id: 'b', style: 'body', text: '', ...bad }, { kind: 'image', id: 'b', dataUrl: 'data:image/png;base64,AA', height: 5, align: 'left', ...bad },
      { kind: 'topic', id: 'b', guid: 'g', snapshot: false, ...bad }, { kind: 'table', id: 'b', source: tableSource, ...bad },
      { ...IDS, id: 'b', ...bad }, { ...MANUAL, id: 'b', ...bad },
    ]) assert.deepEqual(validateDocumentSpec(base(block)).map((e) => e.path), ['blocks[0].titleFontSize'], String(block.kind));
    assert.deepEqual(validateDocumentSpec(base({ kind: 'spacer', id: 'b', height: 5, ...bad })), [], 'a spacer has no heading to style');
  });
  it('a version-11 document keeps its plain block heading when migrating the page-band format (#6610)', () => {
    const imported = parseDocumentFile(JSON.stringify({ ...doc({ title: 'Plain' }), version: 11 }));
    assert.deepEqual({ ...imported.blocks[0], id: 't' }, { kind: 'text', id: 't', style: 'body', text: 'x', title: 'Plain' });
  });
  it('keeps a heading style through export and import for every headed kind', () => {
    const blocks: DocumentSpec['blocks'] = [
      { kind: 'text', id: 'a', style: 'body', text: 'x', ...STYLE }, { kind: 'topic', id: 'c', guid: 'g', snapshot: false, ...STYLE },
      { ...IDS, id: 'd', ...STYLE }, { ...MANUAL, id: 'e', ...STYLE },
    ];
    const imported = parseDocumentFile(JSON.stringify({ version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, blocks }));
    for (const block of imported.blocks) assert.deepEqual(blockTitleFields(block as TextBlock), { title: undefined, ...STYLE }, block.kind);
  });
});

describe('every path that rebuilds a block keeps its heading style (#6632)', () => {
  it('replacing a manual report snapshot keeps all heading fields, including ones the new snapshot has none of', () => {
    const next = replaceManualReportSnapshot({ ...MANUAL, title: 'Mine', ...STYLE }, { ...MANUAL, id: 'other', titleFontSize: 7 });
    assert.deepEqual(blockTitleFields(next), { title: 'Mine', ...STYLE });
    assert.equal(next.id, MANUAL.id);
  });
  it('a report document built from a template keeps the heading style of the template block it fills', () => {
    const template: DocumentSpec = { version: DOCUMENT_VERSION, id: 't', name: 'T', page: { size: 'A4', orientation: 'portrait' },
      blocks: [{ ...IDS, id: 'slot', title: 'Evidence', ...STYLE }] };
    const built = buildReportDocument({ template, mappings: [{ blockId: 'slot', jobId: 'job' }], results: [{ kind: 'validation', jobId: 'job', resultId: 'r', snapshot: { ...IDS, id: 'snap' } }] });
    const filled = built.blocks.find((block) => block.kind === 'ids-report');
    assert.ok(filled && filled.kind === 'ids-report');
    assert.deepEqual(blockTitleFields(filled), { title: 'Evidence', ...STYLE });
  });
});
