/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Excel hard limits the XLSX list export must respect: a sheet name with
// `[ ] : * ? / \` made exceljs throw (export failed outright), and a cell over
// 32,767 characters made Excel offer to "recover" the file.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ColumnDefinition, ListRow } from '@ifc-lite/lists';
import { buildExportModel } from './model';
import { toXlsx } from './xlsx';

const columns: ColumnDefinition[] = [
  { id: 'n', source: 'attribute', propertyName: 'Name' },
  { id: 'q', source: 'quantity', propertyName: 'Area' },
];

async function load(title: string, values: Array<[string, number]>) {
  const rows: ListRow[] = values.map(([a, b], i) => ({ entityId: i, modelId: 'm', values: [a, b] }));
  const model = buildExportModel({ title, columns, rows, numericCols: [false, true], columnWidths: [120, 120], generatedAt: 'now' });
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await (await toXlsx(model)).arrayBuffer() as never);
  return wb;
}

describe('toXlsx Excel limits', () => {
  it('exports a list whose name has illegal sheet characters', async () => {
    const wb = await load('Ground floor – Rooms & Areas [Draft]: v2/3', [['Sală', 1]]);
    const name = wb.worksheets[0].name;
    assert.ok(name.length <= 31 && !/[\\/?*[\]:]/.test(name), name);
  });
  it('caps a cell at 32,767 characters', async () => {
    const wb = await load('long', [['x'.repeat(40000), 1]]);
    const cell = wb.worksheets[0].getCell(5, 1).value as string;
    assert.ok(cell.length <= 32767, String(cell.length));
  });
});
