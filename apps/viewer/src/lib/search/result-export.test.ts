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
    // RFC-4180 CRLF line endings — Excel and strict parsers require it.
    assert.ok(csv.startsWith('express_id,name,is_external,note\r\n'));
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

  it('terminates with CRLF (RFC 4180)', () => {
    const csv = formatCsv({ columns: ['a'], rows: [['1']] });
    assert.ok(csv.endsWith('\r\n'));
  });

  it('handles empty result sets (header only)', () => {
    const csv = formatCsv({ columns: ['a', 'b'], rows: [] });
    assert.strictEqual(csv, 'a,b\r\n');
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

  it('sanitiseFilenameStem strips path-unsafe characters', () => {
    assert.strictEqual(__internal.sanitiseFilenameStem('My Query.csv'), 'My_Query_csv');
    assert.strictEqual(__internal.sanitiseFilenameStem('   '), 'query');
    assert.strictEqual(__internal.sanitiseFilenameStem('weird/../path'), 'weird_path');
  });
});
