/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading and ordering `xs:restriction` bound facets by the restriction's
 * `@base` (#7399).
 *
 * `parseFloat` read every bound, and every value it bounded, whatever the
 * base: `2024-03-31` became 2024 and `6,5` became 6, so a date range collapsed
 * to one year and a malformed bound silently truncated. Here a bound is read
 * only when its whole text is in the base's lexical space, and compared in the
 * base's own order:
 *
 *  - numeric bases: a number, accepted only as a whole lexeme of the base
 *    (`xs:integer` and its derivations take no fraction);
 *  - `xs:date` / `xs:dateTime` / `xs:time`: a point on the time line,
 *    normalised to UTC, with XSD's ±14:00 rule for a zone-less value against a
 *    zoned one (Part 2 §3.2.7.4);
 *  - `xs:duration`: XSD's partial order, decided at the four reference
 *    instants the spec names (§3.2.6.2).
 *
 * Where XSD calls an order indeterminate, `compareOrdered` returns
 * `undefined`, and the matcher fails closed.
 */

import { isWhollyNumeric } from '@ifc-lite/encoding';
import { isValidXsdDateTimeLiteral, type XsdDateTimeBase } from './xsd-datetime.js';
import { isValidLexicalForXsType } from './xsd-lexical.js';

/** How a base orders its bounds. */
export type BoundOrder = 'numeric' | 'temporal' | 'duration';

const INTEGER_LOCALS = new Set([
  'integer', 'long', 'int', 'short', 'byte',
  'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
]);

/** `xs:date`, `xsd:date` and `date` all name the same base. */
function localName(base: string | undefined): string {
  if (!base) return '';
  const colon = base.lastIndexOf(':');
  return colon >= 0 ? base.slice(colon + 1) : base;
}

function dateTimeBaseOf(base: string | undefined): XsdDateTimeBase | undefined {
  const local = localName(base);
  return local === 'date' || local === 'dateTime' || local === 'time' ? `xs:${local}` : undefined;
}

/**
 * The order a restriction's bounds live in. A base that orders by neither
 * the time line nor duration (numeric, `xs:string`, absent) keeps the numeric
 * reading bounds have always had, now strict.
 */
export function boundOrderOf(base: string | undefined): BoundOrder {
  if (dateTimeBaseOf(base) !== undefined) return 'temporal';
  return localName(base) === 'duration' ? 'duration' : 'numeric';
}

/** The bases whose value space includes the infinities (`+INF`, `-INF`). */
const INFINITE_LOCALS = new Set(['double', 'float']);

/**
 * A bound or value under a numeric base: the number its WHOLE text denotes,
 * or `undefined`. `xs:integer` and its derivations reject a fraction; every
 * other base takes the `xs:double` lexical space, except that only
 * `xs:double` and `xs:float` have infinities — `+INF` under `xs:decimal`,
 * `xs:string` or no base is not a number (PR #7411 review). `NaN` is a
 * lexeme of `xs:double` but orders nothing, so it is not a usable bound
 * either. Surrounding whitespace is collapsed, as XSD does for every
 * numeric type.
 */
export function readNumeric(raw: string, base: string | undefined): number | undefined {
  const text = raw.trim();
  const local = localName(base);
  const integer = INTEGER_LOCALS.has(local);
  if (!isValidLexicalForXsType(text, integer ? 'xs:integer' : 'xs:double')) return undefined;
  if (text === '+INF' || text === '-INF') {
    if (!INFINITE_LOCALS.has(local)) return undefined;
    return text === '+INF' ? Infinity : -Infinity;
  }
  if (!isWhollyNumeric(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A bound under a temporal or duration base, as its validated, trimmed
 * lexeme; `undefined` when it is not in the base's value space.
 */
export function readOrderedLexeme(raw: string, base: string | undefined): string | undefined {
  const text = raw.trim();
  return parseKey(text, base) === undefined ? undefined : text;
}

/** Whether `value` is in the value space of a temporal or duration `base`. */
export function isOrderedValue(value: string, base: string | undefined): boolean {
  return parseKey(value.trim(), base) !== undefined;
}

// ---------------------------------------------------------------------------
// The time line
// ---------------------------------------------------------------------------

/** Seconds on a UTC time line, the fraction kept as digits so it is exact. */
interface Instant {
  seconds: number;
  fraction: string;
  zoned: boolean;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar (Hinnant). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const DATE_TIME_PARTS =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$/;

/** XSD 1.0 maps an `xs:time` onto this date to order it (§3.2.8). */
const TIME_REFERENCE_DATE = '1972-12-31T';

function toInstant(text: string, base: XsdDateTimeBase): Instant | undefined {
  if (!isValidXsdDateTimeLiteral(text, base)) return undefined;
  const m = DATE_TIME_PARTS.exec(base === 'xs:time' ? TIME_REFERENCE_DATE + text : text);
  if (!m) return undefined;
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', tz] = m;
  let seconds =
    daysFromCivil(Number(y), Number(mo), Number(d)) * 86400 +
    Number(h) * 3600 + Number(mi) * 60 + Number(s);
  if (tz !== undefined && tz !== 'Z') {
    const offset = (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6))) * 60;
    seconds -= tz[0] === '+' ? offset : -offset;
  }
  return { seconds, fraction: frac.replace(/0+$/, ''), zoned: tz !== undefined };
}

function sign(n: number): -1 | 0 | 1 {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

function compareAt(aSeconds: number, aFraction: string, bSeconds: number, bFraction: string): -1 | 0 | 1 {
  if (aSeconds !== bSeconds) return sign(aSeconds - bSeconds);
  const width = Math.max(aFraction.length, bFraction.length);
  const fa = aFraction.padEnd(width, '0');
  const fb = bFraction.padEnd(width, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/** XSD's widest zone offset, in seconds: a zone-less value spans ±14:00. */
const ZONE_SPAN = 14 * 3600;

function compareInstants(a: Instant, b: Instant): -1 | 0 | 1 | undefined {
  if (a.zoned === b.zoned) return compareAt(a.seconds, a.fraction, b.seconds, b.fraction);
  // One side has no zone, so it stands for every instant within ±14:00 of
  // its clock reading; the order is decided only if it holds for all of them.
  const [zoned, local, flip] = a.zoned ? [a, b, 1] : [b, a, -1];
  if (compareAt(zoned.seconds, zoned.fraction, local.seconds - ZONE_SPAN, local.fraction) < 0) {
    return flip === 1 ? -1 : 1;
  }
  if (compareAt(zoned.seconds, zoned.fraction, local.seconds + ZONE_SPAN, local.fraction) > 0) {
    return flip === 1 ? 1 : -1;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

interface Duration {
  months: number;
  seconds: number;
}

const DURATION_PARTS =
  /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

function toDuration(text: string): Duration | undefined {
  const m = DURATION_PARTS.exec(text);
  if (!m) return undefined;
  const [, neg, y, mo, d, h, mi, s] = m;
  // `P` alone, or a `T` with nothing after it, is not a duration.
  if ([y, mo, d, h, mi, s].every((part) => part === undefined)) return undefined;
  if (text.includes('T') && [h, mi, s].every((part) => part === undefined)) return undefined;
  const k = neg ? -1 : 1;
  return {
    months: k * (Number(y ?? 0) * 12 + Number(mo ?? 0)),
    seconds: k * (Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)),
  };
}

/** The four starting instants XSD orders durations from (§3.2.6.2). */
const DURATION_REFERENCES: ReadonlyArray<readonly [number, number]> = [
  [1696, 9], [1697, 2], [1903, 3], [1903, 7],
];

function endFrom([year, month]: readonly [number, number], d: Duration): number {
  // Every reference is the first of its month, so adding months never needs
  // the end-of-month pinning XSD's addition algorithm otherwise applies.
  const index = month - 1 + d.months;
  const y = year + Math.floor(index / 12);
  const m = index - Math.floor(index / 12) * 12 + 1;
  return daysFromCivil(y, m, 1) * 86400 + d.seconds;
}

function compareDurations(a: Duration, b: Duration): -1 | 0 | 1 | undefined {
  const signs = DURATION_REFERENCES.map((ref) => sign(endFrom(ref, a) - endFrom(ref, b)));
  return signs.every((s) => s === signs[0]) ? signs[0] : undefined;
}

// ---------------------------------------------------------------------------

type Key = { kind: 'instant'; instant: Instant } | { kind: 'duration'; duration: Duration };

function parseKey(text: string, base: string | undefined): Key | undefined {
  const dateTimeBase = dateTimeBaseOf(base);
  if (dateTimeBase !== undefined) {
    const instant = toInstant(text, dateTimeBase);
    return instant && { kind: 'instant', instant };
  }
  if (localName(base) === 'duration') {
    const duration = toDuration(text);
    return duration && { kind: 'duration', duration };
  }
  return undefined;
}

/**
 * Order `value` against `bound` under a temporal or duration `base`: -1, 0 or
 * 1, or `undefined` when `value` is not in the base's value space or XSD
 * leaves the pair unordered. Callers fail closed on `undefined`.
 */
export function compareOrdered(
  value: string | number | boolean,
  bound: string,
  base: string | undefined
): -1 | 0 | 1 | undefined {
  if (typeof value !== 'string') return undefined;
  const a = parseKey(value.trim(), base);
  const b = parseKey(bound, base);
  if (a === undefined || b === undefined) return undefined;
  if (a.kind === 'instant' && b.kind === 'instant') return compareInstants(a.instant, b.instant);
  if (a.kind === 'duration' && b.kind === 'duration') return compareDurations(a.duration, b.duration);
  return undefined;
}
