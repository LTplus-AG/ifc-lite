/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectDateOrder, parseCsvDate } from './csv-dates.js';

describe('detectDateOrder', () => {
  it('resolves day-first when a component above 12 appears in the first position', () => {
    const result = detectDateOrder(['13/01/2026']);
    assert.strictEqual(result.order, 'day-first');
    assert.strictEqual(result.ambiguous, false);
  });

  it('resolves month-first when a component above 12 appears in the second position', () => {
    const result = detectDateOrder(['01/13/2026']);
    assert.strictEqual(result.order, 'month-first');
    assert.strictEqual(result.ambiguous, false);
  });

  it('passes ISO dates through without flagging ambiguity', () => {
    const result = detectDateOrder(['2026-01-05']);
    assert.strictEqual(result.order, 'iso');
    assert.strictEqual(result.ambiguous, false);
  });

  it('falls back to day-first and reports ambiguous when every value is <= 12', () => {
    const result = detectDateOrder(['05/01/2026']);
    assert.strictEqual(result.order, 'day-first');
    assert.strictEqual(result.ambiguous, true);
  });

  it('is unaffected by the impossible-date rejection in partsToIso (it never calls it)', () => {
    // detectDateOrder resolves order from extractDateParts' raw a/b/year —
    // it has no calendar-validity concept at all, so an impossible date
    // like 31/02 still disambiguates order (31 > 12 => day-first) exactly
    // as before.
    const result = detectDateOrder(['31/02/2026']);
    assert.strictEqual(result.order, 'day-first');
    assert.strictEqual(result.ambiguous, false);
  });

  it('scans the whole list rather than stopping at the first disambiguating cell (regression)', () => {
    // Bug: the old implementation returned on the FIRST cell whose second
    // component was > 12, deciding month-first for the whole file from one
    // cell even when a later cell proves day-first. Here the month-first
    // cell ('05/13/2026') is scanned first but a day-first cell ('13/05/2026')
    // follows — both must be detected as conflicting evidence, not just the
    // first one seen.
    const result = detectDateOrder(['05/13/2026', '13/05/2026']);
    assert.ok(result.conflict, 'expected conflicting evidence to be reported');
    assert.strictEqual(result.conflict!.monthFirstExample, '05/13/2026');
    assert.strictEqual(result.conflict!.dayFirstExample, '13/05/2026');
  });

  it('reports no conflict when only one ordering has evidence, even across many cells', () => {
    const result = detectDateOrder(['02/03/2026', '13/01/2026', '04/05/2026']);
    assert.strictEqual(result.order, 'day-first');
    assert.strictEqual(result.conflict, undefined);
  });

  it('does not manufacture a conflict from a single cell where both components exceed 12', () => {
    // "20/25/2026": neither reading is valid (a=20 as day needs b<=12 as
    // month, but b=25 isn't; b=25 as day needs a<=12 as month, but a=20
    // isn't). Before the fix, this single malformed cell alone set BOTH
    // dayFirstExample and monthFirstExample, manufacturing a phantom
    // mixed-date-format conflict — no second, genuinely disagreeing cell
    // required. The cell is simply unparsable, not "evidence" for anything.
    const result = detectDateOrder(['20/25/2026']);
    assert.strictEqual(result.conflict, undefined);
    // With nothing else in the file to disambiguate, this falls back to
    // the ambiguous day-first default (the cell itself is later rejected
    // by parseCsvDate/partsToIso as an impossible date).
    assert.strictEqual(result.ambiguous, true);
  });

  it('still resolves order from an otherwise-valid cell when a both-over-12 cell is also present', () => {
    const result = detectDateOrder(['20/25/2026', '13/01/2026']);
    assert.strictEqual(result.order, 'day-first');
    assert.strictEqual(result.conflict, undefined);
  });
});

describe('parseCsvDate', () => {
  it('reads day-first non-ISO dates', () => {
    assert.strictEqual(parseCsvDate('13/01/2026', 'day-first'), '2026-01-13T08:00:00');
  });

  it('reads month-first non-ISO dates', () => {
    assert.strictEqual(parseCsvDate('01/13/2026', 'month-first'), '2026-01-13T08:00:00');
  });

  it('passes ISO dates through regardless of the resolved order', () => {
    assert.strictEqual(parseCsvDate('2026-01-05', 'month-first'), '2026-01-05T08:00:00');
    assert.strictEqual(parseCsvDate('2026-01-05', 'day-first'), '2026-01-05T08:00:00');
  });

  it('rejects impossible calendar dates (day-first) instead of producing an invalid ISO string', () => {
    // Regression: `partsToIso` used to only check `day <= 31`, so 31/02 and
    // 31/04 produced strings like "2026-02-31T..." that were never valid.
    assert.strictEqual(parseCsvDate('31/02/2026', 'day-first'), undefined);
    assert.strictEqual(parseCsvDate('31/04/2026', 'day-first'), undefined);
    assert.strictEqual(parseCsvDate('30/02/2026', 'day-first'), undefined);
  });

  it('rejects an impossible ISO date the same way (both branches share partsToIso)', () => {
    assert.strictEqual(parseCsvDate('2026-02-31', 'day-first'), undefined);
  });

  it('accepts a leap-day date and rejects the same day in a non-leap year', () => {
    assert.strictEqual(parseCsvDate('29/02/2024', 'day-first'), '2024-02-29T08:00:00');
    assert.strictEqual(parseCsvDate('29/02/2026', 'day-first'), undefined);
  });

  it('resolves an unambiguous cell from its own value regardless of the passed-in order', () => {
    // 13 > 12 in the first position always means day-first for THIS cell,
    // even if the file-wide order (as would happen under conflicting
    // evidence) is passed as 'month-first'.
    assert.strictEqual(parseCsvDate('13/01/2026', 'month-first'), '2026-01-13T08:00:00');
  });

  it('refuses an ambiguous cell when refuseAmbiguous is set (mixed-date-format case)', () => {
    assert.strictEqual(parseCsvDate('05/01/2026', 'day-first', true), undefined);
    assert.strictEqual(parseCsvDate('05/01/2026', 'day-first', false), '2026-01-05T08:00:00');
  });

  it('parses AM/PM suffixes and normalizes 12 AM / 12 PM correctly', () => {
    assert.strictEqual(parseCsvDate('1/5/2026 8:00 AM', 'month-first'), '2026-01-05T08:00:00');
    assert.strictEqual(parseCsvDate('1/5/2026 5:00 PM', 'month-first'), '2026-01-05T17:00:00');
    assert.strictEqual(parseCsvDate('1/5/2026 12:00 AM', 'month-first'), '2026-01-05T00:00:00');
    assert.strictEqual(parseCsvDate('1/5/2026 12:00 PM', 'month-first'), '2026-01-05T12:00:00');
  });

  it('accepts AM/PM with no space and with dots, case-insensitively', () => {
    assert.strictEqual(parseCsvDate('1/5/2026 8:00AM', 'month-first'), '2026-01-05T08:00:00');
    assert.strictEqual(parseCsvDate('1/5/2026 5:00pm', 'month-first'), '2026-01-05T17:00:00');
    assert.strictEqual(parseCsvDate('1/5/2026 5:00 p.m.', 'month-first'), '2026-01-05T17:00:00');
  });

  it('does not invert an 8 AM start against a 5 PM finish on the same day (regression)', () => {
    // Bug: the time regex discarded AM/PM entirely, so "5:00 PM" parsed as
    // 05:00 — BEFORE "8:00 AM" — silently inverting the bar.
    const start = parseCsvDate('1/5/2026 8:00 AM', 'month-first')!;
    const finish = parseCsvDate('1/5/2026 5:00 PM', 'month-first')!;
    assert.ok(finish > start, `expected finish (${finish}) > start (${start})`);
  });

  it('accepts a single-digit minute instead of silently falling back to 08:00 (regression)', () => {
    // Bug: the minute group required exactly two digits, so "14:5" failed
    // to match the time regex at all and fell back to the 08:00 default.
    assert.strictEqual(parseCsvDate('1/5/2026 14:5', 'month-first'), '2026-01-05T14:05:00');
  });

  it('parses AM/PM correctly when the time carries seconds — Excel default rendering (regression)', () => {
    // Bug (PR #1963 review): the time regex had no seconds group, so for
    // "5:00:00 PM" it matched only "5:00" — the ":00 PM" remainder (seconds
    // plus meridiem) sat unconsumed after the minutes group and the meridiem
    // capture group never matched, silently discarding PM. `h:mm:ss AM/PM`
    // is Excel's default datetime rendering, so this is not an edge case.
    assert.strictEqual(parseCsvDate('1/5/2026 5:00:00 PM', 'month-first'), '2026-01-05T17:00:00');
    assert.strictEqual(parseCsvDate('1/5/2026 8:00:00 AM', 'month-first'), '2026-01-05T08:00:00');
  });

  it('does not invert an 8:00:00 AM start against a 5:00:00 PM finish (regression)', () => {
    const start = parseCsvDate('1/5/2026 8:00:00 AM', 'month-first')!;
    const finish = parseCsvDate('1/5/2026 5:00:00 PM', 'month-first')!;
    assert.ok(finish > start, `expected finish (${finish}) > start (${start})`);
  });

  it('ignores the seconds value itself — output stays :00, matched but not parsed', () => {
    // See extractDateParts' doc comment: seconds are matched-and-discarded
    // (the ISO output format only ever carries minute precision), so a
    // nonsense seconds value like ":99" has nowhere to surface and is
    // silently ignored rather than validated. Documented, not a bug.
    assert.strictEqual(parseCsvDate('1/5/2026 5:00:99 PM', 'month-first'), '2026-01-05T17:00:00');
  });

  it('rejects an out-of-range time (25:99) instead of producing an invalid ISO string (regression)', () => {
    // Same class as the impossible-calendar-date fix above: an unvalidated
    // hour/minute let a typo like "25:99" through as a syntactically
    // valid-looking (but nonsensical) date instead of being refused.
    assert.strictEqual(parseCsvDate('1/5/2026 25:99', 'month-first'), undefined);
    assert.strictEqual(parseCsvDate('1/5/2026 25:00', 'month-first'), undefined);
    assert.strictEqual(parseCsvDate('1/5/2026 10:99', 'month-first'), undefined);
  });
});

/**
 * Found by line-level mutation coverage, not by review: three lines in
 * `extractDateParts` could be removed without a single test failing.
 *
 * The two-digit-year pivot is the one that mattered. MS Project's own CSV
 * export writes years as `26`, not `2026` — so a "simplification" of that line
 * would silently reinterpret every date in a real export as year 26 AD, which
 * is precisely the class of silent wrongness this importer exists to prevent.
 * That line is now pinned: removing it fails the first test below.
 *
 * The other two (`if (!text) return null` and `if (!match) return null`) are a
 * different case, worth recording rather than papering over: the blank-cell
 * guard is *redundant*, not untested. Delete it and an empty cell still
 * returns null via the `!match` path below, so no test can distinguish it —
 * it is a cheap early-out, not behaviour. The tests below therefore pin the
 * observable contract (blank and junk cells yield `undefined`, never a date at
 * the epoch), which is the thing callers depend on, rather than pretending to
 * pin a line that carries no behaviour of its own.
 */
describe('extractDateParts — guards that no test previously pinned', () => {
  it('applies MS Project’s two-digit-year pivot: 00-29 → 2000s, 30-99 → 1900s', () => {
    assert.strictEqual(parseCsvDate('05/01/26', 'day-first'), '2026-01-05T08:00:00');
    assert.strictEqual(parseCsvDate('05/01/29', 'day-first'), '2029-01-05T08:00:00');
    // 30 is the pivot: the first year that reads as last century.
    assert.strictEqual(parseCsvDate('05/01/30', 'day-first'), '1930-01-05T08:00:00');
    assert.strictEqual(parseCsvDate('05/01/95', 'day-first'), '1995-01-05T08:00:00');
    // A four-digit year is never pivoted.
    assert.strictEqual(parseCsvDate('05/01/2026', 'day-first'), '2026-01-05T08:00:00');
  });

  it('returns undefined for a blank cell rather than a date at the epoch', () => {
    assert.strictEqual(parseCsvDate('', 'day-first'), undefined);
    assert.strictEqual(parseCsvDate('   ', 'day-first'), undefined);
  });

  it('returns undefined for text that is not a date at all', () => {
    assert.strictEqual(parseCsvDate('not-a-date', 'day-first'), undefined);
    assert.strictEqual(parseCsvDate('TBD', 'day-first'), undefined);
  });
});
