/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `xs:date` / `xs:dateTime` / `xs:time` value space (#3721).
 *
 * A regex over digit RUNS decides the lexical shape and nothing else, so
 * `^\d{4}-\d{2}-\d{2}$` accepts `2024-13-45` and `2023-02-29`. XML Schema
 * Part 2 §3.2.7-3.2.9 layers a calendar value space on top of that shape:
 * month 1-12, day within that month under the Gregorian leap rule,
 * hour/minute/second in range with `24:00:00` as the only hour-24 form, and a
 * timezone offset no further out than ±14:00. XSD 1.1's own `explicitPattern`
 * for these types encodes every one of those bounds except day-in-month, which
 * it states as an assertion because no regex can express it.
 *
 * Two call sites decide the same question — the coherence audit's
 * `xs:restriction @base` check and the facets' strict-cast gate — so the
 * calendar lives here once instead of in a regex table per caller.
 */

/** The XSD bases whose value space this module decides. */
export type XsdDateTimeBase = 'xs:date' | 'xs:dateTime' | 'xs:time';

/**
 * Both callers dispatch on this rather than listing the bases themselves, so
 * the set of bases that get a calendar check is stated once, next to the
 * calendar. `xs:time` reaching a caller that enumerated only the other two is
 * not hypothetical: `IfcTimeSeries.StartTime` declares
 * `["xs:dateTime","xs:time"]`.
 */
export function isXsdDateTimeBase(base: string): base is XsdDateTimeBase {
  return base === 'xs:date' || base === 'xs:dateTime' || base === 'xs:time';
}

/**
 * Lexical shapes, deliberately no wider than the regexes they replace: a
 * four-digit unsigned year, so the XSD forms for years before 1 CE and after
 * 9999 stay rejected as they already were. Every quantifier has a fixed
 * length except the fractional second, which is followed only by characters
 * it cannot match, so no input backtracks (#3113).
 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const last = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= last;
}

/**
 * `24:00:00` is the end-of-day form XSD allows (it denotes the next day's
 * `00:00:00`), and it is the ONLY hour-24 lexeme: minutes, seconds and any
 * fractional digits must all be zero. Second 60 is never allowed — XSD has no
 * leap seconds.
 */
function isClockTime(
  hour: number,
  minute: number,
  second: number,
  fraction: string | undefined
): boolean {
  if (hour === 24) {
    return (
      minute === 0 &&
      second === 0 &&
      (fraction === undefined || /^0+$/.test(fraction))
    );
  }
  return hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * `Z`, or an offset within ±14:00 inclusive — at 14 hours the minutes must be
 * zero, which is why this is a comparison and not two independent ranges.
 */
function isTimezoneOffset(tz: string | undefined): boolean {
  if (tz === undefined || tz === 'Z') return true;
  const hours = Number(tz.slice(1, 3));
  const minutes = Number(tz.slice(4, 6));
  if (minutes > 59) return false;
  return hours < 14 || (hours === 14 && minutes === 0);
}

/**
 * Whether `value` is in the value space of `base` — both its lexical shape and
 * the calendar constraints XSD states on top of that shape.
 */
export function isValidXsdDateTimeLiteral(
  value: string,
  base: XsdDateTimeBase
): boolean {
  if (base === 'xs:time') {
    const m = TIME_RE.exec(value);
    if (!m) return false;
    return (
      isClockTime(Number(m[1]), Number(m[2]), Number(m[3]), m[4]) &&
      isTimezoneOffset(m[5])
    );
  }
  if (base === 'xs:date') {
    const m = DATE_RE.exec(value);
    if (!m) return false;
    return (
      isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) &&
      isTimezoneOffset(m[4])
    );
  }
  const m = DATE_TIME_RE.exec(value);
  if (!m) return false;
  return (
    isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) &&
    isClockTime(Number(m[4]), Number(m[5]), Number(m[6]), m[7]) &&
    isTimezoneOffset(m[8])
  );
}
