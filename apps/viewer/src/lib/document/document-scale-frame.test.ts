/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A scaled block (#6548) lays out in a virtual frame `1 / scale` as wide and tall and is then drawn `scale`
 * times larger. Every decision the composer takes from that frame has to be the one it takes at 100 %:
 * a chart keeps its side-by-side or stacked arrangement, a pair of half-width blocks stays one row exactly
 * when the row fits the printable frame, and nothing is drawn outside the frame at any size.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_MARGIN } from '../export/report/compose.js';
import { composeDocument, estimateTextWidth, type DocumentLayout, type DrawnItem, type ResolvedBlock } from './compose.js';
import { manualReportBlockFromChecklist } from './manual-report.js';
import { CHECKLIST_VERSION } from '../validation/manual/checklist.js';
import type { IdsReportBlock } from './types.js';

// Read dynamically with fallbacks that fail the assertions, so that with the production change reverted this
// file still loads and fails by assertion instead of dying at import (as `document-scale.test.ts` does).
const composeExports: { pageFrameHeight?: (pageHeight: number, headingExtraHeight?: number) => number; rowFitsFrame?: (rowHeight: number, frameHeight: number) => boolean } = await import('./compose.js');
const pageFrameHeight = composeExports.pageFrameHeight ?? ((): number => Number.NaN);
const rowFitsFrame = composeExports.rowFitsFrame ?? ((): boolean => false);

type Page = { size: 'A4' | 'A3'; orientation: 'portrait' | 'landscape' };
const PAGES: Page[] = [{ size: 'A4', orientation: 'portrait' }, { size: 'A4', orientation: 'landscape' }, { size: 'A3', orientation: 'portrait' }, { size: 'A3', orientation: 'landscape' }];
const SCALES = [0.5, 1, 1.5, 2];
const FOOTER = 24;

const compose = (blocks: ResolvedBlock[], page: Page): DocumentLayout => composeDocument({ name: 'Doc', page, generatedAt: 'now', measure: estimateTextWidth, blocks });
const sc = (scale: number): { scale?: number } => (scale === 1 ? {} : { scale });
const lorem = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} of a long paragraph that wraps.`).join(' ');

const checks = (n: number): IdsReportBlock['checks'] => Array.from({ length: n }, (_, i) => ({
  id: `c${i}`, shortDescription: `Specification number ${i}`, checked: 10, passed: 7, failed: 3, passRate: 70,
  rules: [0, 1, 2].map((r) => ({ id: `r${i}${r}`, name: `Rule ${r}`, shortDescription: `Requirement ${r} of specification ${i}`, checked: 10, passed: 7, failed: 3, passRate: 70 })),
}));
const ids = (variant: IdsReportBlock['variant'], benchmarks: boolean): IdsReportBlock => ({
  kind: 'ids-report', id: 'ids', ...(variant ? { variant } : {}), benchmarks, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 10, passed: 7, failed: 3, passRate: 70 }, checks: checks(12),
});
const manual = manualReportBlockFromChecklist({
  checklist: { version: CHECKLIST_VERSION, name: 'Round 3', groups: [
    { id: 'g1', name: 'Delivery', items: [{ id: 'a', text: 'On time' }, { id: 'b', text: 'Named according to the naming convention agreed in the project execution plan' }] },
    { id: 'g2', name: 'Quality', items: [{ id: 'c', text: 'No clashes' }, { id: 'd', text: 'Model is georeferenced' }] }] },
  answers: { a: { status: 'pass', updatedAt: 1 }, c: { status: 'fail', updatedAt: 1 } }, modelName: 'tower.ifc', now: new Date(Date.UTC(2026, 8, 29)),
}, 'manual');
const chart = (id: string, patch: Partial<Extract<ResolvedBlock, { kind: 'chart' }>>): ResolvedBlock => ({ kind: 'chart', id, title: 'Chart', subtitle: '3 buckets', hasData: true, snapshot: true, ...patch });
const tableRows = Array.from({ length: 120 }, (_, i) => ({ role: 'row' as const, cells: Array.from({ length: 8 }, (_, c) => `Cell ${i} of column ${c} with some length`) }));

/** Every kind of block, the awkward settings of each, and the half-width pairs, as the blocks of one document. */
const SHAPES: Record<string, (scale: number) => ResolvedBlock[]> = {
  text: (s) => [{ kind: 'text', id: 't', style: 'body', text: lorem, title: 'Heading', ...sc(s) }],
  image: (s) => [{ kind: 'image', id: 'i', height: 300, align: 'center', caption: 'Logo', aspect: 2, ...sc(s) }],
  'tall image with title and caption': (s) => [{ kind: 'image', id: 'i', height: 600, align: 'center', caption: 'Logo', title: 'Title', aspect: 0.5, ...sc(s) }],
  'tall image bare': (s) => [{ kind: 'image', id: 'i', height: 600, align: 'left', aspect: 0.25, ...sc(s) }],
  'tall chart with snapshot and large type': (s) => [chart('c', { height: 600, fontSize: 24, ...sc(s) })],
  'small chart': (s) => [chart('c', { height: 120, fontSize: 6, snapshot: false, ...sc(s) })],
  'default chart with snapshot': (s) => [chart('c', { ...sc(s) })],
  'topic with snapshot': (s) => [{ kind: 'topic', id: 'p', title: 'Clash', lines: Array.from({ length: 40 }, (_, i) => `Line ${i} of the topic description that wraps around`), snapshotAspect: 2, ...sc(s) }],
  table: (s) => [{ kind: 'table', id: 'tb', title: 'Walls', caption: 'cap', columns: Array.from({ length: 8 }, (_, c) => ({ label: `Column ${c}`, numeric: false })), rows: tableRows, ...sc(s) }],
  'ids compact': (s) => [{ ...ids('compact', true), ...sc(s) }],
  'ids compact without ring': (s) => [{ ...ids('compact', false), ...sc(s) }],
  'ids long': (s) => [{ ...ids('long', true), ...sc(s) }],
  'ids classic': (s) => [{ ...ids(undefined, true), ...sc(s) }],
  'manual report': (s) => [{ ...manual, ...sc(s) }],
  'manual report compact': (s) => [{ ...manual, variant: 'compact', ...sc(s) }],
  'text with a 24 pt heading strip': (s) => [{ kind: 'text', id: 't', style: 'body', text: lorem, title: 'Heading', titleFontSize: 24, titleBackgroundColor: '#336699', ...sc(s) }],
  'tall image with a 24 pt heading': (s) => [{ kind: 'image', id: 'i', height: 600, align: 'center', caption: 'Logo', title: 'Title', titleFontSize: 24, aspect: 0.5, ...sc(s) }],
  'tall chart with snapshot and a 24 pt heading': (s) => [chart('c', { height: 600, title: 'Chart', titleFontSize: 24, titleBackgroundColor: '#336699', ...sc(s) })],
  'topic with a 24 pt heading': (s) => [{ kind: 'topic', id: 'p', title: 'Clash', titleFontSize: 24, lines: Array.from({ length: 40 }, (_, i) => `Line ${i} of the topic description that wraps around`), snapshotAspect: 2, ...sc(s) }],
  'table with a 24 pt heading': (s) => [{ kind: 'table', id: 'tb', title: 'Walls', titleFontSize: 24, columns: [{ label: 'Name', numeric: false }], rows: tableRows.map((row) => ({ ...row, cells: [row.cells[0]] })), ...sc(s) }],
  'ids compact with a 24 pt heading and stamp rows': (s) => [{ ...ids('compact', true), titleFontSize: 24, reportModels: [{ name: 'tower.ifc' }, { name: 'a second model with a long name.ifc' }], ...sc(s) }],
  'ids compact, specifications only': (s) => [{ ...ids('compact', true), specificationsOnly: true, reportModels: [{ name: 'tower.ifc' }], ...sc(s) }],
  'ids long with stamp rows': (s) => [{ ...ids('long', true), reportModels: [{ name: 'tower.ifc' }], ...sc(s) }],
  'manual report with a 24 pt heading and stamp rows': (s) => [{ ...manual, titleFontSize: 24, reportModels: [{ name: 'tower.ifc' }], ...sc(s) }],
  'half charts with snapshot, tall': (s) => [chart('a', { height: 600, width: 'half', ...sc(s) }), chart('b', { height: 600, width: 'half', ...sc(s) })],
  'half charts with snapshot, default': (s) => [chart('a', { width: 'half', ...sc(s) }), chart('b', { width: 'half', ...sc(s) })],
  'half image beside half chart': (s) => [{ kind: 'image', id: 'i', height: 300, align: 'center', aspect: 1, width: 'half', ...sc(s) }, chart('b', { width: 'half', height: 400, ...sc(s) })],
  'half texts at two sizes': (s) => [{ kind: 'text', id: 'a', style: 'body', text: lorem.slice(0, 300), width: 'half', ...sc(s) }, { kind: 'text', id: 'b', style: 'body', text: lorem.slice(0, 300), width: 'half', ...sc(s === 1 ? 1 : 3 - s) }],
};

const dims = (layout: DocumentLayout) => ({ w: layout.size.w, h: layout.size.h });

/** Every way an item can leave the printable frame: below the footer line, above the header, or past the right margin. */
function outsideFrame(layout: DocumentLayout): string[] {
  const { w, h } = dims(layout);
  const bottom = h - REPORT_MARGIN - FOOTER;
  const right = w - REPORT_MARGIN;
  const found: string[] = [];
  layout.pages.forEach((page, pageIndex) => page.items.forEach((item: DrawnItem, index) => {
    const at = `page ${pageIndex} item ${index} (${item.kind})`;
    if (item.kind === 'text') {
      const textRight = item.x + estimateTextWidth(item.text, item.size, item.bold);
      if (item.y > bottom + 1e-6) found.push(`${at}: baseline ${item.y.toFixed(1)} below ${bottom.toFixed(1)}`);
      if (textRight > right + 0.5) found.push(`${at}: right edge ${textRight.toFixed(1)} past ${right.toFixed(1)}`);
      return;
    }
    const [boxRight, boxBottom] = item.kind === 'ring' ? [item.x + item.size, item.y + item.size]
      : item.kind === 'table' ? [item.x + item.w, item.y + (item.rows.length + 1) * 13.2 * (item.scale ?? 1)]
      : [item.x + item.w, item.y + item.h];
    if (boxBottom > bottom + 1e-6) found.push(`${at}: bottom ${boxBottom.toFixed(1)} below ${bottom.toFixed(1)}`);
    if (boxRight > right + 0.5) found.push(`${at}: right edge ${boxRight.toFixed(1)} past ${right.toFixed(1)}`);
  }));
  return found;
}

describe('a scaled block stays inside the printable frame (#6548)', () => {
  for (const [name, build] of Object.entries(SHAPES)) {
    it(`${name}: nothing is drawn outside the frame at any size on A4 and A3, portrait and landscape`, () => {
      for (const page of PAGES) for (const scale of SCALES) {
        const found = outsideFrame(compose(build(scale), page));
        assert.deepEqual(found, [], `${page.size} ${page.orientation} at ${scale}x`);
      }
    });
  }
});

describe('a scaled chart keeps the arrangement it has at 100 % (#6548)', () => {
  const arrangement = (layout: DocumentLayout): 'beside' | 'stacked' | 'none' => {
    const items = layout.pages.flatMap((page) => page.items);
    const plot = items.find((item) => item.kind === 'chart');
    const snapshot = items.find((item) => item.kind === 'snapshot');
    if (!plot || !snapshot) return 'none';
    return Math.abs(snapshot.y - plot.y) < 1e-6 ? 'beside' : 'stacked';
  };

  for (const page of PAGES) {
    it(`${page.size} ${page.orientation}: the snapshot sits where it does at 100 % for every size`, () => {
      const reference = arrangement(compose([chart('c', {})], page));
      assert.notEqual(reference, 'none', 'the reference chart prints a snapshot');
      for (const scale of [0.5, 0.75, 1.25, 1.5, 2]) {
        assert.equal(arrangement(compose([chart('c', sc(scale))], page)), reference, `${scale}x`);
      }
    });
  }

  it('an A4 landscape chart with a snapshot at 200 % ends above the footer, as the report that found it printed it 62.7 pt into it', () => {
    const layout = compose([chart('c', { scale: 2 })], { size: 'A4', orientation: 'landscape' });
    const bottom = layout.size.h - REPORT_MARGIN - FOOTER;
    const lowest = Math.max(...layout.pages[0].items.flatMap((item) => ('h' in item ? [item.y + item.h] : [])));
    assert.ok(lowest <= bottom + 1e-6, `lowest box ${lowest.toFixed(1)} against the frame bottom ${bottom.toFixed(1)}`);
    assert.equal(layout.pages.length, 1);
  });
});

describe('a pair of half-width blocks is one row exactly when the row fits the frame (#6548)', () => {
  const steps = Array.from({ length: 31 }, (_, i) => Math.round((0.5 + i * 0.05) * 100) / 100);
  const pairedOnOnePage = (layout: DocumentLayout): boolean => {
    const plots = layout.pages.flatMap((page, pageIndex) => page.items.flatMap((item) => (item.kind === 'chart' ? [{ pageIndex, y: item.y, w: item.w }] : [])));
    return plots.length === 2 && plots[0].pageIndex === plots[1].pageIndex && Math.abs(plots[0].y - plots[1].y) < 1e-6 && plots[0].w < layout0Width(layout) / 2;
  };
  const layout0Width = (layout: DocumentLayout): number => layout.size.w - 2 * REPORT_MARGIN;

  for (const page of PAGES.slice(0, 2)) {
    it(`two half-width charts that clamp to the frame pair at every size from 0.5 to 2 in steps of 0.05 (${page.size} ${page.orientation})`, () => {
      const unpaired = steps.filter((s) => !pairedOnOnePage(compose([chart('a', { height: 600, width: 'half', ...sc(s) }), chart('b', { height: 600, width: 'half', ...sc(s) })], page)));
      assert.deepEqual(unpaired, [], 'sizes at which the clamped row split into two full-width charts');
    });
  }

  it('the row that equals the frame height fits, one that is a point taller does not', () => {
    const frame = pageFrameHeight(841.89, 0);
    assert.equal(rowFitsFrame(frame, frame), true);
    assert.equal(rowFitsFrame(frame + 1e-9, frame), true, 'rounding noise from deriving the same height by different arithmetic');
    assert.equal(rowFitsFrame(frame + 1, frame), false);
  });
});

describe('tables and reports decide nothing from the width of their column (#6548)', () => {
  const page: Page = { size: 'A4', orientation: 'landscape' };
  const graphics = (layout: DocumentLayout) => layout.pages.flatMap((p) => p.items);

  it('a table keeps every row, in order, at every size', () => {
    for (const scale of SCALES) {
      const rows = graphics(compose(SHAPES.table(scale), page)).flatMap((item) => (item.kind === 'table' ? item.rows.map((row) => row.cells[0]) : []));
      assert.deepEqual(rows, tableRows.map((row) => row.cells[0]), `${scale}x`);
    }
  });

  for (const name of ['ids compact', 'ids long', 'manual report']) {
    it(`${name}: draws the same rings at every size`, () => {
      const rings = (scale: number) => graphics(compose(SHAPES[name](scale), page)).filter((item) => item.kind === 'ring').map((item) => (item as Extract<DrawnItem, { kind: 'ring' }>).counts);
      const reference = rings(1);
      assert.ok(reference.length > 0, 'the report draws its rings');
      for (const scale of [0.5, 1.5, 2]) assert.deepEqual(rings(scale), reference, `${scale}x`);
    });
  }
});
