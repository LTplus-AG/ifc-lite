/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Date-order detection and parsing for the Gantt CSV importer (issue #1890).
 *
 * Split out of `csv.ts` (AGENTS.md: split modules over ~400 non-generated
 * lines) — this is the self-contained "what day is `05/01/2026`" concern;
 * everything else in `csv.ts` (column mapping, durations, predecessors) is
 * unrelated to it.
 *
 * **Date order.** `05/01/2026` is genuinely ambiguous. Every date cell in the
 * file is scanned (not just the first one that disambiguates): any cell with
 * a component above 12 in either position proves that position is the day
 * *for that cell*, and is parsed correctly regardless of the file-wide
 * order. Cells that stay ambiguous even alone (both components `<= 12`) fall
 * back to the file-wide order resolved from the unambiguous cells.
 *
 * If unambiguous cells disagree — one proves day-first, another proves
 * month-first, which happens when a spreadsheet mixes locales or a value was
 * hand-edited — that is reported as `mixed-date-format` and every ambiguous
 * cell in the file is refused (returns `undefined`, surfaced as
 * `unparsable-date`) rather than guessed from a majority vote: a wrong guess
 * here silently shifts dates, and this importer's whole design is to report
 * rather than guess. Unambiguous cells are unaffected and still parse
 * correctly. Only when *no* cell disambiguates at all does it fall back to
 * day-first for every cell, flagged via `ambiguous-date-format`.
 */

import type { CsvDateOrder } from './types.js';

export interface DateParts {
  a: number;
  b: number;
  year: number;
  hour: number;
  minute: number;
}

/**
 * Pull the numeric components out of a date cell without deciding yet which of
 * `a`/`b` is the day. ISO (`YYYY-MM-DD`) is unambiguous and flagged as such.
 *
 * The optional time-of-day suffix accepts an AM/PM marker (case-insensitive,
 * with or without a space before it, with or without dots — `8:00AM`,
 * `8:00 AM`, `8:00 a.m.` all match) and 1-2 digit minutes (`14:5` is a valid
 * `14:05`, not silently dropped to the 08:00 default). `12 AM` is midnight
 * (hour 0); `12 PM` stays hour 12; any other `PM` hour adds 12.
 *
 * An optional `:ss` seconds group is matched — so it no longer strands the
 * AM/PM marker after it — but the seconds value itself is discarded, not
 * parsed: `partsToIso` below has no field for it and only ever emits `:00`
 * seconds, so a captured value would have nowhere to go without changing
 * the output format. This also means a nonsense seconds value (`5:00:99
 * PM`) is silently ignored rather than validated or rejected — it never
 * reaches `partsToIso`'s hour/minute range check because it was never
 * captured in the first place. Documented here rather than validated,
 * since validating a value that is then thrown away would be dead code.
 */
function extractDateParts(raw: string): { parts: DateParts; iso: boolean } | null {
  const text = raw.trim();
  if (!text) return null;
  // Leading weekday names ("Mon 05/01/26") are decoration in MS Project exports.
  const cleaned = text.replace(/^[A-Za-z]{2,10}\.?[\s,]+/, '');
  // Seconds (`5:00:00 PM`, Excel's default datetime rendering) are matched
  // but intentionally not captured: `partsToIso` only ever emits `:00`
  // seconds, so there is nowhere for a parsed value to go without changing
  // the output format. Without this group the regex stopped at the minutes,
  // leaving ":00 PM" unconsumed between the minutes and meridiem groups —
  // the meridiem never matched and was silently discarded (PR #1963 review).
  const time = /(\d{1,2}):(\d{1,2})(?::\d{1,2})?\s*([AaPp]\.?[Mm]\.?)?/.exec(cleaned);
  let hour = time ? Number(time[1]) : 8;
  const minute = time ? Number(time[2]) : 0;
  const meridiem = time?.[3]?.toLowerCase().replace(/\./g, '');
  // A meridiem asserts a 12-hour clock, so an hour outside 1-12 contradicts
  // the cell's own notation. Guessing which half the author meant is the kind
  // of silent choice this module already refuses (see `refuseAmbiguous` and
  // the impossible-date check in `partsToIso`), and one of the guesses is
  // wrong by twelve hours: "00:00 PM" would otherwise become 12:00 rather
  // than surfacing as `unparsable-date`.
  if (meridiem && (hour < 1 || hour > 12)) return null;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  else if (meridiem === 'am' && hour === 12) hour = 0;

  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(cleaned);
  if (isoMatch) {
    return {
      parts: { a: Number(isoMatch[2]), b: Number(isoMatch[3]), year: Number(isoMatch[1]), hour, minute },
      iso: true,
    };
  }
  const match = /^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})/.exec(cleaned);
  if (!match) return null;
  let year = Number(match[3]);
  // Two-digit years: MS Project's own pivot — 00-29 is 2000s, 30-99 is 1900s.
  if (year < 100) year += year < 30 ? 2000 : 1900;
  return { parts: { a: Number(match[1]), b: Number(match[2]), year, hour, minute }, iso: false };
}

export interface DateOrderResult {
  order: CsvDateOrder;
  /** True when nothing in the file disambiguates order at all (majority-free fallback). */
  ambiguous: boolean;
  /**
   * Set when unambiguous cells disagree on order: at least one cell proves
   * day-first AND at least one (other) cell proves month-first. `order` is
   * still populated (first evidence found) but callers should not use it to
   * parse ambiguous cells — see the module doc comment.
   */
  conflict?: { dayFirstExample: string; monthFirstExample: string };
}

/**
 * Resolve day-first vs month-first evidence across the WHOLE file (never
 * stops at the first disambiguating cell). A component above 12 in a given
 * cell's first position proves that cell reads day-first — but only when
 * the *other* position is `<= 12`, since that other position has to be a
 * valid month for the reading to be possible at all. Likewise for a second
 * position above 12 proving month-first. When both components are above 12
 * in the same cell (e.g. "20/25/2026"), neither reading is valid — the cell
 * is evidence of nothing (it's simply unparsable, reported separately by
 * `parseCsvDate`/`partsToIso`), not proof of both orders in the same
 * breath, which would otherwise manufacture a `conflict` out of one
 * malformed cell rather than genuine disagreement between two cells. When
 * both kinds of evidence occur across *different* cells in the same file,
 * `conflict` is populated instead of silently picking one.
 */
export function detectDateOrder(cells: string[]): DateOrderResult {
  let sawNonIso = false;
  let dayFirstExample: string | undefined;
  let monthFirstExample: string | undefined;

  for (const cell of cells) {
    const extracted = extractDateParts(cell);
    if (!extracted || extracted.iso) continue;
    sawNonIso = true;
    const { a, b } = extracted.parts;
    if (a > 12 && b <= 12 && dayFirstExample === undefined) dayFirstExample = cell.trim();
    if (b > 12 && a <= 12 && monthFirstExample === undefined) monthFirstExample = cell.trim();
  }

  if (dayFirstExample !== undefined && monthFirstExample !== undefined) {
    return { order: 'day-first', ambiguous: false, conflict: { dayFirstExample, monthFirstExample } };
  }
  if (dayFirstExample !== undefined) return { order: 'day-first', ambiguous: false };
  if (monthFirstExample !== undefined) return { order: 'month-first', ambiguous: false };
  if (!sawNonIso) return { order: 'iso', ambiguous: false };
  return { order: 'day-first', ambiguous: true };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

/**
 * `day > 31` alone lets through impossible dates like `31/02` or `31/04` —
 * every non-ISO cell goes through here (and the ISO branch reuses it too,
 * via `parseCsvDate`), so a calendar-aware bound is required, not just a
 * fixed upper limit.
 */
function partsToIso(parts: DateParts, day: number, month: number): string | undefined {
  if (month < 1 || month > 12 || day < 1) return undefined;
  if (day > daysInMonth(parts.year, month)) return undefined;
  // Same class as the impossible-date fix above: an unvalidated hour/minute
  // would let a typo like "25:99" through as a syntactically valid-looking
  // date instead of surfacing as `unparsable-date`.
  if (parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59) return undefined;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${parts.year}-${pad(month)}-${pad(day)}T${pad(parts.hour)}:${pad(parts.minute)}:00`;
}

/**
 * Convert a date cell to local ISO. `order` supplies the file-wide fallback
 * for a cell that is ambiguous on its own; a cell with a component above 12
 * in either position is resolved from that value alone, regardless of
 * `order`. When `refuseAmbiguous` is set (the file has conflicting
 * unambiguous evidence — see `detectDateOrder`'s `conflict`), a cell that
 * needs the fallback returns `undefined` instead of guessing.
 */
export function parseCsvDate(raw: string, order: CsvDateOrder, refuseAmbiguous = false): string | undefined {
  const extracted = extractDateParts(raw);
  if (!extracted) return undefined;
  const { parts, iso } = extracted;
  if (iso) return partsToIso(parts, parts.b, parts.a);
  if (parts.a > 12) return partsToIso(parts, parts.a, parts.b);
  if (parts.b > 12) return partsToIso(parts, parts.b, parts.a);
  if (refuseAmbiguous) return undefined;
  return order === 'month-first' ? partsToIso(parts, parts.b, parts.a) : partsToIso(parts, parts.a, parts.b);
}
