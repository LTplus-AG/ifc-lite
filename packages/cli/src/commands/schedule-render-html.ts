/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HTML rendering for `ifc-lite schedule --format html`.
 *
 * Emits a complete, standalone HTML document (`<!doctype html>` through
 * `</html>`) with one `<table>`: a `<thead>` header row and a `<tbody>` data
 * row per entity, then — with `--subtotals` — a subtotal `<tr>` per contiguous
 * group and a closing grand-total `<tr>`, using the exact same `subtotalCells`
 * layout as CSV/Markdown so a value/label lands in the same column across
 * every output format. A standalone document (not a bare `<table>` fragment)
 * so `ifc-lite schedule ... --format html > schedule.html` opens directly in a
 * browser.
 *
 * Cell text is untrusted model data (IFC attribute/property/quantity values
 * authored by whoever produced the model) landing in an HTML document, so
 * every cell — headers included — is escaped: `&` first (so escaping the
 * other characters doesn't get re-escaped), then `<`, `>`, `"`, `'`. Subtotal
 * rows carry a `class` for CSS hooks, not to change escaping.
 */

import { columnValueToCsv } from './export.js';
import type { ScheduleColumn } from './schedule-columns.js';
import type { SubtotalPlan, SubtotalRowData } from './schedule-aggregate.js';
import { subtotalCells } from './schedule-render.js';
import type { ScheduleRow } from './schedule-render.js';

/** Escape one cell's text for HTML text content (and safe inside a quoted attribute). */
function escapeHtml(value: unknown): string {
  const text = columnValueToCsv(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tr(cells: unknown[], cssClass?: string): string {
  const attr = cssClass ? ` class="${cssClass}"` : '';
  return `    <tr${attr}>${cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
}

function documentShell(columns: ScheduleColumn[], bodyRows: string[]): string {
  const headCells = columns.map(c => `<th>${escapeHtml(c.header)}</th>`).join('');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Schedule</title>',
    '<style>',
    'table { border-collapse: collapse; font-family: sans-serif; font-size: 14px; }',
    'th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }',
    'th { background: #f0f0f0; }',
    'tr.subtotal td, tr.total td { font-weight: bold; background: #fafafa; }',
    '</style>',
    '</head>',
    '<body>',
    '  <table>',
    `    <thead><tr>${headCells}</tr></thead>`,
    '    <tbody>',
    ...bodyRows,
    '    </tbody>',
    '  </table>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Render the schedule as a standalone HTML document containing one `<table>`. */
export function renderScheduleHtml(columns: ScheduleColumn[], rows: ScheduleRow[]): string {
  return documentShell(columns, rows.map(row => tr(row)));
}

/**
 * Render a schedule with `--subtotals` as a standalone HTML document: grouped
 * rows followed by their subtotal `<tr class="subtotal">`, then the grand
 * total `<tr class="total">` — the same layout `renderScheduleCsvWithSubtotals`
 * produces.
 */
export function renderScheduleHtmlWithSubtotals(columns: ScheduleColumn[], plan: SubtotalPlan): string {
  const bodyRows: string[] = [];
  const subtotalClass = (data: SubtotalRowData) => (data.kind === 'total' ? 'total' : 'subtotal');
  if (plan.groups.length > 0) {
    for (const group of plan.groups) {
      for (const row of group.rows) bodyRows.push(tr(row));
      bodyRows.push(tr(subtotalCells(columns, group.subtotal), subtotalClass(group.subtotal)));
    }
  } else {
    for (const row of plan.rows) bodyRows.push(tr(row));
  }
  bodyRows.push(tr(subtotalCells(columns, plan.total), subtotalClass(plan.total)));
  return documentShell(columns, bodyRows);
}
