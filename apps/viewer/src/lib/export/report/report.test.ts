/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The coordination report (#3944): the page model the composer produces for
 * A4 portrait vs A3 landscape (block placement, page breaks, table caps),
 * and the draw sequence the generator issues against a recording document —
 * vector charts through the real ECharts SSR renderer, a failed snapshot
 * reported in place rather than aborting, page numbers on every page.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, renderChartSvg, DEFAULT_THEME, type Aggregation, type ChartDataset, type ChartSpec } from '@ifc-lite/charts';
import { composeReport, bucketTable, pageBox, TABLE_MAX_ROWS } from './compose.js';
import { generateReportPdf, type ReportDoc, type ReportPdfSeams } from './generate-report-pdf.js';

function dataset(n: number): ChartDataset {
  return {
    source: 'elements',
    columns: [{ id: 'T', label: 'Type', kind: 'category' }],
    rows: Array.from({ length: n }, (_, i) => ({ ids: [i + 1], values: [`Type ${i % 40}`] })),
    fingerprint: 't',
  };
}
function agg(id: string, n: number, extra: Partial<ChartSpec> = {}): Aggregation {
  return aggregate({ id, title: `Chart ${id}`, source: 'elements', type: 'bar', dimension: 'T', measure: { agg: 'count' }, ...extra }, dataset(n));
}

describe('composeReport', () => {
  it('puts the title block first and breaks pages when a chart block does not fit (A4 portrait), fewer pages on A3 landscape', () => {
    const charts = ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id, aggregation: agg(id, 60) }));
    const a4 = composeReport({ name: 'Weekly', page: { size: 'A4', orientation: 'portrait' }, titleBlock: { Project: 'X', Date: '2026-09-12', Empty: '' }, snapshots: true, charts, generatedAt: 'now' });
    assert.deepEqual(a4.size, pageBox({ size: 'A4', orientation: 'portrait' }));
    assert.equal(a4.pages[0].blocks[0].kind, 'title');
    const title = a4.pages[0].blocks[0];
    assert.ok(title.kind === 'title' && title.fields.length === 2, 'empty fields are dropped');
    // Every chart block is on a page where it fits below the previous block.
    for (const page of a4.pages) {
      let lastBottom = 0;
      for (const block of page.blocks) {
        if (block.kind !== 'chart') continue;
        assert.ok(block.chart.y >= lastBottom, `${block.title} overlaps on page ${page.index}`);
        assert.ok(block.table.y + block.table.rows.length * 12 <= a4.size.h, `${block.title} runs off the page`);
        lastBottom = block.table.y + block.table.rows.length * 12;
      }
    }
    assert.ok(a4.pages.length >= 2, `A4 portrait needs page breaks for 4 charts with snapshots, got ${a4.pages.length}`);
    // Portrait A4 is too narrow for chart + snapshot side by side; they stack.
    const first = a4.pages[0].blocks[1];
    assert.ok(first.kind === 'chart' && first.snapshot && first.snapshot.y > first.chart.y);

    const a3 = composeReport({ name: 'Weekly', page: { size: 'A3', orientation: 'landscape' }, titleBlock: {}, snapshots: true, charts, generatedAt: 'now' });
    assert.equal(a3.size.w, pageBox({ size: 'A3', orientation: 'landscape' }).w);
    assert.ok(a3.size.w > a3.size.h);
    const wide = a3.pages[0].blocks[1];
    assert.ok(wide.kind === 'chart' && wide.snapshot && wide.snapshot.y === wide.chart.y, 'landscape A3 puts chart and snapshot side by side');
    assert.ok(a3.pages.length <= a4.pages.length);
  });

  it('caps the bucket table and says how many more, and omits the snapshot box when snapshots are off or the chart is empty', () => {
    const big = agg('big', 400);
    assert.equal(big.categories.length, 40);
    const table = bucketTable(big);
    assert.equal(table.rows.length, TABLE_MAX_ROWS + 1);
    assert.equal(table.rows.at(-1)![0], `… ${40 - TABLE_MAX_ROWS} more`);
    const layout = composeReport({ name: 'r', page: { size: 'A4', orientation: 'landscape' }, titleBlock: {}, snapshots: false, charts: [{ id: 'big', title: 'big', aggregation: big }, { id: 'none', title: 'none', aggregation: null }], generatedAt: 'now' });
    const blocks = layout.pages.flatMap((p) => p.blocks).filter((b) => b.kind === 'chart');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].snapshot, null);
    assert.equal(blocks[1].subtitle, 'No data');
    assert.equal(blocks[1].table.rows.length, 0);
  });
});

interface Call { op: string; args: unknown[] }
function recordingSeams(capture: ReportPdfSeams['capture']): { seams: ReportPdfSeams; calls: Call[] } {
  const calls: Call[] = [];
  let pages = 1;
  const doc: ReportDoc = {
    addPage: (f, o) => { pages += 1; calls.push({ op: 'addPage', args: [f, o] }); },
    setFont: () => {},
    setFontSize: () => {},
    setTextColor: () => {},
    text: (t, x, y) => calls.push({ op: 'text', args: [t, x, y] }),
    addImage: (bytes, fmt, x, y, w, h) => calls.push({ op: 'image', args: [bytes.length, fmt, x, y, w, h] }),
    svg: async (svg, x, y, w, h) => { calls.push({ op: 'svg', args: [svg, x, y, w, h] }); },
    table: (t) => calls.push({ op: 'table', args: [t.head, t.body.length] }),
    pageCount: () => pages,
    output: () => new Blob(['pdf']),
  };
  return {
    seams: {
      createDoc: async (f, o) => { calls.push({ op: 'create', args: [f, o] }); return doc; },
      renderSvg: (aggregation, width, height, theme) => renderChartSvg({ aggregation, width, height, theme, showTitle: false }),
      capture,
      theme: DEFAULT_THEME,
      now: () => new Date(Date.UTC(2026, 8, 12, 12)),
    },
    calls,
  };
}

describe('generateReportPdf', () => {
  it('draws every chart as a real SVG with its labels, a snapshot per chart, the bucket table, and page numbers on every page', async () => {
    const charts = ['a', 'b', 'c'].map((id) => ({ id, title: `Chart ${id}`, aggregation: agg(id, 12) }));
    const { seams, calls } = recordingSeams(async (ids) => new Uint8Array(ids.length));
    const result = await generateReportPdf({ name: 'Weekly coordination', page: { size: 'A4', orientation: 'portrait' }, titleBlock: { Project: 'P' }, snapshots: true, charts, snapshotIds: (id) => Array.from(charts.find((c) => c.id === id)!.aggregation.categories[0].ids) }, seams);
    assert.equal(result.charts, 3);
    assert.equal(result.snapshots, 3);
    assert.deepEqual(result.snapshotFailures, []);
    assert.equal(calls[0].op, 'create');
    assert.deepEqual(calls[0].args, ['a4', 'portrait']);
    const svgs = calls.filter((c) => c.op === 'svg');
    assert.equal(svgs.length, 3);
    assert.ok((svgs[0].args[0] as string).startsWith('<svg'));
    assert.ok((svgs[0].args[0] as string).includes('Type 0'), 'the vector chart carries the bucket labels');
    assert.equal(calls.filter((c) => c.op === 'image').length, 3);
    assert.equal(calls.filter((c) => c.op === 'table').length, 3);
    const pageNumbers = calls.filter((c) => c.op === 'text' && String(c.args[0]).startsWith('Page ')).map((c) => c.args[0]);
    assert.equal(pageNumbers.length, result.pages);
    assert.equal(pageNumbers[0], `Page 1 / ${result.pages}`);
    assert.ok(calls.some((c) => c.op === 'text' && c.args[0] === 'Weekly coordination'));
    assert.ok(calls.some((c) => c.op === 'text' && c.args[0] === 'Project:'));
  });

  it('a snapshot that throws is reported in place and the rest of the report still renders', async () => {
    const charts = ['a', 'b'].map((id) => ({ id, title: `Chart ${id}`, aggregation: agg(id, 5) }));
    let n = 0;
    const { seams, calls } = recordingSeams(async () => { n += 1; if (n === 1) throw new Error('canvas lost'); return new Uint8Array(4); });
    const result = await generateReportPdf({ name: 'r', page: { size: 'A3', orientation: 'landscape' }, titleBlock: {}, snapshots: true, charts, snapshotIds: () => [1] }, seams);
    assert.equal(result.charts, 2);
    assert.equal(result.snapshots, 1);
    assert.deepEqual(result.snapshotFailures, ['Chart a']);
    assert.ok(calls.some((c) => c.op === 'text' && c.args[0] === '3D snapshot unavailable.'));
    assert.equal(calls.filter((c) => c.op === 'image').length, 1);
  });

  it('without a renderer every snapshot box says so and nothing is captured', async () => {
    const { seams, calls } = recordingSeams(null);
    const result = await generateReportPdf({ name: 'r', page: { size: 'A4', orientation: 'landscape' }, titleBlock: {}, snapshots: true, charts: [{ id: 'a', title: 'a', aggregation: agg('a', 3) }], snapshotIds: () => [1] }, seams);
    assert.equal(result.snapshots, 0);
    assert.deepEqual(result.snapshotFailures, ['a']);
    assert.equal(calls.filter((c) => c.op === 'image').length, 0);
  });
});
