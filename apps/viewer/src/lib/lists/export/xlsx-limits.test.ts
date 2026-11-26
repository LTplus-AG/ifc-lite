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
  await wb.xlsx.load(await (await toXlsx(model)).arrayBuffer());
  return wb;
}

describe('toXlsx Excel limits (#11463)', () => {
  it('exports a list whose name has illegal sheet characters', async () => {
    const wb = await load('Ground floor – Rooms & Areas [Draft]: v2/3', [['Sală', 1]]);
    const name = wb.worksheets[0].name;
    assert.ok(name.length <= 31 && !/[\\/?*[\]:]/.test(name), name);
  });
  it('fits a title, sheet name and cell without splitting a surrogate pair', async () => {
    const long = '😀'.repeat(20000);
    const wb = await load(long, [[`${'x'.repeat(32765)}😀tail`, 1]]);
    const ws = wb.worksheets[0];
    assert.equal(ws.name, '😀'.repeat(15));
    assert.equal(ws.getCell(1, 1).value, `${'😀'.repeat(16383)}…`);
    assert.equal(ws.getCell(5, 1).value, `${'x'.repeat(32765)}…`);
  });
  it('handles empty, quoted and reserved worksheet names', async () => {
    assert.equal((await load('', [])).worksheets[0].name, 'List');
    assert.equal((await load(" 'Sală' ", [])).worksheets[0].name, 'Sală');
    assert.equal((await load('HiStOrY', [])).worksheets[0].name, 'HiStOrY (1)');
  });
  it('caps a long column header, group label and totals row', async () => {
    const long = 'x'.repeat(40000);
    const cols: ColumnDefinition[] = [
      { id: 'n', source: 'attribute', propertyName: 'Name', label: long },
      { id: 'q', source: 'quantity', propertyName: 'Area' },
    ];
    const rows: ListRow[] = [{ entityId: 1, modelId: 'm', values: [long, 1] }];
    const model = buildExportModel({
      title: 't', columns: cols, rows, numericCols: [false, true], columnWidths: [120, 120], generatedAt: 'now',
      grouping: { columnId: 'n', columnIds: ['n'], sumColumnIds: ['q'] },
    });
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await toXlsx(model)).arrayBuffer());
    const ws = wb.worksheets[0];
    let checked = 0;
    ws.eachRow((row) => row.eachCell((cell) => {
      if (typeof cell.value === 'string') { checked += 1; assert.ok(cell.value.length <= 32767, String(cell.value.length)); }
    }));
    assert.ok(checked >= 4, `header, group, member and total strings were all checked (${checked})`);
  });
});
