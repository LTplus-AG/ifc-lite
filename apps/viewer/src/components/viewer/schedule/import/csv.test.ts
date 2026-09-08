/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  splitCsvRows,
  detectDelimiter,
  parseCsvDuration,
  parseScheduleCsv,
} from './csv.js';
import { parseCsvPredecessors } from './csv-predecessors.js';
import type { ScheduleImportWarning } from './types.js';

// Date-order detection and parsing (`detectDateOrder`, `parseCsvDate`) are
// tested in csv-dates.test.ts, alongside the module they now live in.
// `parseCsvPredecessors` is imported directly from `csv-predecessors.js`
// (not re-exported through `csv.js`) — AGENTS.md: "Supersede means delete."

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

  it('treats an unescaped quote inside field content as a literal, not a quote-open (#1963)', () => {
    // `6" slab` is an ordinary construction task name. An unconditional
    // `inQuotes = true` on any `"` used to open quoted mode mid-field and
    // never close it, collapsing every remaining row in the file into one
    // field — silent, total data loss for a common input.
    const rows = splitCsvRows('Name,Duration\n6" slab,5 days\nWall,2 days', ',');
    assert.deepStrictEqual(rows, [
      ['Name', 'Duration'],
      ['6" slab', '5 days'],
      ['Wall', '2 days'],
    ]);
  });

  it('treats a quote after a closed quoted section as a literal, RFC 4180 permissive style (#1963)', () => {
    // `"a"b"`: the leading `"` opens a quoted field (`a`), the second `"`
    // closes it (not doubled, so not an escape). Scanning then continues in
    // the same field with quoting off: `b` appends literally, and the
    // trailing `"` — field already non-empty — is a literal character too,
    // not a re-open. Net result `ab"`, matching Python's csv module and
    // Excel's own permissive parsing of this malformed-but-common shape.
    const rows = splitCsvRows('"a"b"', ',');
    assert.deepStrictEqual(rows, [['ab"']]);
  });

  it('still opens quoted mode for a quote at the true start of a field', () => {
    const rows = splitCsvRows('"6 inch slab",5 days', ',');
    assert.deepStrictEqual(rows, [['6 inch slab', '5 days']]);
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

  it('returns undefined for an unrecognised unit ("2 yrs") rather than guessing days', () => {
    // Regression: `unitToSeconds` used to catch-all fall back to days for
    // any unit it didn't recognise, silently turning 2 YEARS into 2 days.
    assert.strictEqual(parseCsvDuration('2 yrs'), undefined);
  });

  it('returns undefined for a unit typo ("3 dyas") rather than guessing days', () => {
    assert.strictEqual(parseCsvDuration('3 dyas'), undefined);
  });

  it('returns undefined for a negative duration rather than folding it into PT0S (regression)', () => {
    // Bug: `seconds <= 0` treated a negative (bad/invalid) duration the same
    // as an explicit 0 — silently turning it into a valid-looking PT0S
    // milestone downstream instead of reporting it as unparsable.
    assert.strictEqual(parseCsvDuration('-5 days'), undefined);
    assert.strictEqual(parseCsvDuration('-5'), undefined);
  });

  it('still treats an explicit 0 as a genuine milestone (PT0S)', () => {
    assert.strictEqual(parseCsvDuration('0'), 'PT0S');
    assert.strictEqual(parseCsvDuration('0 days'), 'PT0S');
  });

  it('still treats a bare number as days', () => {
    assert.strictEqual(parseCsvDuration('4'), 'P4D');
  });

  for (const unit of ['d', 'day', 'days']) {
    it(`"${unit}" still means days`, () => {
      assert.strictEqual(parseCsvDuration(`2 ${unit}`), 'P2D');
    });
  }

  for (const unit of ['ed', 'eday', 'edays']) {
    it(`"${unit}" (elapsed days) still means days`, () => {
      assert.strictEqual(parseCsvDuration(`2 ${unit}`), 'P2D');
    });
  }

  for (const unit of ['w', 'wk', 'wks', 'week', 'weeks']) {
    it(`"${unit}" still means weeks`, () => {
      assert.strictEqual(parseCsvDuration(`1 ${unit}`), 'P7D');
    });
  }

  for (const unit of ['h', 'hr', 'hrs', 'hour', 'hours']) {
    it(`"${unit}" still means hours`, () => {
      assert.strictEqual(parseCsvDuration(`2 ${unit}`), 'PT2H');
    });
  }

  for (const unit of ['m', 'min', 'mins', 'minute', 'minutes']) {
    it(`"${unit}" still means minutes`, () => {
      assert.strictEqual(parseCsvDuration(`30 ${unit}`), 'PT30M');
    });
  }

  for (const unit of ['mo', 'mon', 'month', 'months']) {
    it(`"${unit}" still means months (30-day approximation), not minutes`, () => {
      // The regression this guards: "mon" also satisfies a naive
      // `startsWith('m')` minutes check, so it must resolve to months, not
      // 1 minute.
      assert.strictEqual(parseCsvDuration(`1 ${unit}`), 'P30D');
    });
  }
});

// Grammar-only cases: no task ids to match against, so every token is read by
// the suffix rules alone. The id-aware cases pass their own set.
const NO_KNOWN_IDS: ReadonlySet<string> = new Set();

describe('parseCsvPredecessors', () => {
  it('parses "12FS+3 days"', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12FS+3 days', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '12', type: 'FINISH_START', lagSeconds: 3 * 86_400 }]);
  });

  it('parses a fully lowercase code "12fs+3d" (regression)', () => {
    // Bug: the code alternation (FS|SS|FF|SF) was case-sensitive, so a
    // lowercase code failed to match, the id group backtracked to absorb
    // "fs", and the link was dropped as unknown. `code.toUpperCase()` at the
    // call site already assumed case-insensitive matching — the regex just
    // never had the `i` flag to back it up.
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12fs+3d', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '12', type: 'FINISH_START', lagSeconds: 3 * 86_400 }]);
  });

  it('parses a mixed-case code "12Fs" with no lag', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12Fs', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '12', type: 'FINISH_START', lagSeconds: undefined }]);
  });

  it('parses "14SS-1 day" preserving the negative lag', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('14SS-1 day', warnings, 1, NO_KNOWN_IDS);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '14', type: 'START_START', lagSeconds: -86_400 }]);
  });

  it('parses "12FF+3 days"', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12FF+3 days', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '12', type: 'FINISH_FINISH', lagSeconds: 3 * 86_400 }]);
  });

  it('parses "12SF-1 day" preserving the negative lag', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12SF-1 day', warnings, 1, NO_KNOWN_IDS);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '12', type: 'START_FINISH', lagSeconds: -86_400 }]);
  });

  it('defaults a bare id to FINISH_START with no lag', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('7', warnings, 1, NO_KNOWN_IDS);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '7', type: 'FINISH_START', lagSeconds: undefined }]);
  });

  it('splits comma-separated lists', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('1,2,3', warnings, 1, NO_KNOWN_IDS);
    assert.deepStrictEqual(
      deps.map(d => d.predecessorSourceId),
      ['1', '2', '3'],
    );
  });

  it('splits semicolon-separated lists', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('1;2;3', warnings, 1, NO_KNOWN_IDS);
    assert.deepStrictEqual(
      deps.map(d => d.predecessorSourceId),
      ['1', '2', '3'],
    );
  });

  it('emits an unparsable-predecessor warning for junk', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('$$$', warnings, 5, NO_KNOWN_IDS);
    assert.strictEqual(deps.length, 0);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0]!.code, 'unparsable-predecessor');
    assert.strictEqual(warnings[0]!.line, 5);
  });

  it('keeps the dependency but drops the lag and warns on an unrecognised lag unit', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12FS+3 yrs', warnings, 9, NO_KNOWN_IDS);
    // The link is still real information — only the lag is untrustworthy.
    assert.strictEqual(deps.length, 1);
    assert.strictEqual(deps[0]!.predecessorSourceId, '12');
    assert.strictEqual(deps[0]!.type, 'FINISH_START');
    assert.strictEqual(deps[0]!.lagSeconds, undefined);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0]!.code, 'unparsable-predecessor');
    assert.strictEqual(warnings[0]!.line, 9);
    assert.match(warnings[0]!.message, /yrs/);
  });

  it('parses a comma-decimal lag magnitude ("12FS+1,5 days") without splitting on the decimal comma (regression)', () => {
    // Bug: the entry list was split on every "," before parsing, so a
    // European comma-decimal lag ("1,5") was read as two separate list
    // entries ("+1" and "5 days") instead of one 1.5-day lag.
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12FS+1,5 days', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '12', type: 'FINISH_START', lagSeconds: 1.5 * 86_400 }]);
  });

  it('still splits a genuine comma-separated id list unaffected by the decimal-comma protection', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12FS+3 days,14SS-1 day,7', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(
      deps.map(d => d.predecessorSourceId),
      ['12', '14', '7'],
    );
  });

  it('splits a hyphenated id followed by a bare-integer id into two dependencies (regression)', () => {
    // Bug: protecting a decimal comma before splitting on "," made
    // "TASK-001,5" collide with the lag-sign grammar (predecessorSourceId
    // matches [A-Za-z0-9_-]+, so "-001" looked like a sign+digits run just
    // as "+1" does in "12FS+1,5 days"). That silently merged two distinct
    // dependencies into one, on a fabricated id "TASK" with an invented lag.
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASK-001,5', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [
      { predecessorSourceId: 'TASK-001', type: 'FINISH_START', lagSeconds: undefined },
      { predecessorSourceId: '5', type: 'FINISH_START', lagSeconds: undefined },
    ]);
  });

  it('splits two hyphenated ids into two dependencies, not one mis-bound entry (regression)', () => {
    // The serious form of the same bug: both "TASK-001" and "TASK-002"
    // resolved to a single fabricated task "TASK" with invented lags,
    // silently binding a dependency to the wrong task.
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASK-001,TASK-002', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [
      { predecessorSourceId: 'TASK-001', type: 'FINISH_START', lagSeconds: undefined },
      { predecessorSourceId: 'TASK-002', type: 'FINISH_START', lagSeconds: undefined },
    ]);
  });

  it('parses a lone hyphenated id with no link code or lag', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASK-001', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: 'TASK-001', type: 'FINISH_START', lagSeconds: undefined }]);
  });

  it('parses a hyphenated id with a link code and lag', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASK-001FS+2 days', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [
      { predecessorSourceId: 'TASK-001', type: 'FINISH_START', lagSeconds: 2 * 86_400 },
    ]);
  });

  it('parses a semicolon list containing a decimal-comma lag', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12FS+1,5 days; 14SS-1 day', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [
      { predecessorSourceId: '12', type: 'FINISH_START', lagSeconds: 1.5 * 86_400 },
      { predecessorSourceId: '14', type: 'START_START', lagSeconds: -86_400 },
    ]);
  });

  it('reads a whole token that names a task in the file, even when it ends in a link code (regression)', () => {
    // Bug: the id group is lazy, so "TASKFS" always split into task "TASK"
    // with an FS link — binding the dependency to a different, real task.
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASKFS', warnings, 1, new Set(['TASK', 'TASKFS']));
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: 'TASKFS', type: 'FINISH_START', lagSeconds: undefined }]);
  });

  it('keeps a lag attached to an id that ends in a link code', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASKSS+2 days', warnings, 1, new Set(['TASK', 'TASKSS']));
    assert.strictEqual(warnings.length, 0);
    // "SS" is part of the id, so the link falls back to the default FS.
    assert.deepStrictEqual(deps, [
      { predecessorSourceId: 'TASKSS', type: 'FINISH_START', lagSeconds: 2 * 86_400 },
    ]);
  });

  it('still splits a suffix code when the whole token is not a task in the file', () => {
    // The negative case the fix must not break: "TASK5FS" is task "TASK5"
    // plus an FS link, and stays that way because "TASK5FS" is not an id.
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASK5FS', warnings, 1, new Set(['TASK5', 'TASKFS']));
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: 'TASK5', type: 'FINISH_START', lagSeconds: undefined }]);
  });

  it('still reads a plain id with no suffix code', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASK5', warnings, 1, new Set(['TASK5', 'TASKFS']));
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: 'TASK5', type: 'FINISH_START', lagSeconds: undefined }]);
  });

  it('still reads a spaced code as a code, even when id+code names a task', () => {
    // "TASK FS" separates the two itself; an id can never contain a space, so
    // the longest-match rule must not reach across it.
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASK FS', warnings, 1, new Set(['TASK', 'TASKFS']));
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: 'TASK', type: 'FINISH_START', lagSeconds: undefined }]);
  });

  it('still splits "12FS+3 days" when "12FS" is not a task in the file', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('12FS+3 days', warnings, 1, new Set(['12', '14']));
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [{ predecessorSourceId: '12', type: 'FINISH_START', lagSeconds: 3 * 86_400 }]);
  });

  it('splits underscore ids unaffected by the hyphen fix', () => {
    const warnings: ScheduleImportWarning[] = [];
    const deps = parseCsvPredecessors('TASK_A,TASK_B', warnings, 1, NO_KNOWN_IDS);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(deps, [
      { predecessorSourceId: 'TASK_A', type: 'FINISH_START', lagSeconds: undefined },
      { predecessorSourceId: 'TASK_B', type: 'FINISH_START', lagSeconds: undefined },
    ]);
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

  it('reads a plain percent-complete value', () => {
    const csv = 'Name,Complete\nTask 1,45\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.percentComplete, 45);
  });

  it('reads a comma-decimal percent-complete value in a semicolon-delimited (European) export', () => {
    // Semicolon as the row delimiter frees up comma to mean decimal point
    // inside a cell — "12,5" is 12.5%, not garbage. Number("12,5") alone
    // would give NaN.
    const csv = 'Name;Complete\nTask 1;12,5\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.percentComplete, 12.5);
  });

  it('still reads a dot-decimal percent-complete value unmangled', () => {
    const csv = 'Name;Complete\nTask 1;12.5\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.percentComplete, 12.5);
  });

  it('warns unparsable-duration for an unreadable duration cell', () => {
    const csv = 'Name,Duration\nTask 1,not-a-duration\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.durationIso, undefined);
    assert.ok(result.warnings.some(w => w.code === 'unparsable-duration'));
  });

  it('warns unparsable-duration (not silent days) for an unrecognised duration unit', () => {
    const csv = 'Name,Duration\nTask 1,2 yrs\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.durationIso, undefined);
    assert.ok(result.warnings.some(w => w.code === 'unparsable-duration'));
  });

  it('rejects impossible dates (31/02, 31/04, 30/02) with an unparsable-date warning', () => {
    for (const bad of ['31/02/2026', '31/04/2026', '30/02/2026']) {
      const csv = `Name,Start\nTask 1,${bad}\n`;
      const result = parseScheduleCsv(csv);
      assert.strictEqual(result.rows[0]!.start, undefined, `expected ${bad} to be rejected`);
      assert.ok(
        result.warnings.some(w => w.code === 'unparsable-date'),
        `expected an unparsable-date warning for ${bad}`,
      );
    }
  });

  it('accepts a leap-day date (29/02/2024) and rejects the same day in a non-leap year (29/02/2026)', () => {
    const leap = parseScheduleCsv('Name,Start\nTask 1,29/02/2024\n');
    assert.strictEqual(leap.rows[0]!.start, '2024-02-29T08:00:00');
    assert.ok(!leap.warnings.some(w => w.code === 'unparsable-date'));

    const nonLeap = parseScheduleCsv('Name,Start\nTask 1,29/02/2026\n');
    assert.strictEqual(nonLeap.rows[0]!.start, undefined);
    assert.ok(nonLeap.warnings.some(w => w.code === 'unparsable-date'));
  });

  it('warns mixed-date-format when rows disagree on order, and refuses ambiguous dates rather than guessing (regression)', () => {
    // Bug: the old detectDateOrder early-returned on the FIRST cell that
    // disambiguated, so scanning "13/05/2026" (day-first) before
    // "05/13/2026" (month-first) silently decided day-first for the WHOLE
    // file, misreading the month-first row. Both rows must now be detected
    // as conflicting, and neither should be silently guessed.
    const csv = 'Name,Start\nRow A,13/05/2026\nRow B,05/13/2026\nRow C,02/03/2026\n';
    const result = parseScheduleCsv(csv);
    assert.ok(result.warnings.some(w => w.code === 'mixed-date-format'));
    // The two unambiguous rows still parse correctly from their own value.
    assert.strictEqual(result.rows[0]!.start, '2026-05-13T08:00:00'); // 13/05 -> day-first
    assert.strictEqual(result.rows[1]!.start, '2026-05-13T08:00:00'); // 05/13 -> month-first
    // The genuinely ambiguous row (02/03, both <= 12) is refused, not guessed.
    assert.strictEqual(result.rows[2]!.start, undefined);
    assert.ok(result.warnings.some(w => w.code === 'unparsable-date' && w.line === 4));
  });

  it('does not warn mixed-date-format when the file is internally consistent', () => {
    const csv = 'Name,Start,Finish\nTask 1,13/05/2026,14/05/2026\n';
    const result = parseScheduleCsv(csv);
    assert.ok(!result.warnings.some(w => w.code === 'mixed-date-format'));
  });

  it('warns unparsable-duration for a negative duration cell instead of treating it as a milestone (regression)', () => {
    // Bug: `parseCsvDuration` folded `seconds <= 0` into 'PT0S', so a
    // negative/bad input silently became a valid-looking milestone via the
    // `durationIso === 'PT0S'` isMilestone check below.
    const csv = 'Name,Duration\nTask 1,-5 days\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.durationIso, undefined);
    assert.strictEqual(result.rows[0]!.isMilestone, false);
    assert.ok(result.warnings.some(w => w.code === 'unparsable-duration'));
  });

  it('keeps both rows when an id column is partially filled -- a blank id gets a namespaced fallback rather than colliding with an explicit id (regression)', () => {
    // Bug: a blank id cell fell back to the bare positional "1", which
    // shares a namespace with an explicit id "1" elsewhere in the file --
    // the second row was reported (and dropped) as a spurious duplicate.
    const csv = 'id,name\n,Task A\n1,Task B\n';
    const result = parseScheduleCsv(csv);
    assert.deepStrictEqual(
      result.rows.map(r => r.name),
      ['Task A', 'Task B'],
    );
    assert.ok(!result.warnings.some(w => w.code === 'duplicate-source-id'));
    // The blank-id row's synthesized sourceId must never collide with -- or
    // be confusable with -- a real explicit id.
    assert.strictEqual(result.rows[1]!.sourceId, '1');
    assert.notStrictEqual(result.rows[0]!.sourceId, '1');
  });

  it('resolves a predecessor that references an explicit id in a file with a partially-filled id column', () => {
    const csv = 'id,name,predecessors\n,Task A,\n1,Task B,\n2,Task C,1\n';
    const result = parseScheduleCsv(csv);
    const taskC = result.rows.find(r => r.name === 'Task C')!;
    assert.strictEqual(taskC.dependencies.length, 1);
    assert.strictEqual(taskC.dependencies[0]!.predecessorSourceId, '1');
    // The explicit id it references really is Task B's sourceId.
    const taskB = result.rows.find(r => r.name === 'Task B')!;
    assert.strictEqual(taskB.sourceId, '1');
  });

  it('still warns duplicate-source-id for a genuine duplicate explicit id', () => {
    const csv = 'id,name\n1,Task A\n1,Task B\n';
    const result = parseScheduleCsv(csv);
    assert.deepStrictEqual(
      result.rows.map(r => r.name),
      ['Task A'],
    );
    assert.ok(result.warnings.some(w => w.code === 'duplicate-source-id'));
  });

  it('keeps a blank-id row whose synthesized id is also written as an explicit id elsewhere (issue #2071)', () => {
    // Bug: the synthesized `row-<line>-no-id` shared one namespace with the
    // explicit ids, so a file that happens to state that exact id had its
    // blank-id row dropped as a "duplicate" the author never wrote.
    const csv = 'id,name\nrow-3-no-id,Task A\n,Task B\n';
    const result = parseScheduleCsv(csv);
    assert.deepStrictEqual(
      result.rows.map(r => r.name),
      ['Task A', 'Task B'],
    );
    assert.ok(!result.warnings.some(w => w.code === 'duplicate-source-id'));
    // The explicit id stays exactly as written; the synthesized one moves.
    assert.strictEqual(result.rows[0]!.sourceId, 'row-3-no-id');
    assert.notStrictEqual(result.rows[1]!.sourceId, 'row-3-no-id');
    assert.strictEqual(result.rows[0]!.sourceIdIsGenerated, undefined);
    assert.strictEqual(result.rows[1]!.sourceIdIsGenerated, true);
  });

  it('does not claim the colliding row survived when it is dropped for a missing name (issue #2075)', () => {
    // The warning fires in the id pre-pass, which cannot know the row loop will
    // drop row 3 for having no name. An earlier wording said "Both rows were
    // kept", which was false for exactly this input.
    const result = parseScheduleCsv('id,name,notes\nrow-3-no-id,A,\n,,leftover\nD,D,\n');
    assert.deepStrictEqual(result.rows.map(r => r.name), ['A', 'D']);
    const warning = result.warnings.find(w => w.code === 'synthesized-id-collision');
    assert.ok(warning, 'expected the collision warning');
    assert.ok(
      !/both rows were kept/i.test(warning.message),
      `warning must not assert the row survived: ${warning.message}`,
    );
  });

  it('warns with the real cause, not duplicate-source-id, when an explicit id collides with a synthesized one (issue #2071)', () => {
    const csv = 'id,name\nrow-3-no-id,Task A\n,Task B\n';
    const result = parseScheduleCsv(csv);
    // Count, not presence: ids are derived once in the pre-pass and read back
    // by index in the row loop. Recomputing per row would emit this twice, and
    // a find() would not notice — the "reported exactly once" claim needs an
    // assertion, not a comment (maintainer finding on #2075).
    const collisions = result.warnings.filter(w => w.code === 'synthesized-id-collision');
    assert.strictEqual(collisions.length, 1, 'collision must be reported exactly once');
    const warning = collisions[0];
    assert.ok(warning, 'expected a synthesized-id-collision warning');
    assert.match(warning.message, /row-3-no-id/);
    assert.match(warning.message, /no id/i);
    assert.strictEqual(warning.line, 3);
  });

  it('does not warn synthesized-id-collision when a blank id cell needs no disambiguation', () => {
    const csv = 'id,name\nA,Task A\n,Task B\n';
    const result = parseScheduleCsv(csv);
    assert.ok(!result.warnings.some(w => w.code === 'synthesized-id-collision'));
    assert.strictEqual(result.rows[1]!.sourceId, 'row-3-no-id');
  });

  it('marks positional ids as stated, not generated, when the file has no id column (they are addressable)', () => {
    const csv = 'Name,Predecessors\nTask 1,\nTask 2,1\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.sourceIdIsGenerated, undefined);
    assert.strictEqual(result.rows[1]!.sourceIdIsGenerated, undefined);
  });

  it('keeps positional bare-integer ids when the file has no id column at all (predecessors reference row position)', () => {
    // No id column: sourceId falls back to position, matching MS Project's
    // own default ID column, and "1" in Predecessors resolves to row 1.
    const csv = 'Name,Predecessors\nTask 1,\nTask 2,1\n';
    const result = parseScheduleCsv(csv);
    assert.strictEqual(result.rows[0]!.sourceId, '1');
    assert.strictEqual(result.rows[1]!.dependencies[0]!.predecessorSourceId, '1');
  });

  it('reads a predecessor token that is itself a task id ending in a link code (regression)', () => {
    // Bug: the predecessor grammar's id group is lazy, so any token ending in
    // FS/SS/FF/SF split -- a task literally named "TASKFS" resolved to task
    // "TASK" with an FS link. A silent mis-bind to a different, real task.
    const csv =
      'id,name,predecessors\nTASK,Task A,\nTASKFS,Task B,\nTASK5,Task C,\nX,Task D,TASKFS\nY,Task E,TASK5FS\nZ,Task F,TASKFS+2 days\n';
    const result = parseScheduleCsv(csv);
    const byId = new Map(result.rows.map(r => [r.sourceId, r]));
    assert.deepStrictEqual(byId.get('X')!.dependencies, [
      { predecessorSourceId: 'TASKFS', type: 'FINISH_START', lagSeconds: undefined },
    ]);
    // The same reading holds when a lag follows the id.
    assert.deepStrictEqual(byId.get('Z')!.dependencies, [
      { predecessorSourceId: 'TASKFS', type: 'FINISH_START', lagSeconds: 2 * 86_400 },
    ]);
    // Negative case: "TASK5FS" is NOT an id in this file, so the suffix still
    // splits into task "TASK5" plus an FS link. A fix that simply stopped
    // splitting would break this.
    assert.deepStrictEqual(byId.get('Y')!.dependencies, [
      { predecessorSourceId: 'TASK5', type: 'FINISH_START', lagSeconds: undefined },
    ]);
  });

  it('numbers positional ids by task row, not by physical line, when the file contains blank rows', () => {
    // Positional ids and warning line numbers are deliberately different
    // namespaces: the header occupies physical line 1, so the first task row
    // is already id "1" on line 2. Blank separator rows are a formatting
    // artifact, not a task, and so do not consume a position either --
    // "3" in Predecessors means the third task, which is what a file with no
    // id column can express at all.
    const csv = 'Name,Predecessors\nTask A,\nTask B,1\n\nTask C,2\nTask D,3\n';
    const result = parseScheduleCsv(csv);
    assert.deepStrictEqual(
      result.rows.map(r => r.sourceId),
      ['1', '2', '3', '4'],
    );
    const taskD = result.rows.find(r => r.name === 'Task D')!;
    assert.strictEqual(taskD.dependencies[0]!.predecessorSourceId, '3');
    const taskC = result.rows.find(r => r.name === 'Task C')!;
    assert.strictEqual(taskC.sourceId, '3');
  });

  it('cites the original file line number in a warning even when the file contains blank rows (regression)', () => {
    // Bug: blank-row filtering happened before line numbers were assigned,
    // so `line` was derived from the FILTERED array's index -- drifting
    // away from the row's real position as soon as a blank row was dropped.
    const csv = 'Name,Start\nTask 1,2026-01-05\n\n,2026-01-06\nTask 3,2026-01-07\n';
    const result = parseScheduleCsv(csv);
    // Row with the missing name is on line 4 of the file (1: header,
    // 2: Task 1, 3: blank, 4: the row with no name).
    const missingNameWarning = result.warnings.find(w => w.code === 'missing-name');
    assert.strictEqual(missingNameWarning?.line, 4);
  });
});
