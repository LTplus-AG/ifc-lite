/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ColumnDefinition, ListRow } from '@ifc-lite/lists';
import { buildExportModel, orderExportModelGroups } from '../lists/export/model';
import { flattenExportModel } from './resolve-table';
import { composeDocument, estimateTextWidth } from './compose';
import { TABLE_ROW_HEIGHT } from './compose-table';
import { REPORT_MARGIN } from '../export/report/compose';
import { tableHeaderStyle, DEFAULT_TABLE_HEADER_BACKGROUND } from '../table-header-style';
import { contrastRatio, isRgbColor } from '../color-contrast';
import { DOCUMENT_VERSION, validateDocumentSpec } from './types';
import { parseDocumentFile } from './persistence';
import { legibleAnnotationTextColor } from '../annotation-ink';
import { getThemeClearColor } from '@/utils/viewportUtils';

const columns: ColumnDefinition[] = [
  { id: 'parent', source: 'attribute', propertyName: 'ObjectType' },
  { id: 'child', source: 'attribute', propertyName: 'Name' },
  { id: 'volume', source: 'quantity', propertyName: 'NetVolume' },
];
// Counts deliberately disagree with labels at both levels. A/B have equal
// counts, so the canonical label tie-breaker must remain stable.
const rows: ListRow[] = [
  ['C', 'Z', 1], ['C', 'Z', 2], ['C', 'Z', 3], ['C', 'A', 4],
  ['B', 'X', 5], ['B', 'X', 6], ['A', 'LZ', 7], ['A', 'LA', 8],
].map((values, i) => ({ entityId: i + 1, modelId: 'm', values }));
const input = {
  title: 'Nested volumes', columns, rows, numericCols: [false, false, true], columnWidths: [], generatedAt: 'now',
  grouping: { columnId: 'parent', columnIds: ['parent', 'child'], sumColumnIds: ['volume'] },
};
const paths = (model: ReturnType<typeof buildExportModel>) => model.groups?.map((g) => g.path.join('/'));
const labels = { more: (n: number) => `${n} more`, total: (n: number) => `Total ${n}` };

describe('Document table options (#6489)', () => {
  it('orders every nesting level through the canonical grouping while retaining ties, leaf rows and totals', () => {
    const model = buildExportModel(input);
    const original = structuredClone(model);
    assert.deepEqual(paths(model), ['C', 'C/Z', 'C/A', 'A', 'A/LA', 'A/LZ', 'B', 'B/X']);
    const alphabetical = orderExportModelGroups(model, 'label');
    assert.deepEqual(paths(alphabetical), ['A', 'A/LA', 'A/LZ', 'B', 'B/X', 'C', 'C/A', 'C/Z']);
    assert.deepEqual(alphabetical.groups?.filter((g) => g.level === 1).flatMap((g) => g.rows.map((r) => r[2])), [8, 7, 5, 6, 4, 1, 2, 3]);
    assert.deepEqual(alphabetical.groups?.filter((g) => g.level === 0).map((g) => [g.label, g.count, g.sums.volume, g.rows.length]), [['A', 2, 15, 0], ['B', 2, 11, 0], ['C', 4, 10, 0]]);
    assert.deepEqual(alphabetical.totals, { count: 8, sums: { volume: 36 } });
    assert.deepEqual(model, original, 'two document blocks can order one cached result independently');
    assert.deepEqual(orderExportModelGroups(alphabetical, 'count'), original);
    assert.equal(orderExportModelGroups(model), model, 'old documents retain the existing projection without rebuilding');
    const capped = flattenExportModel(model, 1, labels, 'label');
    assert.deepEqual(capped.rows.filter((r) => r.role === 'row').map((r) => r.cells), [['A', 'LA', '8']]);
    assert.equal(capped.more, 7, 'row caps apply after the selected ordering');
    assert.equal(capped.totalRows, 8);
    assert.equal(capped.rows.at(-2)?.role, 'more');
    assert.equal(capped.rows.at(-1)?.role, 'total');
  });

  it('keeps schedules on the same nested ordering with exact counts and numeric totals', () => {
    const model = buildExportModel({ ...input, grouping: { ...input.grouping, view: 'schedule' } });
    const alphabetical = orderExportModelGroups(model, 'label');
    assert.deepEqual(alphabetical.schedule?.rows, [['A', 'LA', 1, 8], ['A', 'LZ', 1, 7], ['B', 'X', 2, 11], ['C', 'A', 1, 4], ['C', 'Z', 3, 6]]);
    assert.deepEqual(alphabetical.schedule?.columns.map((c) => [c.id, c.numeric]), [['parent', false], ['child', false], ['__count', true], ['volume', true]]);
    const flat = flattenExportModel(model, 3, labels, 'label');
    assert.equal(flat.more, 2);
    assert.deepEqual(flat.rows.filter((r) => r.role === 'row').map((r) => r.cells), [['A', 'LA', '1', '8'], ['A', 'LZ', '1', '7'], ['B', 'X', '2', '11']]);
  });

  it('keeps old document defaults and rejects invalid ordering or opaque RGB overrides at import', () => {
    const block = { kind: 'table', id: 'table', source: { kind: 'list', list: { id: 'list', createdAt: 1, updatedAt: 1, name: 'List', entityTypes: [], groups: [], columns, grouping: input.grouping } } };
    const document = { version: DOCUMENT_VERSION, id: 'doc', name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, blocks: [block] };
    assert.deepEqual(validateDocumentSpec(document), []);
    for (let version = 1; version <= DOCUMENT_VERSION; version++) {
      const migrated = parseDocumentFile(JSON.stringify({ ...document, version }));
      assert.deepEqual(validateDocumentSpec(migrated), []);
      assert.equal('groupOrder' in migrated.blocks[0], false);
      assert.equal('headerBackground' in migrated.blocks[0], false);
    }
    for (const groupOrder of ['count', 'label']) assert.deepEqual(validateDocumentSpec({ ...document, blocks: [{ ...block, groupOrder, headerBackground: '#aB09Ef' }] }), []);
    for (const value of ['largest', '', 4, null]) assert.ok(validateDocumentSpec({ ...document, blocks: [{ ...block, groupOrder: value }] }).some((e) => e.path.endsWith('.groupOrder')));
    for (const value of ['red', '#abc', '#000000ff', '#12345g', '', null]) {
      assert.equal(isRgbColor(value), false);
      assert.ok(validateDocumentSpec({ ...document, blocks: [{ ...block, headerBackground: value }] }).some((e) => e.path.endsWith('.headerBackground')));
    }
  });

  it('chooses readable black or white ink for opaque header colours and preserves the existing palette', () => {
    assert.deepEqual(tableHeaderStyle(), { backgroundColor: DEFAULT_TABLE_HEADER_BACKGROUND, textColor: '#ffffff' });
    assert.equal(tableHeaderStyle('#ffffff').textColor, '#000000');
    assert.equal(tableHeaderStyle('#000000').textColor, '#ffffff');
    assert.equal(tableHeaderStyle('#767676').textColor, '#000000');
    assert.equal(contrastRatio([0, 0, 0], [1, 1, 1]), 21);
    for (const r of [0, 51, 102, 153, 204, 255]) for (const g of [0, 51, 102, 153, 204, 255]) for (const b of [0, 51, 102, 153, 204, 255]) {
      const color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      const style = tableHeaderStyle(color);
      const ink = style.textColor === '#000000' ? [0, 0, 0] : [1, 1, 1];
      assert.ok(contrastRatio([r / 255, g / 255, b / 255], ink) >= 4.5, `${color} meets AA body-text contrast`);
    }
  });

  it('preserves authored annotation ink and alpha while improving dark labels after the shared contrast extraction', () => {
    const white = [1, 1, 1, 0.6];
    const black = [0, 0, 0, 0.4];
    assert.deepEqual(legibleAnnotationTextColor(white, 'dark'), white);
    assert.deepEqual(legibleAnnotationTextColor(black, 'light'), black);
    for (const theme of ['dark', 'light', 'colorful'] as const) {
      const backdrop = theme === 'colorful' ? [0xdd / 255, 0xe3 / 255, 0xf0 / 255] : getThemeClearColor(theme);
      const adjusted = legibleAnnotationTextColor([0.1, 0.2, 0.3, 0.4], theme);
      assert.equal(adjusted[3], 0.4, 'authored alpha survives contrast correction');
      assert.ok(contrastRatio(adjusted, backdrop) >= 3, `${theme} labels remain readable`);
    }
  });

  it('carries the selected header palette through every paginated chunk without changing row bounds', () => {
    const palette = tableHeaderStyle('#ffee88');
    const flat = flattenExportModel(buildExportModel(input), 8, labels, 'label');
    const body = Array.from({ length: 160 }, (_, i) => ({ cells: [`Row ${i}`, String(i)], role: 'row' as const }));
    const layout = composeDocument({ name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [{ kind: 'table', id: 'table', title: 'Palette', columns: flat.columns.slice(0, 2), rows: body, headerStyle: palette }] });
    const chunks = layout.pages.flatMap((page) => page.items.filter((item) => item.kind === 'table'));
    assert.ok(chunks.length > 2);
    assert.equal(chunks.reduce((n, chunk) => n + chunk.rows.length, 0), 160);
    for (const chunk of chunks) {
      assert.deepEqual(chunk.headerStyle, palette);
      assert.ok(chunk.y + (chunk.rows.length + 1) * TABLE_ROW_HEIGHT <= layout.size.h - REPORT_MARGIN - 24);
    }
  });
});
