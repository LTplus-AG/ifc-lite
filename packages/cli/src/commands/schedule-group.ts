/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sorting and grouping for `ifc-lite schedule` (PR-2).
 *
 * `--sort` and `--group-by` both name column HEADERS (the left side of a
 * `Header=path` spec), never paths, so a header that is not among the declared
 * `--columns` is a `fatal(...)` with the valid headers listed. Ordering runs
 * once, after row assembly: rows are paired with their original entity index so
 * that index is the stable tiebreaker, group headers order first (so each group
 * is contiguous) followed by the remaining `--sort` keys.
 */

import { fatal } from '../output.js';
import type { ScheduleColumn } from './schedule-columns.js';
import type { ScheduleRow } from './schedule-render.js';

export type SortDir = 'asc' | 'desc';

/** One `--sort` key: a declared column plus a direction. */
export interface SortKey {
  header: string;
  index: number;
  dir: SortDir;
}

/** One `--group-by` key: a declared column. */
export interface GroupKey {
  header: string;
  index: number;
}

function headerIndex(columns: ScheduleColumn[], header: string, flag: string): number {
  const idx = columns.findIndex(c => c.header === header);
  if (idx === -1) {
    const valid = columns.map(c => c.header).join(', ');
    fatal(`${flag} header "${header}" is not a declared --columns header. Valid headers: ${valid}`);
  }
  return idx;
}

/**
 * Parse `--sort "<Header>[:asc|desc][, ...]"` into ordered keys. Default
 * direction is asc; an unknown direction suffix is a `fatal(...)`.
 */
export function parseSortSpec(spec: string | undefined, columns: ScheduleColumn[]): SortKey[] {
  if (spec === undefined || spec.trim() === '') return [];
  const keys: SortKey[] = [];
  for (const rawSegment of spec.split(',')) {
    const segment = rawSegment.trim();
    if (segment === '') fatal(`Invalid --sort spec: empty key in "${spec}". Expected "Header[:asc|desc][, ...]".`);
    const colonIdx = segment.lastIndexOf(':');
    let header = segment;
    let dir: SortDir = 'asc';
    if (colonIdx !== -1) {
      const suffix = segment.slice(colonIdx + 1).trim().toLowerCase();
      if (suffix === 'asc' || suffix === 'desc') {
        header = segment.slice(0, colonIdx).trim();
        dir = suffix;
      }
      // No recognised direction suffix: treat the whole segment as a header
      // (a header legitimately may contain a colon).
    }
    if (header === '') fatal(`Invalid --sort key "${segment}": missing header.`);
    keys.push({ header, index: headerIndex(columns, header, '--sort'), dir });
  }
  return keys;
}

/** Parse `--group-by "<Header>[, ...]"` into ordered keys. */
export function parseGroupBySpec(spec: string | undefined, columns: ScheduleColumn[]): GroupKey[] {
  if (spec === undefined || spec.trim() === '') return [];
  const keys: GroupKey[] = [];
  for (const rawSegment of spec.split(',')) {
    const header = rawSegment.trim();
    if (header === '') fatal(`Invalid --group-by spec: empty key in "${spec}". Expected "Header[, ...]".`);
    keys.push({ header, index: headerIndex(columns, header, '--group-by') });
  }
  return keys;
}

/**
 * Coerce a cell to a finite number when it fully parses as one, else `null`.
 * A `null`/empty cell and a non-numeric string are both `null` so the caller
 * can sort them last and skip them in a numeric aggregation.
 */
export function cellToNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True for a cell that sorts last (missing / empty). */
function isNullish(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Compare two cells for one ordering key. Both-numeric compares numerically,
 * otherwise string compare; a nullish cell always sorts last (independent of
 * direction). Returns the direction-adjusted comparison.
 */
function compareCell(a: unknown, b: unknown, dir: SortDir): number {
  const an = isNullish(a);
  const bn = isNullish(b);
  if (an && bn) return 0;
  if (an) return 1; // a is missing -> after b, regardless of dir
  if (bn) return -1;

  const na = cellToNumber(a);
  const nb = cellToNumber(b);
  let cmp: number;
  if (na !== null && nb !== null) cmp = na < nb ? -1 : na > nb ? 1 : 0;
  else cmp = String(a).localeCompare(String(b));
  return dir === 'desc' ? -cmp : cmp;
}

/**
 * Order rows for output. Group headers order first (asc, or the direction the
 * same header carries as a `--sort` key) so each group is contiguous, then the
 * remaining `--sort` keys, then the original entity index as the stable
 * tiebreaker. Returns a new array; the input is not mutated.
 */
export function orderRows(rows: ScheduleRow[], sortKeys: SortKey[], groupKeys: GroupKey[]): ScheduleRow[] {
  const groupHeaders = new Set(groupKeys.map(g => g.header));
  const orderKeys: Array<{ index: number; dir: SortDir }> = [
    ...groupKeys.map(g => {
      const asSort = sortKeys.find(s => s.header === g.header);
      return { index: g.index, dir: asSort ? asSort.dir : ('asc' as SortDir) };
    }),
    ...sortKeys.filter(s => !groupHeaders.has(s.header)).map(s => ({ index: s.index, dir: s.dir })),
  ];

  const indexed = rows.map((row, i) => ({ row, i }));
  indexed.sort((a, b) => {
    for (const key of orderKeys) {
      const cmp = compareCell(a.row[key.index], b.row[key.index], key.dir);
      if (cmp !== 0) return cmp;
    }
    return a.i - b.i; // stable: preserve original entity order
  });
  return indexed.map(x => x.row);
}
