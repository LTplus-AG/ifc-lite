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
 *  - **Date order.** `05/01/2026` is genuinely ambiguous. Rather than pick a
 *    locale, the whole column is scanned: a component above 12 anywhere proves
 *    the order. Only when *no* row disambiguates does it fall back to
 *    day-first, and then it says so via an `ambiguous-date-format` warning —
 *    a silent wrong guess would shift every date in the schedule.
 *  - **Predecessor grammar.** MS Project's `12FS+3 days` form, including leads
 *    (`12SS-1 day`), bare ids, and `,`/`;` separated lists.
 */

import type { SequenceTypeEnum } from '@ifc-lite/parser';
import { detectDateOrder, parseCsvDate } from './csv-dates.js';
import type {
  ImportedDependency,
  ImportedTaskRow,
  ParsedScheduleSource,
  ScheduleImportWarning,
} from './types.js';

// Re-exported so existing imports of `csv.js` keep working unchanged after
// the date-order/parsing logic moved into ./csv-dates.js (AGENTS.md
// module-size split).
export { detectDateOrder, parseCsvDate } from './csv-dates.js';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

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
  if (seconds <= 0) return 'PT0S';
  if (seconds % SECONDS_PER_DAY === 0) return `P${seconds / SECONDS_PER_DAY}D`;
  if (seconds % SECONDS_PER_HOUR === 0) return `PT${seconds / SECONDS_PER_HOUR}H`;
  if (seconds % SECONDS_PER_MINUTE === 0) return `PT${seconds / SECONDS_PER_MINUTE}M`;
  return `PT${Math.round(seconds)}S`;
}

// Exact-match unit sets rather than `startsWith` prefixes: a `startsWith('d')`
// check would happily accept a typo like "3 dyas" as days, which is exactly
// the silent-guess failure this rework exists to close. `ed`/`eday`/`edays`
// (elapsed days) are folded into the same bucket as plain days per the
// duration doc comment above.
const DAY_UNITS = new Set(['d', 'day', 'days', 'ed', 'eday', 'edays']);
const WEEK_UNITS = new Set(['w', 'wk', 'wks', 'week', 'weeks']);
const HOUR_UNITS = new Set(['h', 'hr', 'hrs', 'hour', 'hours']);
const MINUTE_UNITS = new Set(['m', 'min', 'mins', 'minute', 'minutes']);
const MONTH_UNITS = new Set(['mo', 'mon', 'month', 'months']);

/**
 * Seconds-per-unit for a duration/lag suffix, or `undefined` when the unit
 * isn't one of ours. Exact membership rather than a prefix match is what
 * makes this correct twice over: `startsWith('m')` would have swallowed
 * "mon" into minutes, and — the bug this replaced — `startsWith('d')`
 * would have accepted the typo "dyas" as days instead of reporting it.
 *
 * The sets are disjoint, so the order of these checks carries no meaning;
 * it is grouped largest-unit-first only for readability.
 */
function unitToSeconds(unit: string): number | undefined {
  if (unit === '' || DAY_UNITS.has(unit)) return SECONDS_PER_DAY;
  if (MONTH_UNITS.has(unit)) return 30 * SECONDS_PER_DAY;
  if (WEEK_UNITS.has(unit)) return 7 * SECONDS_PER_DAY;
  if (HOUR_UNITS.has(unit)) return SECONDS_PER_HOUR;
  if (MINUTE_UNITS.has(unit)) return SECONDS_PER_MINUTE;
  return undefined;
}

const LINK_CODES: Record<string, SequenceTypeEnum> = {
  FS: 'FINISH_START',
  SS: 'START_START',
  FF: 'FINISH_FINISH',
  SF: 'START_FINISH',
};

/** `12FS+3 days, 14SS-1 day, 7` → dependency edges. */
export function parseCsvPredecessors(
  raw: string,
  warnings: ScheduleImportWarning[],
  line: number,
): ImportedDependency[] {
  const text = raw.trim();
  if (!text) return [];
  const deps: ImportedDependency[] = [];
  for (const token of text.split(/[,;]/)) {
    const entry = token.trim();
    if (!entry) continue;
    const match = /^([A-Za-z0-9_-]+?)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+(?:[.,]\d+)?\s*[a-zA-Z]*)?$/.exec(entry);
    if (!match) {
      warnings.push({ code: 'unparsable-predecessor', message: `Could not read predecessor "${entry}".`, line });
      continue;
    }
    const [, predecessorSourceId, code, lagRaw] = match;
    let lagSeconds: number | undefined;
    if (lagRaw) {
      const lagMatch = /^([+-])\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)$/.exec(lagRaw.replace(/\s+/g, ' ').trim());
      if (lagMatch) {
        const unitSeconds = unitToSeconds(lagMatch[3].toLowerCase());
        if (unitSeconds === undefined) {
          // Unknown lag unit (typo, or a unit this importer doesn't model,
          // e.g. "yrs"): the link itself is still real information — drop
          // only the lag rather than the whole dependency — but say so
          // rather than silently treating it as days.
          warnings.push({
            code: 'unparsable-predecessor',
            message: `Predecessor "${entry}": unrecognised lag unit "${lagMatch[3]}" — link kept, lag dropped.`,
            line,
          });
        } else {
          const magnitude = Number(lagMatch[2].replace(',', '.')) * unitSeconds;
          lagSeconds = lagMatch[1] === '-' ? -magnitude : magnitude;
        }
      }
    }
    deps.push({
      predecessorSourceId,
      type: code ? LINK_CODES[code.toUpperCase()] : 'FINISH_START',
      lagSeconds: lagSeconds === 0 ? undefined : lagSeconds,
    });
  }
  return deps;
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

export function parseScheduleCsv(text: string): ParsedScheduleSource {
  const warnings: ScheduleImportWarning[] = [];
  const firstLine = text.split('\n', 1)[0] ?? '';
  const rowsRaw = splitCsvRows(text, detectDelimiter(firstLine)).filter(r => r.some(c => c.trim() !== ''));
  if (rowsRaw.length < 2) {
    throw new Error('The CSV has no data rows — expected a header row followed by tasks.');
  }

  const columns = mapColumns(rowsRaw[0]);
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
  for (const row of body) {
    const s = cellAt(row, 'start');
    const f = cellAt(row, 'finish');
    if (s) dateCells.push(s);
    if (f) dateCells.push(f);
  }
  const { order, ambiguous } = detectDateOrder(dateCells);
  if (ambiguous) {
    warnings.push({
      code: 'ambiguous-date-format',
      message:
        'Dates are ambiguous (no value above 12 in either position) — read as day/month/year. ' +
        'Re-export with ISO dates (YYYY-MM-DD) or as Microsoft Project XML if that is wrong.',
    });
  }

  const rows: ImportedTaskRow[] = [];
  const seenIds = new Set<string>();

  body.forEach((row, index) => {
    const line = index + 2; // 1-based, +1 for the header
    const name = cellAt(row, 'name');
    if (!name) {
      warnings.push({ code: 'missing-name', message: 'Row has no task name — skipped.', line });
      return;
    }

    const explicitId = cellAt(row, 'id');
    const sourceId = explicitId ?? String(index + 1);
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
    const start = startCell ? parseCsvDate(startCell, order) : undefined;
    const finish = finishCell ? parseCsvDate(finishCell, order) : undefined;
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
    const percentValue = percentCell === undefined ? undefined : Number(percentCell.replace('%', '').trim());

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
