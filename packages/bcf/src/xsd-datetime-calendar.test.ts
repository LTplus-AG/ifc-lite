/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `normalizeXsdDateTime` value-space guard: the xs:dateTime/xs:date VALUE
 * space excludes calendar-impossible lexemes even when they match the
 * lexical grammar — a schema validator rejects `2026-02-30T00:00:00Z` just
 * as hard as free text, so the writer must refuse it the same way rather
 * than emit an archive that fails validation.
 */

import { describe, it, expect } from 'vitest';
import { normalizeXsdDateTime } from './xsd-required-string.js';

describe('normalizeXsdDateTime — calendar validity (value space)', () => {
  it('keeps accepting valid dateTimes unchanged and bare dates as midnight UTC', () => {
    expect(normalizeXsdDateTime('2026-11-20T09:00:00Z')).toBe('2026-11-20T09:00:00Z');
    expect(normalizeXsdDateTime('2026-11-20T09:00:00.123+01:30')).toBe(
      '2026-11-20T09:00:00.123+01:30'
    );
    expect(normalizeXsdDateTime('2026-01-31')).toBe('2026-01-31T00:00:00Z');
    // Leap day of an actual leap year.
    expect(normalizeXsdDateTime('2024-02-29')).toBe('2024-02-29T00:00:00Z');
    // XSD's end-of-day hour 24 is legal only as 24:00:00.
    expect(normalizeXsdDateTime('2026-11-20T24:00:00Z')).toBe('2026-11-20T24:00:00Z');
    // The extreme legal timezone offsets.
    expect(normalizeXsdDateTime('2026-11-20T09:00:00+14:00')).toBe(
      '2026-11-20T09:00:00+14:00'
    );
    expect(normalizeXsdDateTime('2026-11-20T09:00:00-14:00')).toBe(
      '2026-11-20T09:00:00-14:00'
    );
  });

  it('rejects calendar-impossible dates that match the lexical grammar', () => {
    expect(normalizeXsdDateTime('2026-13-01T00:00:00Z')).toBeUndefined(); // month 13
    expect(normalizeXsdDateTime('2026-00-10T00:00:00Z')).toBeUndefined(); // month 0
    expect(normalizeXsdDateTime('2026-02-30T00:00:00Z')).toBeUndefined(); // Feb 30
    expect(normalizeXsdDateTime('2026-02-29T00:00:00Z')).toBeUndefined(); // non-leap Feb 29
    expect(normalizeXsdDateTime('2100-02-29T00:00:00Z')).toBeUndefined(); // century non-leap
    expect(normalizeXsdDateTime('2026-04-31T00:00:00Z')).toBeUndefined(); // April 31
    expect(normalizeXsdDateTime('2026-01-00T00:00:00Z')).toBeUndefined(); // day 0
    expect(normalizeXsdDateTime('2026-02-30')).toBeUndefined(); // bare-date branch too
    expect(normalizeXsdDateTime('2026-13-05')).toBeUndefined();
  });

  it('rejects out-of-range times and timezone offsets', () => {
    expect(normalizeXsdDateTime('2026-11-20T25:00:00Z')).toBeUndefined(); // hour 25
    expect(normalizeXsdDateTime('2026-11-20T24:00:01Z')).toBeUndefined(); // 24 with nonzero
    expect(normalizeXsdDateTime('2026-11-20T09:60:00Z')).toBeUndefined(); // minute 60
    expect(normalizeXsdDateTime('2026-11-20T09:00:60Z')).toBeUndefined(); // second 60
    expect(normalizeXsdDateTime('2026-11-20T09:00:00+15:00')).toBeUndefined(); // tz > +14
    expect(normalizeXsdDateTime('2026-11-20T09:00:00+14:30')).toBeUndefined(); // beyond +14:00
    expect(normalizeXsdDateTime('2026-11-20T09:00:00-99:99')).toBeUndefined();
  });
});
