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
 * **Date order.** `05/01/2026` is genuinely ambiguous. Rather than pick a
 * locale, the whole column is scanned: a component above 12 anywhere proves
 * the order. Only when *no* row disambiguates does it fall back to
 * day-first, and then it says so via an `ambiguous-date-format` warning —
 * a silent wrong guess would shift every date in the schedule.
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
 */
function extractDateParts(raw: string): { parts: DateParts; iso: boolean } | null {
  const text = raw.trim();
  if (!text) return null;
  // Leading weekday names ("Mon 05/01/26") are decoration in MS Project exports.
  const cleaned = text.replace(/^[A-Za-z]{2,10}\.?[\s,]+/, '');
  const time = /(\d{1,2}):(\d{2})/.exec(cleaned);
  const hour = time ? Number(time[1]) : 8;
  const minute = time ? Number(time[2]) : 0;

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

/**
 * Decide day-first vs month-first across the whole file. A value above 12 in
 * either position proves that position is the day.
 */
export function detectDateOrder(cells: string[]): { order: CsvDateOrder; ambiguous: boolean } {
  let sawNonIso = false;
  for (const cell of cells) {
    const extracted = extractDateParts(cell);
    if (!extracted || extracted.iso) continue;
    sawNonIso = true;
    if (extracted.parts.a > 12) return { order: 'day-first', ambiguous: false };
    if (extracted.parts.b > 12) return { order: 'month-first', ambiguous: false };
  }
  if (!sawNonIso) return { order: 'iso', ambiguous: false };
  return { order: 'day-first', ambiguous: true };
}

function partsToIso(parts: DateParts, day: number, month: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${parts.year}-${pad(month)}-${pad(day)}T${pad(parts.hour)}:${pad(parts.minute)}:00`;
}

/** Convert a date cell to local ISO using the file-wide resolved order. */
export function parseCsvDate(raw: string, order: CsvDateOrder): string | undefined {
  const extracted = extractDateParts(raw);
  if (!extracted) return undefined;
  const { parts, iso } = extracted;
  if (iso) return partsToIso(parts, parts.b, parts.a);
  return order === 'month-first' ? partsToIso(parts, parts.b, parts.a) : partsToIso(parts, parts.a, parts.b);
}
