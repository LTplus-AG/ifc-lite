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
});
