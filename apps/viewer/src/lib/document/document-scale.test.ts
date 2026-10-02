/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-block size (#6548): one factor that moves a block's text and graphics together, in the
 * composed pages the PDF is drawn from, in what the PDF seams are asked to draw, in the saved
 * format (version 10 documents still load as they were) and at its bounds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_MARGIN } from '../export/report/compose.js';
import { composeDocument, estimateTextWidth, type DocumentLayout, type DrawnItem, type ResolvedBlock } from './compose.js';
import { generateDocumentPdf, type DocumentPdfSeams } from './generate-document-pdf.js';
import { manualReportBlockFromChecklist, replaceManualReportSnapshot } from './manual-report.js';
import { parseDocumentFile } from './persistence.js';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec, type IdsReportBlock } from './types.js';
import { CHECKLIST_VERSION } from '../validation/manual/checklist.js';
import type { TableRowOut } from './resolve-table.js';

// The new exports are read dynamically, with fallbacks that make the assertions fail, so that with the
// production change reverted this file still loads and fails by assertion instead of dying at import
// (the same reason `document.test.ts` imports `migrateDocumentSpec` dynamically).
const composeExports: { scaledPageHeight?: (pageHeight: number, headingExtraHeight: number, scale: number) => number } = await import('./compose.js');
const typesExports: { BLOCK_SCALE_MIN?: number; BLOCK_SCALE_MAX?: number; blockScale?: (block: { kind: string; scale?: number }) => number } = await import('./types.js');
const scaledPageHeight = composeExports.scaledPageHeight ?? ((pageHeight: number) => pageHeight);
const BLOCK_SCALE_MIN = typesExports.BLOCK_SCALE_MIN ?? 0;
const BLOCK_SCALE_MAX = typesExports.BLOCK_SCALE_MAX ?? 0;
const blockScale = typesExports.blockScale ?? (() => 0);

const PAGE = { size: 'A4', orientation: 'portrait' } as const;
// A4 portrait: 595.28 x 841.89; compose.ts frames content at the report margin, a 30pt header and a 24pt footer.
const TOP = REPORT_MARGIN + 30;
const BOTTOM = 841.89 - REPORT_MARGIN - 24;
const EPS = 1e-6;

const compose = (blocks: ResolvedBlock[]): DocumentLayout => composeDocument({ name: 'Doc', page: PAGE, generatedAt: 'now', measure: estimateTextWidth, blocks });

const IDS: IdsReportBlock = { kind: 'ids-report', id: 'ids', variant: 'compact', benchmarks: true, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 10, passed: 7, failed: 3, passRate: 70 },
  checks: [{ id: 'walls', shortDescription: 'Walls', checked: 10, passed: 7, failed: 3, passRate: 70, rules: [] }] };
const MANUAL = manualReportBlockFromChecklist({
  checklist: { version: CHECKLIST_VERSION, name: 'Round 3', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'a', text: 'On time' }, { id: 'b', text: 'Named well' }] }] },
  answers: { a: { status: 'pass', updatedAt: 1 } }, modelName: 'tower.ifc', now: new Date(Date.UTC(2026, 8, 29)),
}, 'manual');
const rows = (n: number): TableRowOut[] => Array.from({ length: n }, (_, i) => ({ role: 'row' as const, cells: [`Wall ${i}`, 'Level 1'] }));
const blocksOfEveryKind = (scale?: number): ResolvedBlock[] => {
  const s = scale === undefined ? {} : { scale };
  return [
    { kind: 'text', id: 't', style: 'body', text: 'One short line', title: 'Heading', ...s },
    { kind: 'image', id: 'i', height: 100, align: 'center', caption: 'Logo', aspect: 2, ...s },
    { kind: 'chart', id: 'c', title: 'Chart', subtitle: '3 buckets', hasData: true, snapshot: false, height: 200, ...s },
    { kind: 'topic', id: 'p', title: 'Clash', lines: ['Open'], snapshotAspect: 2, ...s },
    { kind: 'table', id: 'tb', title: 'Walls', columns: [{ label: 'Name', numeric: false }, { label: 'Storey', numeric: false }], rows: rows(3), ...s },
    { ...IDS, ...s },
    { ...MANUAL, ...s },
  ];
};
const itemsOf = (layout: DocumentLayout): DrawnItem[] => layout.pages.flatMap((page) => page.items);
const texts = (layout: DocumentLayout) => itemsOf(layout).flatMap((item) => (item.kind === 'text' ? [item] : []));

/**
 * What a drawn item at scale 1 becomes at `s`: vertical positions about the frame's top, heights and
 * type sizes by `s`. Horizontal positions and widths are not mapped here: a scaled block is laid out in a
 * column `s` times narrower, so a full-width box stays full width and a right-aligned item stays at the
 * right edge; the widths that DO grow (a graphic's own width) are asserted by their own test.
 */
function zoomed(item: DrawnItem, s: number): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: item.kind, y: TOP + (item.y - TOP) * s };
  if ('size' in item) out.size = item.size * s;
  if ('h' in item) out.h = item.h * s;
  if (item.kind === 'table') out.scale = s;
  if (item.kind === 'chart') out.scale = s;
  return out;
}
function assertClose(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number') { assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-6, `${path}: ${String(actual)} vs ${expected}`); return; }
  if (Array.isArray(expected)) { assert.ok(Array.isArray(actual) && actual.length === expected.length, `${path}: length`); expected.forEach((e, i) => assertClose(actual[i], e, `${path}[${i}]`)); return; }
  if (expected && typeof expected === 'object') { const a = actual as Record<string, unknown>; for (const key of Object.keys(expected)) assertClose(a[key], (expected as Record<string, unknown>)[key], `${path}.${key}`); return; }
  assert.equal(actual, expected, path);
}

describe('block size in the composed pages (#6548)', () => {
  // Each block alone on a page, so it starts at the top of the frame and its position maps about that corner.
  for (const kind of ['text', 'image', 'chart', 'topic', 'table', 'ids-report', 'manual-report'] as const) {
    // The IDS and manual reports wrap their summary line in the 2x column: that reflow has its own test below.
    for (const s of kind === 'ids-report' || kind === 'manual-report' ? [0.5, 1.5] : [0.5, 1.5, 2]) {
      it(`${kind} at ${s}x draws every item, text size and box at ${s} times its size at 1x`, () => {
        const pick = (scale?: number) => blocksOfEveryKind(scale).filter((b) => b.kind === kind);
        const base = itemsOf(compose(pick()));
        const scaledItems = itemsOf(compose(pick(s)));
        assert.ok(base.length > 0, 'the block drew something');
        assert.equal(scaledItems.length, base.length, 'same items: nothing wrapped or paginated differently');
        base.forEach((item, i) => assertClose(scaledItems[i], zoomed(item, s), `${kind}[${i}]`));
        // A graphic with its own width (an image, a ring, a snapshot) grows by the factor; a box that spans the column keeps spanning it.
        base.forEach((item, i) => {
          const grown = scaledItems[i];
          if (item.kind === 'image' || item.kind === 'topic-snapshot') assert.ok(Math.abs((grown as typeof item).w - item.w * s) < EPS, `${item.kind} width`);
          if (item.kind === 'chart' || item.kind === 'table') assert.ok(Math.abs((grown as typeof item).w - item.w) < EPS, `${item.kind} still spans the column`);
        });
      });
    }
  }

  it('a chart keeps one proportion between its height and its text at every size, which height and fontSize alone do not', () => {
    const chartAt = (patch: Partial<Extract<ResolvedBlock, { kind: 'chart' }>>) => {
      const layout = compose([{ kind: 'chart', id: 'c', title: 'Chart', subtitle: '3 buckets', hasData: true, snapshot: false, height: 200, ...patch }]);
      return { title: texts(layout).find((t) => t.text === 'Chart')!.size, box: itemsOf(layout).find((i) => i.kind === 'chart')! as Extract<DrawnItem, { kind: 'chart' }> };
    };
    const ratio = (c: ReturnType<typeof chartAt>) => c.box.h / c.title;
    const one = ratio(chartAt({}));
    const base = chartAt({});
    for (const scale of [0.5, 0.75, 1.5, 2]) {
      const sized = chartAt({ scale });
      assert.ok(Math.abs(ratio(sized) - one) < EPS, `scale ${scale}: proportion`);
      assert.ok(Math.abs(sized.title - base.title * scale) < EPS && Math.abs(sized.box.h - base.box.h * scale) < EPS, `scale ${scale}: both moved`);
    }
    // The pre-existing knobs move one of the two: a text size alone leaves the chart box where it was.
    assert.ok(Math.abs(ratio(chartAt({ fontSize: 24 })) - one) > 1, 'fontSize alone changes the proportion');
  });

  it('reflows: text at 2x wraps into a column half as wide and every line still fits the page frame at its drawn size', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(12);
    const lines = (scale?: number) => texts(compose([{ kind: 'text', id: 't', style: 'body', text, ...(scale ? { scale } : {}) }]));
    const one = lines();
    const two = lines(2);
    assert.ok(two.length > one.length * 1.8, `${two.length} lines at 2x vs ${one.length} at 1x`);
    for (const line of two) assert.ok(estimateTextWidth(line.text, line.size, false) <= 595.28 - 2 * REPORT_MARGIN + EPS, line.text);
    assert.equal(two[0].size, 20);
    assert.ok(lines(0.5).length < one.length, 'fewer lines at 0.5x');
  });

  it('a table at 1.5x paginates by its larger rows: every chunk fits above the footer and no row is lost', () => {
    const layoutAt = (scale?: number) => compose([{ kind: 'table', id: 'tb', title: 'Walls', columns: [{ label: 'Name', numeric: false }], rows: rows(120).map((r) => ({ ...r, cells: [r.cells[0]] })), ...(scale ? { scale } : {}) }]);
    const chunks = (layout: DocumentLayout) => itemsOf(layout).flatMap((i) => (i.kind === 'table' ? [i] : []));
    const one = layoutAt();
    const big = layoutAt(1.5);
    assert.ok(big.pages.length > one.pages.length, 'more pages at 1.5x');
    assert.equal(chunks(big).reduce((n, c) => n + c.rows.length, 0), 120);
    for (const chunk of chunks(big)) assert.ok(chunk.y + (1 + chunk.rows.length) * 13.2 * 1.5 <= BOTTOM + EPS, `chunk at y ${chunk.y} with ${chunk.rows.length} rows`);
    assert.ok(layoutAt(0.5).pages.length < one.pages.length, 'fewer pages at 0.5x');
  });

  it('the gap between blocks does not scale, only the block does', () => {
    const body = (id: string, scale?: number): ResolvedBlock => ({ kind: 'text', id, style: 'body', text: 'x', ...(scale ? { scale } : {}) });
    const [a, b] = texts(compose([body('a', 2), body('b')]));
    // body: 10pt, line height 1.4 -> 14pt per line; A is drawn at 28pt, then the 10pt gap, then B's baseline at +10.
    assert.ok(Math.abs(a.y - (TOP + 20)) < EPS, `A baseline ${a.y}`);
    assert.ok(Math.abs(b.y - (TOP + 28 + 10 + 10)) < EPS, `B baseline ${b.y}`);
  });

  it('a tall scaled chart and image are still clamped inside the printable frame', () => {
    const layout = compose([
      { kind: 'chart', id: 'c', title: 'Chart', subtitle: '', hasData: true, snapshot: true, height: 600, scale: 2 },
      { kind: 'image', id: 'i', height: 600, align: 'left', aspect: 0.5, scale: 2 },
    ]);
    for (const item of itemsOf(layout)) if ('h' in item) assert.ok(item.y + item.h <= BOTTOM + EPS, `${item.kind} ends at ${item.y + item.h}`);
    assert.ok(scaledPageHeight(841.89, 0, 2) < 841.89, 'the frame a scaled block sees is shorter');
    assert.equal(scaledPageHeight(841.89, 0, 1), 841.89);
  });

  it('half-width blocks pair at different sizes and the row is as tall as its taller block', () => {
    const half = (id: string, scale?: number): ResolvedBlock => ({ kind: 'chart', id, title: id, subtitle: '', hasData: true, snapshot: false, height: 150, width: 'half', ...(scale ? { scale } : {}) });
    const next: ResolvedBlock = { kind: 'text', id: 'after', style: 'body', text: 'after' };
    const row = compose([half('a', 1.5), half('b'), next]);
    const charts = itemsOf(row).flatMap((i) => (i.kind === 'chart' ? [i] : []));
    assert.equal(charts.length, 2);
    assert.ok(charts[0].x < charts[1].x, 'side by side');
    assert.ok(charts[0].y < TOP + 60 && charts[1].y < TOP + 60, 'in one row at the top of the page');
    assert.ok(Math.abs(charts[0].h - charts[1].h * 1.5) < EPS, 'the scaled chart is 1.5x as tall');
    const after = texts(row).find((t) => t.text === 'after')!;
    assert.ok(after.y > charts[0].y + charts[0].h, 'the next block starts below the taller chart');
  });

  it('a scaled block that does not fit the rest of the page starts the next one instead of running into the footer', () => {
    // 620pt of spacer leaves about 88pt: the block fits there at 1x, but needs 116pt (text) or 141pt (table) at 2x.
    const spacer: ResolvedBlock = { kind: 'spacer', id: 'sp', height: 620 };
    const blocks: ResolvedBlock[] = [
      { kind: 'text', id: 't', style: 'title', text: 'Line one\nLine two', scale: 2 },
      { kind: 'table', id: 'tb', title: 'Walls', columns: [{ label: 'Name', numeric: false }], rows: rows(3).map((r) => ({ ...r, cells: [r.cells[0]] })), scale: 2 },
    ];
    for (const block of blocks) {
      const layout = compose([spacer, block]);
      assert.equal(layout.pages.length, 2, `${block.kind}: moved to a second page`);
      assert.equal(layout.pages[0].items.length, 0, `${block.kind}: nothing of it on the first page`);
      for (const item of layout.pages[1].items) assert.ok(item.y >= TOP - EPS, `${block.kind} starts at the top of the next page`);
    }
  });

  it('a half-width text that would outgrow the page at its size is not paired, by the same bound the preview uses', () => {
    // About 400 characters: it fits a half column at 1x, but at 2x the column is half as wide and every line twice as tall.
    const long = 'abcde '.repeat(66);
    const row = (scale?: number) => compose([
      { kind: 'text', id: 'a', style: 'body', text: long, width: 'half', ...(scale ? { scale } : {}) },
      { kind: 'text', id: 'b', style: 'body', text: 'second', width: 'half' },
    ]);
    const second = (layout: DocumentLayout) => texts(layout).find((t) => t.text === 'second')!;
    assert.ok(second(row()).x > REPORT_MARGIN + 100, 'at 1x the two sit side by side');
    assert.equal(second(row(2)).x, REPORT_MARGIN, 'at 2x the second falls back to the full-width flow');
  });

  it('a block without a scale composes exactly as a block at scale 1', () => {
    assert.deepEqual(compose(blocksOfEveryKind()), compose(blocksOfEveryKind(1)));
  });
});

describe('block size in what the PDF draws (#6548)', () => {
  function seams() {
    const log = { sizes: [] as number[], svg: [] as number[][], render: [] as number[][], tables: [] as Array<{ scale?: number }>, images: [] as number[][] };
    let size = 0;
    const s: DocumentPdfSeams = {
      createDoc: async () => ({
        addPage: () => {}, setFont: () => {}, setFontSize: (n) => { size = n; }, setTextColor: () => {}, fillRect: () => {},
        text: () => { log.sizes.push(size); },
        addImage: (_b, _f, x, y, w, h) => { log.images.push([x, y, w, h]); },
        svg: async (_svg, x, y, w, h) => { log.svg.push([x, y, w, h]); },
        table: (args) => { log.tables.push({ scale: args.scale }); },
        pageCount: () => 1, output: () => new Blob(['pdf']),
      }),
      renderSvg: (_agg, w, h) => { log.render.push([w, h]); return '<svg/>'; },
      capture: null, theme: { text: '#000', mutedText: '#666', axis: '#999', grid: '#eee', background: 'transparent', fontFamily: 'Helvetica' },
      now: () => new Date('2026-09-12T10:00:00Z'), imageSize: async () => ({ w: 200, h: 100 }),
    };
    return { s, log };
  }
  const chart = { id: 'k', title: 'Chart', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } } as const;
  const agg = { spec: chart, categories: ['a'], values: [1], total: 1, buckets: [{ key: 'a', label: 'a', value: 1, ids: [1] }] } as never; // only `categories.length` is read by the recording seam
  const generate = async (scale?: number) => {
    const { s, log } = seams();
    const sc = scale === undefined ? {} : { scale };
    const document: DocumentSpec = { version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page: PAGE, blocks: [
      { kind: 'chart', id: 'c', chart, snapshot: false, height: 200, ...sc },
      { kind: 'image', id: 'i', dataUrl: `data:image/png;base64,${btoa('png')}`, height: 100, align: 'left', ...sc },
      { kind: 'text', id: 't', style: 'body', text: 'Body', ...sc },
    ] };
    await generateDocumentPdf({ document, bindings: { models: [], activeModelId: null, today: new Date('2026-09-12') }, aggregations: new Map([['c', agg]]), chartMessages: new Map(), snapshotIds: () => [], topics: new Map(), tables: new Map() }, s);
    return log;
  };

  it('renders a scaled chart at its authored size and places it scale times larger; text and image grow with it', async () => {
    const one = await generate();
    const big = await generate(1.5);
    assert.deepEqual(one.render[0], [one.svg[0][2], one.svg[0][3]], 'unscaled: rendered at the box size');
    assert.ok(Math.abs(big.svg[0][2] - one.svg[0][2]) < EPS, 'the chart still spans the column');
    assert.ok(Math.abs(big.svg[0][3] - one.svg[0][3] * 1.5) < EPS, 'the placed box is 1.5x as tall');
    assert.ok(Math.abs(big.render[0][0] - big.svg[0][2] / 1.5) < EPS && Math.abs(big.render[0][1] - big.svg[0][3] / 1.5) < EPS, 'rendered at the placed box divided by the scale');
    assert.ok(Math.abs(big.render[0][1] - one.render[0][1]) < EPS, 'the chart is rendered at the same authored height, so its text keeps its proportion');
    assert.ok(Math.abs(big.images[0][3] - one.images[0][3] * 1.5) < EPS, 'image height');
    // The first three texts are the page header, footer and page number: not block content, so not scaled.
    // The rest are the chart's title and subtitle and the body line, each 1.5 times its size at 1x.
    assert.equal(big.sizes.length, one.sizes.length);
    assert.deepEqual(big.sizes.slice(0, 3), one.sizes.slice(0, 3));
    assert.equal(one.sizes.length, 6);
    big.sizes.slice(3).forEach((n, i) => assert.ok(Math.abs(n - one.sizes[i + 3] * 1.5) < EPS, `text ${i}: ${n} vs ${one.sizes[i + 3]}`));
  });

  it('hands the table seam the factor so font, padding and row height grow together', async () => {
    const table = async (scale?: number) => {
      const { s, log } = seams();
      const document: DocumentSpec = { version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page: PAGE, blocks: [{ kind: 'table', id: 'tb', ...(scale ? { scale } : {}), source: { kind: 'validation', rows: 'failed', columns: ['rule'] } }] };
      const state = { status: 'ok' as const, kind: 'validation' as const, model: { columns: [{ label: 'Rule', numeric: false }], rows: [{ role: 'row' as const, cells: ['R1'] }], totalRows: 1 } };
      await generateDocumentPdf({ document, bindings: { models: [], activeModelId: null, today: new Date('2026-09-12') }, aggregations: new Map(), chartMessages: new Map(), snapshotIds: () => [], topics: new Map(), tables: new Map([['tb', state]]) }, s);
      return log.tables;
    };
    assert.deepEqual(await table(1.5), [{ scale: 1.5 }]);
    assert.deepEqual(await table(), [{ scale: undefined }]);
  });
});

describe('block size in the saved format (#6548)', () => {
  const v10 = (blocks: DocumentSpec['blocks']) => JSON.stringify({ version: 10, id: 'old', name: 'Saved before block size existed', page: PAGE, blocks });
  const kinds = (extra: Record<string, unknown> = {}): DocumentSpec['blocks'] => [
    { kind: 'text', id: 't', style: 'body', text: 'x', ...extra },
    { kind: 'image', id: 'i', dataUrl: 'data:image/png;base64,AAAA', height: 40, align: 'left', ...extra },
    { kind: 'chart', id: 'c', chart: { id: 'k', title: 'C', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } }, snapshot: false, ...extra },
    { kind: 'topic', id: 'p', guid: 'g', snapshot: false, ...extra },
    { kind: 'table', id: 'tb', source: { kind: 'validation', rows: 'failed', columns: ['rule'] }, ...extra },
    { ...IDS, ...extra },
    { ...MANUAL, ...extra },
  ] as DocumentSpec['blocks'];

  it('a version 10 document loads as the current version with its blocks untouched, and composes as before', () => {
    const loaded = parseDocumentFile(v10(kinds()));
    assert.equal(loaded.version, DOCUMENT_VERSION);
    assert.ok(loaded.blocks.every((b) => !('scale' in b)), 'no block gains a scale');
    assert.ok(loaded.blocks.every((b) => blockScale(b) === 1), 'every block reads as 1');
  });

  it('a document from a newer version is still refused', () => {
    const errors = validateDocumentSpec({ ...JSON.parse(v10(kinds())), version: DOCUMENT_VERSION + 1 });
    assert.match(errors[0].message, /newer version of ifc-lite/);
    assert.throws(() => parseDocumentFile(JSON.stringify({ ...JSON.parse(v10(kinds())), version: DOCUMENT_VERSION + 1 })), /newer version/);
  });

  it('keeps a saved scale through export and import for every block kind', () => {
    const saved = JSON.stringify({ ...JSON.parse(v10(kinds({ scale: 1.25 }))), version: DOCUMENT_VERSION });
    assert.deepEqual(parseDocumentFile(saved).blocks.map((b) => blockScale(b)), kinds().map(() => 1.25));
  });

  it('accepts the bounds and refuses a scale outside them, naming the block', () => {
    const doc = (scale: unknown) => ({ ...JSON.parse(v10(kinds({ scale }))), version: DOCUMENT_VERSION });
    for (const ok of [BLOCK_SCALE_MIN, 1, BLOCK_SCALE_MAX]) assert.deepEqual(validateDocumentSpec(doc(ok)), [], String(ok));
    for (const bad of [BLOCK_SCALE_MIN - 0.01, BLOCK_SCALE_MAX + 0.01, 0, -1, '1.5', null, true]) {
      const errors = validateDocumentSpec(doc(bad));
      assert.deepEqual(errors.map((e) => e.path), kinds().map((_, i) => `blocks[${i}].scale`), String(bad));
      assert.match(errors[0].message, /between 0.5 and 2/);
    }
  });

  it('reads an absent or invalid factor as 1 and gives spacers and page breaks no scale', () => {
    assert.equal(blockScale({ kind: 'text' }), 1);
    assert.equal(blockScale({ kind: 'text', scale: 99 }), 1);
    assert.equal(blockScale({ kind: 'text', scale: Number.NaN }), 1);
    assert.equal(blockScale({ kind: 'text', scale: 1.5 }), 1.5);
    assert.equal(blockScale({ kind: 'spacer', scale: 1.5 }), 1);
  });

  it('refreshing a manual report keeps the block size the author chose', () => {
    const current = { ...MANUAL, scale: 1.5 };
    assert.equal(replaceManualReportSnapshot(current, { ...MANUAL, id: 'other' }).scale, 1.5);
  });
});
