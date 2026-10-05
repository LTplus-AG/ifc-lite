/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Table rows + mapping → reviewed `model.changes` (P15). Every change carries
 * the value the effective model holds at conversion time as its expected
 * value, so an edit made after the table was read shows as a conflict in
 * review and is never overwritten. Empty cells change nothing; cells that
 * already hold the value are counted as unchanged and left out.
 */

import type { CsvRow } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import { toConversion, type ChangeConversion, type ConversionIssue } from './change-conversion';
import type { ModelChange } from './model-change';
import { currentValue, modelReader, sameValue, UNSUPPORTED_VALUE, type ModelReader } from './model-change-values';
import { existingQuantity, propertyCell, quantityCell, type CellOutcome } from './table-cells';
import { resolveTableIdentity } from './table-identity';
import { targetField, validateTableMapping, type TableColumnTarget, type TableMapping } from './table-mapping';

export interface TableConversionInput {
  modelId: string;
  rows: readonly CsvRow[];
  mapping: TableMapping;
  /** Only the first N rows (sample preview); all rows when absent. */
  limit?: number;
}

/** The `model.changes` text limit. */
const CELL_LIMIT = 2000;

export type TableConversion = ChangeConversion & { rows: number };

function cellChange(reader: ModelReader, expressId: number, globalId: string, modelId: string, target: TableColumnTarget,
  cell: string): { change: ModelChange } | { outcome: Extract<CellOutcome, { ok: false }> | { ok: false; kind: 'missing-quantity'; detail: string } } {
  const at = { globalId, modelId };
  if (target.target === 'attribute') {
    return { change: { op: 'attribute.set', target: at, name: target.name, expected: '', value: cell } };
  }
  if (target.target === 'quantity') {
    const quantity = existingQuantity(reader, expressId, target.qset, target.name);
    if (!quantity) return { outcome: { ok: false, kind: 'missing-quantity', detail: `${target.qset}.${target.name}` } };
    const typed = quantityCell(reader, expressId, quantity, cell, target.unit);
    if (!typed.ok) return { outcome: typed };
    return { change: { op: 'quantity.set', target: at, qset: target.qset, name: target.name, expected: quantity.value, value: typed.value as number } };
  }
  const typed = propertyCell(reader, expressId, target.pset, target.name, cell, target.valueType, target.unit);
  if (!typed.ok) return { outcome: typed };
  return { change: { op: 'property.set', target: at, pset: target.pset, name: target.name, expected: null, value: typed.value,
    ...(typed.dataType ? { dataType: typed.dataType } : {}) } };
}

export function tableToModelChanges(state: ViewerState, input: TableConversionInput): TableConversion {
  const { mapping, modelId } = input;
  const rows = input.limit === undefined ? input.rows : input.rows.slice(0, input.limit);
  const empty = (refusal: TableConversion['refusal'], issues: ConversionIssue[] = []): TableConversion =>
    ({ ...toConversion(mapping.title, mapping.rationale, [], issues, 0), rows: rows.length, refusal });
  // Structural problems only (a column mapped twice, two columns writing one value, an empty name);
  // a column the rows lack just reads as empty cells.
  const declared = [mapping.identity.column, ...mapping.columns.map(target => target.column)];
  if (validateTableMapping(mapping, declared).length > 0) return empty('invalid-mapping');
  const reader = modelReader(state, modelId);
  if (!reader) return empty('model-unavailable');
  const identity = resolveTableIdentity(reader, rows, mapping.identity);
  if (!identity.ok) return empty('tag-scan-limit');

  const issues = [...identity.issues];
  const changes: ModelChange[] = [];
  let unchanged = 0;
  for (const [rowIndex, expressId] of identity.entities) {
    const row = rowIndex + 1;
    const globalId = reader.dataStore.entities.getGlobalId(expressId);
    const element = reader.dataStore.entities.getName(expressId) || globalId;
    if (!globalId) { issues.push({ kind: 'no-global-id', row, element: String(expressId) }); continue; }
    for (const target of mapping.columns) {
      const cell = rows[rowIndex][target.column] ?? '';
      if (cell.trim() === '') continue;
      if (cell.length > CELL_LIMIT) {
        issues.push({ kind: 'invalid-value', row, column: target.column, element, detail: `longer than ${CELL_LIMIT} characters` });
        continue;
      }
      const built = cellChange(reader, expressId, globalId, modelId, target, cell);
      if ('outcome' in built) {
        issues.push({ kind: built.outcome.kind, row, column: target.column, element, detail: built.outcome.detail });
        continue;
      }
      const current = currentValue(reader, expressId, built.change);
      if (current === UNSUPPORTED_VALUE) {
        issues.push({ kind: 'unsupported-value', row, column: target.column, element, detail: targetField(target) });
        continue;
      }
      const change = { ...built.change, expected: current } as ModelChange;
      if (change.op !== 'property.delete' && sameValue(current, change.value, change.op === 'attribute.set')) { unchanged++; continue; }
      changes.push(change);
    }
  }
  const sorted = issues.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { ...toConversion(mapping.title, mapping.rationale, changes, sorted, unchanged), rows: rows.length };
}
