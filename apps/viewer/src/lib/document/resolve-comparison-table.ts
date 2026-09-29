/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Saved comparison → existing raw table/PDF projection (#6506). No live model lookup. */
import type { SavedComparison } from '../compare/savedComparisons';
import type { TableState } from './resolve-table';

export function resolveComparisonTableState(saved: SavedComparison): TableState {
  const optional = ['key', 'match', 'matchedGlobalId'] as const;
  const fields = ['globalId', 'name', 'ifcType', 'state', 'change', 'movedDistance', 'model',
    ...optional.filter((key) => saved.report.rows.some((r) => r[key]))] as const;
  const labels: Record<typeof fields[number], string> = {
    globalId: 'GlobalId', name: 'Name', ifcType: 'IfcType', state: 'State', change: 'Change',
    movedDistance: 'Moved distance (m)', model: 'Model', key: 'Authored key', match: 'Content match', matchedGlobalId: 'Matched GlobalId',
  };
  return { status: 'ok', kind: 'comparison', model: {
    columns: fields.map((key) => ({ label: labels[key], numeric: key === 'movedDistance' })),
    rows: saved.report.rows.map((r) => ({ role: 'row', cells: fields.map((key) => String(r[key] ?? '').replace(/\s*[\r\n]+\s*/g, ' ')) })),
    totalRows: saved.report.rows.length,
  } };
}
