/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Table block layout (#5142) through the real `composeDocument`, with the
 * character-estimate measure: a long table is chunked page by page with the
 * head on every chunk and the same column widths throughout, no chunk runs
 * past the footer, and title/head/first rows stay together.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pageBox, REPORT_MARGIN } from '../export/report/compose.js';
import { composeDocument, estimateTextWidth, type DrawnItem, type ResolvedBlock } from './compose.js';
import { TABLE_ROW_HEIGHT, TABLE_TITLE_HEIGHT, tableColumnWidths } from './compose-table.js';
import type { TableRowOut } from './resolve-table.js';

const A4 = { size: 'A4' as const, orientation: 'portrait' as const };
const HEADER = 30;
const FOOTER = 24;
const bottomOf = (h: number): number => h - REPORT_MARGIN - FOOTER;
const topOf = (): number => REPORT_MARGIN + HEADER;

const columns = [{ label: 'Name', numeric: false }, { label: 'Storey', numeric: false }, { label: 'NetVolume (m³)', numeric: true }];
const dataRows = (n: number, role: TableRowOut['role'] = 'row'): TableRowOut[] => Array.from({ length: n }, (_, i) => ({ cells: [`Wall ${i + 1}`, 'Level 1', String(i)], role }));

const table = (rows: TableRowOut[], extra: Partial<Extract<ResolvedBlock, { kind: 'table' }>> = {}): ResolvedBlock => ({ kind: 'table', id: 'tb', title: 'Walls', columns, rows, ...extra });

const compose = (blocks: ResolvedBlock[]) => composeDocument({ name: 'Doc', page: A4, blocks, generatedAt: 'now', measure: estimateTextWidth });
const tablesOf = (pages: ReturnType<typeof compose>['pages']) => pages.flatMap((p) => p.items.filter((i): i is Extract<DrawnItem, { kind: 'table' }> => i.kind === 'table').map((i) => ({ page: p.index, item: i })));

describe('table block layout (#5142)', () => {
  it('chunks 120 rows across pages, every chunk carrying the head with identical column widths, none past the footer', () => {
    const layout = compose([table(dataRows(120))]);
    const chunks = tablesOf(layout.pages);
    assert.ok(chunks.length >= 2, `expected several chunks, got ${chunks.length}`);
    const contentW = pageBox(A4).w - 2 * REPORT_MARGIN;
    for (const { item } of chunks) {
      assert.deepEqual(item.columns, chunks[0].item.columns, 'columns line up across pages');
      assert.ok(Math.abs(item.columns.reduce((a, c) => a + c.width, 0) - contentW) < 1e-6, 'widths sum to the content width');
      assert.ok(item.y + TABLE_ROW_HEIGHT * (1 + item.rows.length) <= bottomOf(layout.size.h) + 1e-6, `chunk on page ${item.y} runs past the footer`);
    }
    assert.equal(chunks.reduce((n, c) => n + c.item.rows.length, 0), 120, 'every row printed exactly once');
    assert.deepEqual(chunks.map((c) => c.page), chunks.map((_, i) => i), 'one chunk per page, in order');
    assert.deepEqual(chunks[0].item.columns.map((c) => c.align), ['left', 'left', 'right']);
  });

  it('fifty rows fit one A4 portrait page under a title — the default cap is one page', () => {
    const layout = compose([table(dataRows(50))]);
    assert.equal(layout.pages.length, 1);
    assert.equal(tablesOf(layout.pages).length, 1);
  });

  it('keeps title, head and the first rows together: a table starting at the page foot moves whole to the next page', () => {
    const h = pageBox(A4).h;
    const filler = bottomOf(h) - topOf() - TABLE_TITLE_HEIGHT - TABLE_ROW_HEIGHT; // room for the title + head only, no row
    const layout = compose([{ kind: 'spacer', id: 's', height: filler }, table(dataRows(5))]);
    const chunks = tablesOf(layout.pages);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].page, 1, 'the table starts on page 2');
    const title = layout.pages[1].items.find((i) => i.kind === 'text' && i.text === 'Walls');
    assert.ok(title, 'the title moved with it');
  });

  it('never ends a page on a group header: the header moves to the next chunk with its rows', () => {
    const h = pageBox(A4).h;
    // Fill so that exactly four rows fit after the title + head, then put a group header fourth.
    const filler = bottomOf(h) - topOf() - TABLE_TITLE_HEIGHT - TABLE_ROW_HEIGHT * 5;
    const rows: TableRowOut[] = [...dataRows(3), { cells: ['Level 2  (2)', '', ''], role: 'group' }, ...dataRows(2)];
    const layout = compose([{ kind: 'spacer', id: 's', height: filler }, table(rows)]);
    const chunks = tablesOf(layout.pages);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].item.rows.length, 3);
    assert.equal(chunks[1].item.rows[0].role, 'group');
  });

  it('a caption prints small and gray under the last chunk and is truncated to the content width', () => {
    const layout = compose([table(dataRows(3), { caption: 'x'.repeat(400) })]);
    const caption = layout.pages[0].items.find((i): i is Extract<DrawnItem, { kind: 'text' }> => i.kind === 'text' && i.size === 8);
    assert.ok(caption);
    assert.equal(caption.gray, 130);
    assert.ok(caption.text.endsWith('…') && caption.text.length < 400);
  });

  it('a message-only block prints its title and the message, and no table', () => {
    const layout = compose([table([], { message: 'Load a model to fill this table.' }), { kind: 'text', id: 't', style: 'body', text: 'after' }]);
    assert.equal(tablesOf(layout.pages).length, 0);
    const texts = layout.pages[0].items.filter((i): i is Extract<DrawnItem, { kind: 'text' }> => i.kind === 'text').map((i) => i.text);
    assert.deepEqual(texts, ['Walls', 'Load a model to fill this table.', 'after']);
  });

  it('an error state with an EMPTY message still prints as a message line, never as an empty grid (review finding)', () => {
    const layout = compose([table([], { message: '' }), { kind: 'text', id: 't', style: 'body', text: 'after' }]);
    assert.equal(tablesOf(layout.pages).length, 0, 'no head-only table');
    const texts = layout.pages[0].items.filter((i): i is Extract<DrawnItem, { kind: 'text' }> => i.kind === 'text').map((i) => i.text);
    assert.deepEqual(texts, ['Walls', '', 'after']);
  });

  it('column widths follow content, clamp to half the frame, and always sum to the frame', () => {
    const wide = [{ cells: ['w'.repeat(200), 'a', '1'], role: 'row' as const }];
    const widths = tableColumnWidths(columns, wide, 500, estimateTextWidth);
    assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 500) < 1e-9);
    assert.ok(widths[0] > widths[1] && widths[0] > widths[2], 'the wide column is the widest');
    // Unclamped, a 200-character cell would be ~25× the narrowest column; the half-frame clamp caps the ratio at 250/28.
    assert.ok(widths[0] / widths[1] <= 250 / 28 + 1e-9, `ratio ${widths[0] / widths[1]} exceeds the clamp`);
    assert.deepEqual(tableColumnWidths([], [], 500, estimateTextWidth), []);
  });
});
