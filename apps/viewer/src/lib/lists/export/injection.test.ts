/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spreadsheet formula injection (CWE-1236) guard for list exports (#1790
 * review): group labels, cell values and custom column headers all derive from
 * attacker-controllable IFC values and must be neutralized before Excel /
 * LibreOffice / Sheets treats a leading =/+/-/@/TAB/CR as a live formula. CSV
 * and XLSX share `neutralizeSpreadsheetFormula`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ColumnDefinition, ListRow } from '@ifc-lite/lists';
import { buildExportModel, neutralizeSpreadsheetFormula } from './model';
import { toCsv } from './csv';
import { toXlsx } from './xlsx';

describe('neutralizeSpreadsheetFormula (#1790 review, CWE-1236)', () => {
  it('prefixes an apostrophe to every formula-trigger lead char', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      assert.strictEqual(neutralizeSpreadsheetFormula(s), `'${s}`);
    }
  });
  it('leaves benign strings untouched', () => {
    for (const s of ['Building A', 'A Level 0', 'IfcWall', '3.14', '']) {
      assert.strictEqual(neutralizeSpreadsheetFormula(s), s);
    }
  });
  it('strips a leading BOM so a BOM-hidden marker still gets guarded', () => {
    assert.strictEqual(neutralizeSpreadsheetFormula('\uFEFF=evil'), `'=evil`);
  });
});

// A model whose group label AND a cell value are formula markers.
const columns: ColumnDefinition[] = [
  { id: 'grp', source: 'attribute', propertyName: 'Group' },
  { id: 'name', source: 'attribute', propertyName: 'Name' },
];
const rows: ListRow[] = [
  { entityId: 1, modelId: 'm', values: ['=cmd|calc', '=HYPERLINK("http://evil")'] },
];
const input = {
  title: 'List',
  columns,
  rows,
  numericCols: [false, false],
  columnWidths: [120, 120],
  generatedAt: 'now',
  grouping: { columnId: 'grp', sumColumnIds: [] },
};

describe('list exports neutralize formula injection in group labels and cells', () => {
  it('CSV guards the Group path cell and the value cell', () => {
    const csv = toCsv(buildExportModel(input));
    // The malicious group label is quoted-and-apostrophized, never bare "=cmd".
    assert.ok(!/(^|,)=cmd/m.test(csv), 'bare =cmd formula must not appear in CSV');
    assert.ok(csv.includes(`'=cmd|calc`), 'group label must be apostrophe-guarded');
    assert.ok(csv.includes(`'=HYPERLINK`), 'value cell must be apostrophe-guarded');
  });

  it('XLSX writes the group header and value cells as guarded text', async () => {
    const blob = await toXlsx(buildExportModel(input));
    const ab = await blob.arrayBuffer();
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(ab);
    const ws = wb.worksheets[0];
    let sawGuardedGroup = false;
    let sawGuardedValue = false;
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        const v = typeof cell.value === 'string' ? cell.value : '';
        if (v.includes(`'=cmd|calc`)) sawGuardedGroup = true;
        if (v.includes(`'=HYPERLINK`)) sawGuardedValue = true;
        assert.ok(!/^=cmd/.test(v), `no cell may start with a live formula: ${v}`);
      });
    });
    assert.ok(sawGuardedGroup, 'XLSX group header cell must be apostrophe-guarded');
    assert.ok(sawGuardedValue, 'XLSX value cell must be apostrophe-guarded');
  });
});
