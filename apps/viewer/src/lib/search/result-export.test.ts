/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatCsv, formatJson, __internal } from './result-export.js';

const sample = {
  columns: ['express_id', 'name', 'is_external', 'note'],
  rows: [
    [10, 'Wall A', true, 'plain'],
    [20, 'Wall, "B"', false, 'has comma + quote'],
    [30, 'Wall\nMulti', null, 'has newline'],
  ],
};

describe('formatCsv', () => {
  it('writes a header row plus a body that contains every row', () => {
    const csv = formatCsv(sample);
    // Header line is the first physical line — easy to assert on.
    assert.ok(csv.startsWith('express_id,name,is_external,note\n'));
    // Each row's first cell value should appear in the CSV body.
    for (const row of sample.rows) {
      assert.ok(csv.includes(String(row[0])), `CSV missing express_id ${row[0]}`);
    }
  });

  it('quotes cells containing comma, quote, or newline', () => {
    const csv = formatCsv(sample);
    // Wall, "B" → wrapped in quotes with embedded "" escapes.
    assert.ok(csv.includes('"Wall, ""B"""'));
    // Newline cell wrapped — embedded \n stays literal inside the quotes.
    assert.ok(csv.includes('"Wall\nMulti"'));
  });

  it('renders booleans as true / false and null as empty', () => {
    const csv = formatCsv(sample);
    // Row 1 uses no special chars → its full unquoted line is locatable.
    assert.ok(csv.includes('10,Wall A,true,plain'));
    // Null cell collapses to empty between two commas.
    assert.ok(csv.includes(',,has newline'));
  });

  it('terminates with a newline (POSIX-friendly)', () => {
    const csv = formatCsv({ columns: ['a'], rows: [['1']] });
    assert.ok(csv.endsWith('\n'));
  });

  it('handles empty result sets (header only)', () => {
    const csv = formatCsv({ columns: ['a', 'b'], rows: [] });
    assert.strictEqual(csv, 'a,b\n');
  });
});

describe('formatJson', () => {
  it('produces an array of column→value objects', () => {
    const json = formatJson(sample);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.length, 3);
    assert.strictEqual(parsed[0].express_id, '10');
    assert.strictEqual(parsed[0].is_external, 'true');
    assert.strictEqual(parsed[2].is_external, ''); // null → ''
  });

  it('is pretty-printed (multi-line, with indented keys)', () => {
    const json = formatJson({ columns: ['a'], rows: [['1']] });
    // Indent=2: the inner object lives at 4 spaces of indent inside the array.
    assert.ok(json.includes('\n    "a"'));
  });

  it('handles empty result sets ("[]")', () => {
    assert.strictEqual(formatJson({ columns: ['a'], rows: [] }), '[]');
  });
});

describe('__internal helpers', () => {
  it('cellToString covers booleans, bigint, numbers, and objects', () => {
    assert.strictEqual(__internal.cellToString(null), '');
    assert.strictEqual(__internal.cellToString(undefined), '');
    assert.strictEqual(__internal.cellToString(true), 'true');
    assert.strictEqual(__internal.cellToString(42n), '42');
    assert.strictEqual(__internal.cellToString(3.14), '3.14');
    assert.strictEqual(__internal.cellToString(NaN), '');
    assert.strictEqual(__internal.cellToString({ a: 1 }), '{"a":1}');
  });

  it('escapeCsvCell wraps + escapes only when needed', () => {
    assert.strictEqual(__internal.escapeCsvCell(''), '');
    assert.strictEqual(__internal.escapeCsvCell('plain'), 'plain');
    assert.strictEqual(__internal.escapeCsvCell('a,b'), '"a,b"');
    assert.strictEqual(__internal.escapeCsvCell('a"b'), '"a""b"');
    assert.strictEqual(__internal.escapeCsvCell('a\nb'), '"a\nb"');
  });

  /**
   * A leading BOM is treated as file metadata by spreadsheet importers, so a
   * formula trigger hidden behind one still executes while an anchored regex
   * fails to match it. The guard must therefore look PAST the invisible run.
   *
   * It must not DELETE it. This block used to assert `!out.includes(invisible)`
   * -- that the invisible was stripped -- which is the wrong half of the rule:
   * stripping is not what makes the cell safe (the leading apostrophe is), and
   * the strip was implemented as `replace(/^[\p{Cf}\p{Z}]+/u, '')`, whose
   * `\p{Z}` includes U+0020, so every exported cell silently lost its leading
   * spaces. RFC 4180 §2.4: "Spaces are considered part of a field and should
   * not be ignored." Both directions are pinned below.
   */
  for (const [label, invisible] of [
    ['BOM', '\uFEFF'],
    ['zero-width space', '\u200B'],
    ['left-to-right mark', '\u200E'],
    ['non-breaking space', '\u00A0'],
    // Zl / Zp -- NOT covered by `\p{Zs}`, so these two survived a guard that
    // had already widened past the BOM.
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
  ] as const) {
    it(`neutralises a formula trigger hidden behind a leading ${label}`, () => {
      const out = __internal.escapeCsvCell(`${invisible}=cmd|'/c calc'!A1`);
      assert.ok(
        out.startsWith("'"),
        `expected the guard to land in front, got ${JSON.stringify(out)}`,
      );
      // The apostrophe is what makes the cell text; the invisible is DATA and
      // must survive verbatim, in its original position.
      assert.strictEqual(
        out,
        `'${invisible}=cmd|'/c calc'!A1`,
        'the guard must land in front of the run without consuming any of it',
      );
    });

    it(`preserves a leading ${label} on a value that is NOT a formula`, () => {
      // The other direction of the same rule: looking past an invisible must
      // never turn into deleting it. A cell is not made safer by losing data.
      assert.strictEqual(__internal.escapeCsvCell(`${invisible}Wall A`), `${invisible}Wall A`);
    });
  }

  it('preserves leading spaces on a benign cell (RFC 4180 §2.4)', () => {
    // The regression the strip caused: `\p{Z}` includes U+0020, so every cell
    // with leading whitespace was exported with it silently removed.
    assert.strictEqual(__internal.escapeCsvCell('   Wall A'), '   Wall A');
    assert.strictEqual(__internal.escapeCsvCell('Wall A   '), 'Wall A   ');
  });

  it('still neutralises a bare trigger, and leaves ordinary text alone', () => {
    // Control: the fix must not be satisfiable by prefixing everything.
    assert.ok(__internal.escapeCsvCell('=1+1').startsWith("'"));
    assert.strictEqual(__internal.escapeCsvCell('Wall A'), 'Wall A');
  });

  it('exports a signed number as a number, not as text', () => {
    // This writer sets no options, so it takes the shared guard's DEFAULT.
    // Until that default flipped, every negative value here shipped as
    // `'-0.35` and the column stopped summing in a spreadsheet (#1772).
    // Pinned at a CALL SITE, not only in the library: six writers take this
    // default and not one of them could see it change.
    assert.strictEqual(__internal.escapeCsvCell('-0.35'), '-0.35');
    assert.strictEqual(__internal.escapeCsvCell('+1'), '+1');
    // The exemption is for numbers, not for the sign: anything glued on is
    // still a formula as far as the guard is concerned.
    assert.strictEqual(__internal.escapeCsvCell('-0.35=cmd'), "'-0.35=cmd");
    assert.strictEqual(__internal.escapeCsvCell('@1'), "'@1");
  });

  // Filename sanitisation now lives in lib/export/download.ts (sanitizeFilename),
  // which preserves case and dots — see download.test.ts. downloadResult() routes
  // its stem through it, so there is no module-local helper to test here anymore.
});
