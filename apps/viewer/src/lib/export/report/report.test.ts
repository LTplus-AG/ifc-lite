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
function agg(id: string, n: number, extra: Partial<Omit<ChartSpec, 'type' | 'dimension'>> = {}): Aggregation {
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

  it('caps the bucket table, says how many more, and heads the count column "Elements" for an elements-source chart', () => {
    const big = agg('big', 400);
    assert.equal(big.categories.length, 40);
    const table = bucketTable(big);
    assert.equal(table.rows.length, TABLE_MAX_ROWS + 1);
    assert.equal(table.rows.at(-1)![0], `… ${40 - TABLE_MAX_ROWS} more`);
    assert.equal(table.head[1], 'Elements', 'the elements source is genuinely 1:1 with elements');
    const layout = composeReport({ name: 'r', page: { size: 'A4', orientation: 'landscape' }, titleBlock: {}, snapshots: false, charts: [{ id: 'big', title: 'big', aggregation: big }, { id: 'none', title: 'none', aggregation: null }], generatedAt: 'now' });
    const blocks = layout.pages.flatMap((p) => p.blocks).filter((b) => b.kind === 'chart');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].snapshot, null);
    assert.equal(blocks[1].table.rows.length, 0);
  });

  it('a chart whose aggregate() threw gets a subtitle distinct from a chart that legitimately ran and found nothing (#5218)', () => {
    // `aggregate()` never returns null on its own (packages/charts/src/aggregate.ts) —
    // it either throws (dimension/measure column gone from the dataset) or
    // returns a full `Aggregation`, empty categories included. So
    // `aggregation: null` here is exactly ChartCard's own catch, i.e. "this
    // chart is broken", never "this chart ran and found nothing".
    const empty = agg('empty', 0);
    assert.equal(empty.categories.length, 0, 'a legitimately empty aggregation is a real object, not null');
    // And the broken case is real: a saved chart whose dimension column is
    // gone (e.g. after a model swap) throws, which ChartCard turns into null.
    const swapped: ChartDataset = { source: 'elements', columns: [{ id: 'kept', label: 'Kept', kind: 'category' }], rows: [{ ids: [1], values: ['a'] }], fingerprint: 'swapped' };
    assert.throws(() => aggregate({ id: 'g', title: 'gone', source: 'elements', type: 'bar', dimension: 'gone', measure: { agg: 'count' } }, swapped));
    const layout = composeReport({
      name: 'r',
      page: { size: 'A4', orientation: 'landscape' },
      titleBlock: {},
      snapshots: false,
      charts: [
        { id: 'broken', title: 'broken', aggregation: null },
        { id: 'empty', title: 'empty', aggregation: empty },
      ],
      generatedAt: 'now',
    });
    const [broken, emptyBlock] = layout.pages.flatMap((p) => p.blocks).filter((b) => b.kind === 'chart');
    assert.equal(broken.subtitle, 'Cannot aggregate — edit the chart');
    assert.notEqual(emptyBlock.subtitle, broken.subtitle, 'a real, empty aggregation must not read like a broken one');
    assert.notEqual(emptyBlock.subtitle, 'No data', 'this chart legitimately ran; its subtitle already shows 0 buckets/elements');
  });

  it('the bucket table calls a clash row a "Clashes" and a bcf row a "Topics", not "Elements" — a clash row carries two element ids (#5218)', () => {
    const clashDs: ChartDataset = {
      source: 'clash',
      columns: [{ id: 'rule', label: 'Rule', kind: 'category' }],
      // Every clash pair buckets into the same rule; a row's `ids` carries
      // BOTH elements of the pair, so a dataset with `n` rows touches `2n`
      // distinct elements — count-by-row and count-by-element disagree,
      // which is exactly the shape #5218 says the old "Elements" header hid.
      rows: Array.from({ length: 5 }, (_, i) => ({ ids: [i * 2 + 1, i * 2 + 2], values: ['Rule A'] })),
      fingerprint: 'clash-ds',
    };
    const clashAgg = aggregate({ id: 'c', title: 'Clashes', source: 'clash', type: 'bar', dimension: 'rule', measure: { agg: 'count' } }, clashDs);
    assert.equal(clashAgg.categories.length, 1);
    assert.equal(clashAgg.categories[0].count, 5, 'one row per clash pair');
    assert.equal(clashAgg.categories[0].ids.length, 10, 'ten distinct elements across five pairs');
    const clashTable = bucketTable(clashAgg);
    assert.equal(clashTable.head[1], 'Clashes');
    assert.equal(clashTable.rows[0][1], '5', 'the printed count is pairs (rows), matching the header noun, not the 10 elements involved');
    // The subtitle states the same count, so it must use the same noun.
    const clashLayout = composeReport({ name: 'r', page: { size: 'A4', orientation: 'landscape' }, titleBlock: {}, snapshots: false, charts: [{ id: 'c', title: 'Clashes', aggregation: clashAgg }], generatedAt: 'now' });
    const [clashBlock] = clashLayout.pages.flatMap((p) => p.blocks).filter((b) => b.kind === 'chart');
    assert.equal(clashBlock.subtitle, '1 bucket · 5 clashes');

    const bcfDs: ChartDataset = {
      source: 'bcf',
      columns: [{ id: 'status', label: 'Status', kind: 'category' }],
      rows: Array.from({ length: 3 }, (_, i) => ({ ids: [i + 1, i + 100, i + 200], values: ['Open'] })),
      fingerprint: 'bcf-ds',
    };
    const bcfAgg = aggregate({ id: 'b', title: 'Topics', source: 'bcf', type: 'bar', dimension: 'status', measure: { agg: 'count' } }, bcfDs);
    const bcfTable = bucketTable(bcfAgg);
    assert.equal(bcfTable.head[1], 'Topics');
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

  it('a broken chart and a genuinely empty chart print different body text, not both "No data" (#5218)', async () => {
    const empty = agg('empty', 0);
    const charts = [
      { id: 'broken', title: 'Broken chart', aggregation: null },
      { id: 'empty', title: 'Empty chart', aggregation: empty },
    ];
    const { seams, calls } = recordingSeams(async () => new Uint8Array(4));
    await generateReportPdf({ name: 'r', page: { size: 'A4', orientation: 'landscape' }, titleBlock: {}, snapshots: false, charts, snapshotIds: () => [] }, seams);
    const texts = calls.filter((c) => c.op === 'text').map((c) => c.args[0]);
    assert.ok(texts.includes('This chart could not be aggregated — edit it and re-export.'), `expected the broken-chart text, got: ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('No data for this chart.'), `expected the empty-chart text, got: ${JSON.stringify(texts)}`);
    assert.ok(!texts.includes('No data'), 'the broken chart must not fall back to the bare "No data" subtitle text');
  });

  it('without a renderer every snapshot box says so and nothing is captured', async () => {
    const { seams, calls } = recordingSeams(null);
    const result = await generateReportPdf({ name: 'r', page: { size: 'A4', orientation: 'landscape' }, titleBlock: {}, snapshots: true, charts: [{ id: 'a', title: 'a', aggregation: agg('a', 3) }], snapshotIds: () => [1] }, seams);
    assert.equal(result.snapshots, 0);
    assert.deepEqual(result.snapshotFailures, ['a']);
    assert.equal(calls.filter((c) => c.op === 'image').length, 0);
  });
});
