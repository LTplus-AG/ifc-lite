/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Markdown (GFM table) rendering for `ifc-lite schedule --format md`.
 *
 * Same row/column shape as `renderScheduleCsv`/`renderScheduleCsvWithSubtotals`
 * (see `schedule-render.ts`): one header row, one `---` separator row (GFM
 * table syntax), then one row per entity, then — with `--subtotals` — a
 * subtotal row per contiguous group and a closing grand-total row, using the
 * exact same `subtotalCells` layout as CSV so a value/label lands in the same
 * column across every output format.
 *
 * A GFM table cell is delimited by `|` and terminated by a newline, so both
 * must be neutralised or the cell would fracture the row: a literal `|`
 * becomes `\|` and an embedded newline becomes `<br>` (GFM tables render
 * inline HTML in a cell, so this stays a single visual line without losing the
 * break). The backslash introduced by the `|` escape is itself escaped first
 * so a value already containing a backslash can't produce an unintended
 * escape sequence.
 */

import { columnValueToCsv } from './export.js';
import type { ScheduleColumn } from './schedule-columns.js';
import type { SubtotalPlan } from './schedule-aggregate.js';
import { subtotalCells } from './schedule-render.js';
import type { ScheduleRow } from './schedule-render.js';

/** Escape one cell's text for a GFM table: backslash, then `|`, then newline. */
function escapeMarkdownCell(value: unknown): string {
  const text = columnValueToCsv(value);
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

function headerAndSeparator(columns: ScheduleColumn[]): string[] {
  const header = `| ${columns.map(c => escapeMarkdownCell(c.header)).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  return [header, separator];
}

function rowLine(row: unknown[]): string {
  return `| ${row.map(escapeMarkdownCell).join(' | ')} |`;
}

/** Render the schedule as a GFM Markdown table. */
export function renderScheduleMarkdown(columns: ScheduleColumn[], rows: ScheduleRow[]): string {
  const lines = [...headerAndSeparator(columns), ...rows.map(rowLine)];
  return lines.join('\n');
}

/**
 * Render a schedule with `--subtotals` as a GFM Markdown table: grouped rows
 * followed by their subtotal row, then the grand total — the same layout
 * `renderScheduleCsvWithSubtotals` produces.
 */
export function renderScheduleMarkdownWithSubtotals(columns: ScheduleColumn[], plan: SubtotalPlan): string {
  const lines = headerAndSeparator(columns);
  if (plan.groups.length > 0) {
    for (const group of plan.groups) {
      for (const row of group.rows) lines.push(rowLine(row));
      lines.push(rowLine(subtotalCells(columns, group.subtotal)));
    }
  } else {
    for (const row of plan.rows) lines.push(rowLine(row));
  }
  lines.push(rowLine(subtotalCells(columns, plan.total)));
  return lines.join('\n');
}
