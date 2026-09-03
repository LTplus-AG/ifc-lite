/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3721 — the `xs:date` / `xs:dateTime` / `xs:time` checks decided the digit-run
 * shape and nothing else, so `2024-13-45`, `2023-02-29`, `2024-01-01+99:99` and
 * `2024-01-01T99:99:99` all passed as valid. Both call sites are exercised here:
 * the coherence audit's `xs:restriction @base` check and the facets' strict-cast
 * gate, because a fix at only one of them leaves the other accepting.
 */

import { describe, expect, it } from 'vitest';

import { runCoherenceAudit } from '../audit/coherence/index.js';
import type { IDSDocument } from '../types.js';
import { literalCastsUnder, literalCastsUnderAnyType } from './xsd-cast.js';
import { isValidXsdDateTimeLiteral, isXsdDateTimeBase } from './xsd-datetime.js';

/** The four values the issue names, plus the rest of the calendar class. */
const REJECTED: ReadonlyArray<readonly [string, 'xs:date' | 'xs:dateTime' | 'xs:time']> = [
  ['2024-13-45', 'xs:date'], // month 13, day 45
  ['2023-02-29', 'xs:date'], // 2023 is not a leap year
  ['2024-01-01+99:99', 'xs:date'], // timezone offset out of range
  ['2024-01-01T99:99:99', 'xs:dateTime'], // hour/minute/second out of range
  ['2024-00-01', 'xs:date'], // month 0
  ['2024-01-00', 'xs:date'], // day 0
  ['2024-04-31', 'xs:date'], // April has 30 days
  ['1900-02-29', 'xs:date'], // century, not a leap year
  ['2100-02-29', 'xs:date'], // century, not a leap year
  ['2024-01-01+14:01', 'xs:date'], // 1 minute past the ±14:00 bound
  ['2024-01-01-15:00', 'xs:date'], // 1 hour past it, negative side
  ['2024-01-01T12:00:60', 'xs:dateTime'], // XSD has no leap second
  ['2024-01-01T24:00:01', 'xs:dateTime'], // hour 24 is end-of-day only
  ['2024-01-01T24:30:00', 'xs:dateTime'],
  ['2024-01-01T24:00:00.5', 'xs:dateTime'], // end-of-day carries no fraction
  ['25:00:00', 'xs:time'],
  ['12:60:00', 'xs:time'],
  ['12:00:60', 'xs:time'],
  ['12:00:00+99:99', 'xs:time'],
];

/** Real values a conformant validator must keep accepting. */
const ACCEPTED: ReadonlyArray<readonly [string, 'xs:date' | 'xs:dateTime' | 'xs:time']> = [
  ['2024-02-29', 'xs:date'], // 2024 IS a leap year
  ['2000-02-29', 'xs:date'], // divisible by 400
  ['2024-12-31', 'xs:date'],
  ['2024-01-31Z', 'xs:date'],
  ['2024-01-01+14:00', 'xs:date'], // the bound itself is inclusive
  ['2024-01-01-14:00', 'xs:date'],
  ['2024-01-01+13:59', 'xs:date'],
  ['2024-01-01T00:00:00', 'xs:dateTime'],
  ['2024-01-01T23:59:59.9999Z', 'xs:dateTime'],
  ['2024-01-01T24:00:00', 'xs:dateTime'], // the end-of-day form XSD allows
  ['2024-01-01T24:00:00.000', 'xs:dateTime'],
  ['00:00:00', 'xs:time'],
  ['24:00:00', 'xs:time'],
  ['23:59:59.001-05:00', 'xs:time'],
];

describe('isValidXsdDateTimeLiteral (#3721)', () => {
  it.each(REJECTED)('rejects %s as %s', (value, base) => {
    expect(isValidXsdDateTimeLiteral(value, base)).toBe(false);
  });

  it.each(ACCEPTED)('accepts %s as %s', (value, base) => {
    expect(isValidXsdDateTimeLiteral(value, base)).toBe(true);
  });

  it('still rejects the malformed shapes the old regex rejected', () => {
    expect(isValidXsdDateTimeLiteral('not-a-date', 'xs:date')).toBe(false);
    expect(isValidXsdDateTimeLiteral('2024-1-1', 'xs:date')).toBe(false);
    expect(isValidXsdDateTimeLiteral('2024-01-01', 'xs:dateTime')).toBe(false);
    expect(isValidXsdDateTimeLiteral('2024-01-01T12:00', 'xs:dateTime')).toBe(false);
    expect(isValidXsdDateTimeLiteral('12:00:00.', 'xs:time')).toBe(false);
    expect(isValidXsdDateTimeLiteral('', 'xs:date')).toBe(false);
  });

  it('names exactly the three bases whose value space is a calendar', () => {
    // The coherence audit dispatches on this: a base that answers false here
    // falls through to the regex table, so a missing entry is a silent hole.
    // Asserted as an exact PARTITION rather than as `.every(...)` on the three
    // — `every` proves the three are in and proves nothing about what is out,
    // so a wrong `xs:gYear` classification would pass it. The gregorian family
    // is the realistic mistake: those types look date-shaped and are date
    // adjacent, but their value space is not a calendar date and the regex
    // table is the right home for them.
    expect(
      [
        'xs:date',
        'xs:dateTime',
        'xs:time',
        'xs:gYear',
        'xs:gYearMonth',
        'xs:gMonth',
        'xs:gMonthDay',
        'xs:gDay',
        'xs:duration',
        'xs:double',
      ].filter(isXsdDateTimeBase)
    ).toEqual(['xs:date', 'xs:dateTime', 'xs:time']);
  });
});

describe('literalCastsUnder date family (#3721)', () => {
  it.each(REJECTED)('refuses to cast %s under %s', (value, base) => {
    expect(literalCastsUnder(value, base)).toBe(false);
  });

  it.each(ACCEPTED)('casts %s under %s', (value, base) => {
    expect(literalCastsUnder(value, base)).toBe(true);
  });

  it('gates a literal against an xs:dateTime/xs:time slot instead of waving it through', () => {
    // `IfcTimeSeries.StartTime` declares `["xs:dateTime","xs:time"]`, and
    // `xs:time` had no arm here, so `.some()` found the permissive default and
    // EVERY literal cast — the gate was vacuous on those attributes.
    const slot = ['xs:dateTime', 'xs:time'];
    expect(literalCastsUnderAnyType('banana', slot)).toBe(false);
    expect(literalCastsUnderAnyType('2024-01-01T08:30:00', slot)).toBe(true);
    expect(literalCastsUnderAnyType('08:30:00', slot)).toBe(true);
  });
});

describe('coherence xs:restriction @base date family (#3721)', () => {
  /** One specification whose enumeration carries `value` under `base`. */
  const docWith = (value: string, base: string): IDSDocument => ({
    info: { title: 'T' },
    specifications: [
      {
        id: 's1',
        name: 'S',
        ifcVersions: ['IFC4'],
        applicability: {
          facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }],
        },
        requirements: [
          {
            id: 'r1',
            optionality: 'required',
            facet: {
              type: 'attribute',
              name: { type: 'simpleValue', value: 'Name' },
              value: { type: 'enumeration', values: [value], base },
            },
          },
        ],
      },
    ],
  });

  /** Whether the audit accepted `value` as a lexical `base`. */
  const accepts = (value: string, base: string): boolean =>
    !runCoherenceAudit(docWith(value, base)).some(
      (i) => i.code === 'E_RESTRICTION_VALUE_MISMATCH'
    );

  it('the fixture reaches the check at all (a doc with no issue proves nothing)', () => {
    expect(accepts('not-a-date', 'xs:date')).toBe(false);
    expect(accepts('2024-01-01', 'xs:date')).toBe(true);
  });

  it.each(REJECTED)('flags %s under base %s', (value, base) => {
    expect(accepts(value, base)).toBe(false);
  });

  it.each(ACCEPTED)('leaves %s under base %s alone', (value, base) => {
    expect(accepts(value, base)).toBe(true);
  });

  it('leaves the bases with no calendar untouched', () => {
    expect(accepts('P1Y2M', 'xs:duration')).toBe(true);
    expect(accepts('12.0', 'xs:double')).toBe(true);
    expect(accepts('anything', 'xs:string')).toBe(true);
  });
});
