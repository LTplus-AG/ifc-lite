/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generic Gantt / MS Project CSV → {@link ImportedTaskRow}s (issue #1890).
 *
 * CSV is the lossy path — MSPDI is preferred where the user can produce it —
 * because exports vary by tool and locale. Three things are handled explicitly
 * rather than guessed at:
 *
 *  - **Column names.** Matched against alias sets, case- and space-insensitive,
 *    so "Task Name", "Activity", and "Name" all resolve.
 *  - **Date order.** `05/01/2026` is genuinely ambiguous. Every date cell in
 *    the file is scanned (not just the first one that disambiguates), and an
 *    unambiguous cell (a component above 12) is read from its own value
 *    regardless of the file-wide order. If unambiguous cells disagree with
 *    each other, that is reported as `mixed-date-format` and every ambiguous
 *    cell is refused rather than guessed from a majority. Only when *no* cell
 *    disambiguates at all does it fall back to day-first for the whole file,
 *    via an `ambiguous-date-format` warning — a silent wrong guess would
 *    shift every date in the schedule.
 *  - **Predecessor grammar.** MS Project's `12FS+3 days` form, including leads
 *    (`12SS-1 day`), bare ids, and `,`/`;` separated lists.
 */

import { detectDateOrder, parseCsvDate } from './csv-dates.js';
import { SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE, parseCsvPredecessors, unitToSeconds } from './csv-predecessors.js';
import type { ImportedTaskRow, ParsedScheduleSource, ScheduleImportWarning } from './types.js';

// Re-exported so existing imports of `csv.js` keep working unchanged after
// the date-order/parsing and predecessor-grammar logic moved into
// ./csv-dates.js and ./csv-predecessors.js (AGENTS.md module-size split).
export { detectDateOrder, parseCsvDate } from './csv-dates.js';
export { parseCsvPredecessors } from './csv-predecessors.js';

/** Column aliases, lower-cased and stripped of non-alphanumerics for matching. */
const COLUMN_ALIASES: Record<string, string[]> = {
  id: ['id', 'uid', 'uniqueid', 'taskid', 'no', 'number'],
  name: ['name', 'taskname', 'task', 'activity', 'activityname', 'title'],
  outlineLevel: ['outlinelevel', 'level', 'indent', 'indentlevel'],
  wbs: ['wbs', 'wbscode', 'outlinenumber', 'code'],
  start: ['start', 'startdate', 'scheduledstart', 'plannedstart', 'earlystart'],
  finish: ['finish', 'finishdate', 'end', 'enddate', 'scheduledfinish', 'plannedfinish'],
  duration: ['duration', 'dur', 'days'],
  predecessors: ['predecessors', 'predecessor', 'depends', 'dependson'],
  percentComplete: ['complete', 'percentcomplete', 'progress', 'pctcomplete'],
  milestone: ['milestone', 'ismilestone'],
  notes: ['notes', 'note', 'comment', 'comments', 'description'],
};

function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Split CSV text into rows of fields (RFC 4180: quoted fields may contain the
 * delimiter, newlines, and `""` escapes). Hand-rolled because the repo carries
 * no CSV dependency and the grammar is small.
 */
export function splitCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  // Strip a UTF-8 BOM — Excel writes one and it would otherwise corrupt the
  // first header cell, silently losing the id/name column.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Pick the delimiter by counting candidates in the header line. Semicolon is
 * common in locales where the decimal separator is a comma, which is exactly
 * where the day-first date order also shows up.
 */
export function detectDelimiter(firstLine: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : ',';
}

/** Map header cells to canonical column keys; unmatched columns are ignored. */
function mapColumns(header: string[]): Record<string, number> {
  const byKey: Record<string, number> = {};
  header.forEach((cell, index) => {
    const normalized = normalizeHeader(cell);
    if (!normalized) return;
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (byKey[key] === undefined && aliases.includes(normalized)) {
        byKey[key] = index;
        return;
      }
    }
  });
  return byKey;
}

/**
 * `5 days`, `2 wks`, `8 hrs`, `0 days`, `1 mon`, or a bare number (days).
 * `edays` (elapsed days) are treated as days — the distinction is a calendar
 * concern this importer does not model, and is noted in the guide.
 *
 * An unrecognised unit (`2 yrs`, a typo like `3 dyas`) returns `undefined`
 * rather than silently falling back to days — `parseScheduleCsv` turns that
 * into an `unparsable-duration` warning. Guessing days for an unknown unit
 * would corrupt the duration exactly the way a wrong date-order guess would
 * corrupt a date, which is the one thing this importer is built to avoid.
 */
export function parseCsvDuration(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  if (!text) return undefined;
  const match = /^(-?\d+(?:[.,]\d+)?)\s*([a-z]*)$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return undefined;
  const unitSeconds = unitToSeconds(match[2]);
  if (unitSeconds === undefined) return undefined;
  const seconds = value * unitSeconds;
  // Only a genuine explicit 0 means milestone. A negative duration is a bad
  // input (a typo, a sign that slipped in), not a milestone — folding it
  // into PT0S here used to silently turn it into a valid-looking milestone
  // downstream; report it via the same unparsable-duration path instead.
  if (seconds < 0) return undefined;
  if (seconds === 0) return 'PT0S';
  if (seconds % SECONDS_PER_DAY === 0) return `P${seconds / SECONDS_PER_DAY}D`;
  if (seconds % SECONDS_PER_HOUR === 0) return `PT${seconds / SECONDS_PER_HOUR}H`;
  if (seconds % SECONDS_PER_MINUTE === 0) return `PT${seconds / SECONDS_PER_MINUTE}M`;
  return `PT${Math.round(seconds)}S`;
}

/** Derive outline depth from a WBS/outline number like `1.2.3` (depth 3). */
function depthFromWbs(wbs: string | undefined): number | undefined {
  if (!wbs) return undefined;
  const trimmed = wbs.trim();
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return undefined;
  return trimmed.split('.').length;
}

function truthy(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'yes' || v === 'true' || v === 'y';
}

/**
 * Parse a percent-complete cell, tolerating a `%` suffix and a comma decimal
 * separator. `splitCsvRows` already resolves the semicolon-delimited
 * European export shape (see `detectDelimiter` above), where a comma is
 * unambiguously a decimal point rather than a field separator — so
 * `"12,5"` (12.5%) is a locale variant to read, not garbage to reject. Only
 * a lone comma is treated this way; a value already using `.` is left
 * alone rather than mangled.
 */
function parsePercentCell(raw: string): number {
  const stripped = raw.replace('%', '').trim();
  const normalized = !stripped.includes('.') && /^-?\d+,\d+$/.test(stripped)
    ? stripped.replace(',', '.')
    : stripped;
  return Number(normalized);
}

export function parseScheduleCsv(text: string): ParsedScheduleSource {
  const warnings: ScheduleImportWarning[] = [];
  const firstLine = text.split('\n', 1)[0] ?? '';
  // Blank rows are dropped before parsing, but warnings cite the row's
  // ORIGINAL position in the file (`line`) — keep each row paired with its
  // 1-based source line number through the filter, rather than deriving
  // `line` afterwards from the filtered array's index. A file with blank
  // rows would otherwise report a line number that no longer matches
  // anything the user can find by opening the file.
  const allRows = splitCsvRows(text, detectDelimiter(firstLine));
  const rowsRaw = allRows
    .map((row, i) => ({ row, sourceLine: i + 1 }))
    .filter(r => r.row.some(c => c.trim() !== ''));
  if (rowsRaw.length < 2) {
    throw new Error('The CSV has no data rows — expected a header row followed by tasks.');
  }

  const columns = mapColumns(rowsRaw[0]!.row);
  if (columns.name === undefined) {
    throw new Error(
      'Could not find a task-name column. Expected a header cell such as "Name", "Task Name" or "Activity".',
    );
  }

  const body = rowsRaw.slice(1);
  const cellAt = (row: string[], key: string): string | undefined => {
    const index = columns[key];
    if (index === undefined) return undefined;
    const value = row[index];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };

  // Resolve day/month order once across every date cell in the file.
  const dateCells: string[] = [];
  for (const { row } of body) {
    const s = cellAt(row, 'start');
    const f = cellAt(row, 'finish');
    if (s) dateCells.push(s);
    if (f) dateCells.push(f);
  }
  const { order, ambiguous, conflict } = detectDateOrder(dateCells);
  if (ambiguous) {
    warnings.push({
      code: 'ambiguous-date-format',
      message:
        'Dates are ambiguous (no value above 12 in either position) — read as day/month/year. ' +
        'Re-export with ISO dates (YYYY-MM-DD) or as Microsoft Project XML if that is wrong.',
    });
  }
  if (conflict) {
    warnings.push({
      code: 'mixed-date-format',
      message:
        `Mixed date formats in this file — "${conflict.dayFirstExample}" reads as day-first, but ` +
        `"${conflict.monthFirstExample}" reads as month-first. Ambiguous dates were left unread rather ` +
        'than guessed from a majority; re-export with ISO dates (YYYY-MM-DD) or as Microsoft Project XML.',
    });
  }
  // Once evidence conflicts, an ambiguous cell (both components <= 12) can no
  // longer be trusted to follow the majority order — refuse it rather than
  // guess. Unambiguous cells are unaffected: parseCsvDate resolves them from
  // their own value regardless of this flag.
  const refuseAmbiguousDates = conflict !== undefined;

  const rows: ImportedTaskRow[] = [];
  const seenIds = new Set<string>();

  body.forEach(({ row, sourceLine: line }, index) => {
    const name = cellAt(row, 'name');
    if (!name) {
      warnings.push({ code: 'missing-name', message: 'Row has no task name — skipped.', line });
      return;
    }

    const explicitId = cellAt(row, 'id');
    // When the file has no id column at all, positional "1", "2", ... *are*
    // the ids -- this mirrors MS Project's own default ID column, and
    // predecessors like "3FS+2 days" reference rows by that position, so a
    // bare integer has to be preserved for files shaped that way.
    //
    // But when there IS an id column and this row's cell is simply blank --
    // a hand-edited sheet where only some rows got an id filled in -- a bare
    // positional fallback would share a namespace with the explicit ids
    // elsewhere in the file. Row 1 left blank would get sourceId "1", which
    // collides with another row's *explicit* id "1" and gets reported (and
    // dropped) as a spurious duplicate -- the row silently vanishes instead.
    // Namespace the fallback with the CSV line number so it can never equal
    // an explicit id. A predecessor token can then only ever resolve to an
    // explicit id in that case, never to a synthesized one, so nothing can
    // mis-bind to the wrong task: a reference to a blank-id row simply can't
    // match anything and surfaces via the existing "not in the file"
    // dependency warning, same as any other unresolved predecessor.
    const sourceId = explicitId ?? (columns.id === undefined ? String(index + 1) : `row-${line}-no-id`);
    if (seenIds.has(sourceId)) {
      warnings.push({ code: 'duplicate-source-id', message: `Duplicate task id "${sourceId}" — skipped.`, line });
      return;
    }
    seenIds.add(sourceId);

    const wbs = cellAt(row, 'wbs');
    const levelCell = cellAt(row, 'outlineLevel');
    const parsedLevel = levelCell === undefined ? undefined : Number(levelCell);
    const outlineLevel =
      parsedLevel !== undefined && Number.isFinite(parsedLevel) && parsedLevel > 0
        ? Math.floor(parsedLevel)
        : (depthFromWbs(wbs) ?? 1);

    const startCell = cellAt(row, 'start');
    const finishCell = cellAt(row, 'finish');
    const start = startCell ? parseCsvDate(startCell, order, refuseAmbiguousDates) : undefined;
    const finish = finishCell ? parseCsvDate(finishCell, order, refuseAmbiguousDates) : undefined;
    if (startCell && !start) {
      warnings.push({ code: 'unparsable-date', message: `Could not read start date "${startCell}".`, line });
    }
    if (finishCell && !finish) {
      warnings.push({ code: 'unparsable-date', message: `Could not read finish date "${finishCell}".`, line });
    }

    const durationCell = cellAt(row, 'duration');
    const durationIso = durationCell ? parseCsvDuration(durationCell) : undefined;
    if (durationCell && !durationIso) {
      warnings.push({ code: 'unparsable-duration', message: `Could not read duration "${durationCell}".`, line });
    }

    const percentCell = cellAt(row, 'percentComplete');
    const percentValue = percentCell === undefined ? undefined : parsePercentCell(percentCell);

    rows.push({
      sourceId,
      name,
      outlineLevel,
      start,
      finish,
      durationIso,
      isMilestone: truthy(cellAt(row, 'milestone')) || durationIso === 'PT0S',
      isSummary: false,
      percentComplete:
        percentValue !== undefined && Number.isFinite(percentValue)
          ? Math.max(0, Math.min(100, percentValue))
          : undefined,
      wbs,
      notes: cellAt(row, 'notes'),
      dependencies: parseCsvPredecessors(cellAt(row, 'predecessors') ?? '', warnings, line),
    });
  });

  if (rows.length === 0) throw new Error('No task rows could be read from the CSV.');
  return { rows, warnings };
}
