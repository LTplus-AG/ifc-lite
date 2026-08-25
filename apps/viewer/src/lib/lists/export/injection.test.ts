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

describe('neutralizeSpreadsheetFormula — parity with the sibling guards', () => {
  /**
   * `packages/sdk/src/namespaces/export.ts` looks for the trigger PAST any
   * leading invisible (#1944): a BOM, zero-width space, LRM or NBSP does not
   * stop a spreadsheet reading the cell as a formula, but it does stop an
   * anchored regex matching. This copy stripped U+FEFF only, so ZWSP and
   * friends were bypasses.
   *
   * Reachable: `packages/encoding/src/ifc-string.ts` decodes \\X2\\200B\\X0\\
   * to a literal U+200B, so an IFC Name can carry one.
   *
   * Looking past the run is the rule; DELETING it is not. These cases used to
   * assert `!out.includes(invisible)`, which is the wrong half: stripping is
   * not what makes the cell safe (the leading apostrophe is), and the strip was
   * `replace(/^[\p{Cf}\p{Z}]+/u, '')`, whose `\p{Z}` includes U+0020 — so every
   * exported cell silently lost its leading spaces, against RFC 4180 §2.4
   * ("Spaces are considered part of a field and should not be ignored").
   * Both directions are pinned below.
   */
  for (const [label, invisible] of [
    ['BOM', '\uFEFF'],
    ['zero-width space', '\u200B'],
    ['left-to-right mark', '\u200E'],
    ['non-breaking space', '\u00A0'],
    // Zl / Zp. `\p{Zs}` does NOT cover these, so they stayed viable prefixes
    // until the class widened to `\p{Z}`.
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
  ] as const) {
    it(`guards a trigger hidden behind a leading ${label}`, () => {
      const out = neutralizeSpreadsheetFormula(`${invisible}=HYPERLINK("http://example.invalid","x")`);
      assert.ok(
        out.startsWith("'"),
        `expected the guard in front, got ${JSON.stringify(out)}`,
      );
      // The apostrophe is what makes the cell text; the invisible is DATA and
      // must survive verbatim, in its original position, behind the guard.
      assert.strictEqual(
        out,
        `'${invisible}=HYPERLINK("http://example.invalid","x")`,
        'the guard must land in front of the whole run without consuming any of it',
      );
    });

    it(`preserves a leading ${label} on a value that is NOT a formula`, () => {
      // The other direction of the same rule: looking past an invisible must
      // never turn into deleting it. A cell is not made safer by losing data.
      assert.strictEqual(
        neutralizeSpreadsheetFormula(`${invisible}Wall A`),
        `${invisible}Wall A`,
      );
    });
  }

  it('leaves ordinary text alone', () => {
    assert.strictEqual(neutralizeSpreadsheetFormula('Wall A'), 'Wall A');
  });

  it('preserves leading and trailing spaces (RFC 4180 §2.4)', () => {
    // The regression the strip caused: `\p{Z}` includes U+0020, so every cell
    // with leading whitespace was exported with it silently removed.
    assert.strictEqual(neutralizeSpreadsheetFormula('   Wall A'), '   Wall A');
    assert.strictEqual(neutralizeSpreadsheetFormula('Wall A   '), 'Wall A   ');
    // ...and a space still cannot hide a trigger.
    assert.strictEqual(neutralizeSpreadsheetFormula('   =cmd'), "'   =cmd");
  });
});

describe('neutralizeSpreadsheetFormula (#1790 review, CWE-1236)', () => {
  it('prefixes an apostrophe to every formula-trigger lead char', () => {
    // `+1` / `-1` are NOT here: they are wholly numeric and exempt since the
    // #1772 policy was applied to this call site too. See the split below.
    for (const s of ['=1+1', '@SUM(A1)', '\tx', '\rx', '=1', '@1']) {
      assert.strictEqual(neutralizeSpreadsheetFormula(s), `'${s}`);
    }
  });
  it('leaves benign strings untouched', () => {
    for (const s of ['Building A', 'A Level 0', 'IfcWall', '3.14', '']) {
      assert.strictEqual(neutralizeSpreadsheetFormula(s), s);
    }
  });

  // What is unique to THIS call site is that it passes NO options, so it takes
  // the shared guard's default. The accepted language itself is pinned once, in
  // `packages/encoding/src/numeric-literal.test.ts`; restating it here would be
  // a third copy of a table that is already exhaustively swept.
  it('takes the shared default: a wholly-numeric cell is not guarded', () => {
    assert.strictEqual(neutralizeSpreadsheetFormula('-0.35'), '-0.35');
    assert.strictEqual(neutralizeSpreadsheetFormula('+1'), '+1');
  });
  it('and a number with a payload glued on still is', () => {
    assert.strictEqual(neutralizeSpreadsheetFormula('-0.35=cmd'), "'-0.35=cmd");
  });
  it('an invisible in front of a number defeats the exemption, not the guard', () => {
    // The trigger scan looks PAST a leading invisible run; the numeric test does
    // not, so `\u200b-1` is triggered and not exempt. Failing closed is right.
    assert.strictEqual(neutralizeSpreadsheetFormula('\u200b-1'), "'\u200b-1");
    assert.strictEqual(neutralizeSpreadsheetFormula('   -1'), "'   -1");
  });
  it('guards a BOM-hidden marker without consuming the BOM', () => {
    // Was `'=evil` — i.e. the BOM deleted. The guard now looks past it instead,
    // which neutralises the same payload while leaving the cell's data intact.
    assert.strictEqual(neutralizeSpreadsheetFormula('\uFEFF=evil'), `'\uFEFF=evil`);
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
