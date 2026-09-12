/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { tableToCsv } from './csv-table.js';

interface Row {
  Name: string;
  Count: number;
  Flag: boolean;
  Missing: string | null;
}

const COLUMNS = ['Name', 'Count', 'Flag', 'Missing'] as const;

describe('tableToCsv', () => {
  it('writes the header from the column order and one line per row, ending with a newline', () => {
    const csv = tableToCsv<Row>(COLUMNS, [
      { Name: 'Wall', Count: 3, Flag: true, Missing: null },
      { Name: 'Door', Count: 0, Flag: false, Missing: 'x' },
    ]);
    expect(csv).toBe('Name,Count,Flag,Missing\nWall,3,true,\nDoor,0,false,x\n');
  });

  it('quotes a cell containing the delimiter, a quote or a newline per RFC 4180', () => {
    const csv = tableToCsv<Row>(COLUMNS, [
      { Name: 'Basic Wall:SW 200,0', Count: 1, Flag: false, Missing: 'Takt "A"' },
    ]);
    expect(csv.split('\n')[1]).toBe('"Basic Wall:SW 200,0",1,false,"Takt ""A"""');
  });

  it('neutralises a formula-injection payload in a user-derived cell (CWE-1236, #1506)', () => {
    const csv = tableToCsv<Row>(COLUMNS, [
      { Name: '=SUM(A1)', Count: -2, Flag: false, Missing: '\uFEFF=1+1' },
    ]);
    const line = csv.split('\n')[1];
    expect(line.startsWith("'=SUM(A1),")).toBe(true);
    // A wholly numeric cell keeps its sign — `-2` is a number, not a formula.
    expect(line).toContain(',-2,');
    // A BOM in front of the trigger does not hide it: the guard looks past the
    // invisible prefix and lands the apostrophe in front of the whole cell.
    expect(line.endsWith("'\uFEFF=1+1")).toBe(true);
  });

  it('quotes whitespace-padded cells so an importer cannot trim them', () => {
    const csv = tableToCsv<Row>(COLUMNS, [{ Name: ' padded ', Count: 1, Flag: true, Missing: null }]);
    expect(csv.split('\n')[1]).toBe('" padded ",1,true,');
  });

  it('honours a custom delimiter for both the header and the cells', () => {
    const csv = tableToCsv<Row>(COLUMNS, [{ Name: 'a;b', Count: 1, Flag: true, Missing: null }], { delimiter: ';' });
    expect(csv).toBe('Name;Count;Flag;Missing\n"a;b";1;true;\n');
  });
});
