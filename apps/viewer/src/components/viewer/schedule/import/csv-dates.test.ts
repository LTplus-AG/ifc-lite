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
});
