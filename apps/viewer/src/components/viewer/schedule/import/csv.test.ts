/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  splitCsvRows,
  detectDelimiter,
  parseCsvDuration,
  parseCsvPredecessors,
  parseScheduleCsv,
} from './csv.js';
import type { ScheduleImportWarning } from './types.js';

// Date-order detection and parsing (`detectDateOrder`, `parseCsvDate`) are
// tested in csv-dates.test.ts, alongside the module they now live in.

describe('splitCsvRows', () => {
  it('handles quoted fields containing the delimiter and escaped ""', () => {
    const rows = splitCsvRows('"Task, ""A""",2026-01-05\nplain,value', ',');
    assert.deepStrictEqual(rows, [
      ['Task, "A"', '2026-01-05'],
      ['plain', 'value'],
    ]);
  });

  it('handles CRLF line endings', () => {
    const rows = splitCsvRows('a,b\r\nc,d\r\n', ',');
    assert.deepStrictEqual(rows, [
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('strips a leading UTF-8 BOM from the first cell', () => {
    const rows = splitCsvRows('﻿id,name\n1,Task 1', ',');
    assert.deepStrictEqual(rows[0], ['id', 'name']);
  });
});

describe('detectDelimiter', () => {
  it('detects semicolon-delimited headers', () => {
    assert.strictEqual(detectDelimiter('id;name;start'), ';');
  });

  it('detects tab-delimited headers', () => {
    assert.strictEqual(detectDelimiter('id\tname\tstart'), '\t');
  });

  it('defaults to comma when nothing else is present', () => {
    assert.strictEqual(detectDelimiter('id name start'), ',');
  });
});

describe('parseCsvDuration', () => {
  it('parses "5 days"', () => {
    assert.strictEqual(parseCsvDuration('5 days'), 'P5D');
  });

  it('parses "2 wks"', () => {
    assert.strictEqual(parseCsvDuration('2 wks'), 'P14D');
  });

  it('parses "8 hrs"', () => {
    assert.strictEqual(parseCsvDuration('8 hrs'), 'PT8H');
  });

  it('parses "0 days" as PT0S', () => {
    assert.strictEqual(parseCsvDuration('0 days'), 'PT0S');
  });

  it('parses a bare number as days', () => {
    assert.strictEqual(parseCsvDuration('3'), 'P3D');
  });

  it('parses "1 mon" as 30 days', () => {
    assert.strictEqual(parseCsvDuration('1 mon'), 'P30D');
  });

  it('returns undefined for unparsable text', () => {
    assert.strictEqual(parseCsvDuration('abc'), undefined);
  });
});

describe('parseCsvPredecessors', () => {
  it('parses "12FS+3 days"', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12FS+3 days', warnings, 1);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '12', type: 'FINISH_START', lagSeconds: 3 * 86_400 }]);
  });

  it('parses "14SS-1 day" preserving the negative lag', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('14SS-1 day', warnings, 1);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '14', type: 'START_START', lagSeconds: -86_400 }]);
  });

  it('defaults a bare id to FINISH_START with no lag', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('7', warnings, 1);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '7', type: 'FINISH_START', lagSeconds: undefined }]);
  });

  it('splits comma-separated lists', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('1,2,3', warnings, 1);
    assert.deepStrictEqual(
      deps.map(d => d.predecessorSourceId),
      ['1', '2', '3'],
    );
  });

  it('splits semicolon-separated lists', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('1;2;3', warnings, 1);
    assert.deepStrictEqual(
      deps.map(d => d.predecessorSourceId),
      ['1', '2', '3'],
    );
  });

  it('emits an unparsable-predecessor warning for junk', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('$$$', warnings, 5);
    assert.strictEqual(deps.length, 0);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0]!.code, 'unparsable-predecessor');
    assert.strictEqual(warnings[0]!.line, 5);
  });
});

describe('parseScheduleCsv', () => {
  it('derives outline level from a WBS number when no level column exists', () => {
    const csv = 'Name,WBS\nPhase,1\nSub,1.2\nLeaf,1.2.3\n';
    const result = parseScheduleCsv(csv);
    assert.deepStrictEqual(
      result.rows.map(r => r.outlineLevel),
      [1, 2, 3],
    );
  });

  it('skips a row with no name and warns, but keeps other rows', () => {
    const csv = 'Name,Start\nTask 1,2026-01-05\n,2026-01-06\nTask 3,2026-01-07\n';
    const result = parseScheduleCsv(csv);
    assert.deepStrictEqual(
      result.rows.map(r => r.name),
      ['Task 1', 'Task 3'],
    );
    assert.ok(result.warnings.some(w => w.code === 'missing-name'));
  });

  it('throws when there is no recognisable name column', () => {
    assert.throws(() => parseScheduleCsv('Foo,Bar\n1,2\n'), /task-name column/);
  });

  it('resolves day-first dates for a realistic file and reads them accordingly', () => {
    const csv = 'Name,Start,Finish\nTask 1,13/01/2026,14/01/2026\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.start, '2026-01-13T08:00:00');
    assert.ok(!result.warnings.some(w => w.code === 'ambiguous-date-format'));
  });

  it('resolves month-first dates for a realistic file and reads them accordingly', () => {
    const csv = 'Name,Start,Finish\nTask 1,01/13/2026,01/14/2026\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.start, '2026-01-13T08:00:00');
    assert.ok(!result.warnings.some(w => w.code === 'ambiguous-date-format'));
  });

  it('warns ambiguous-date-format and still reads day-first when every date is <= 12', () => {
    const csv = 'Name,Start,Finish\nTask 1,05/01/2026,06/01/2026\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.start, '2026-01-05T08:00:00');
    assert.ok(result.warnings.some(w => w.code === 'ambiguous-date-format'));
  });

  it('warns unparsable-duration for an unreadable duration cell', () => {
    const csv = 'Name,Duration\nTask 1,not-a-duration\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.durationIso, undefined);
    assert.ok(result.warnings.some(w => w.code === 'unparsable-duration'));
  });
});
