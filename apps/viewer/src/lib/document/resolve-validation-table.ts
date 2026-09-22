/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A validation-results table block's rows (#5138), resolved from the
 * store's `ValidationReport` into the same `RawTableModel` shape
 * `resolve-table.ts` flattens for any non-list source — so `compose-table.ts`,
 * `TablePreview.tsx` and `generate-document-pdf.ts` draw a validation table
 * with no changes of their own: they already only know `TableColumnOut`/
 * `TableRowOut`. Pure: no store, no i18n, never throws — a null report or a
 * `ruleId` no longer in it returns a `TableState` placeholder instead.
 */
import type { EntityResult, SetResult, SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import type { TableRowOut } from './resolve-table.js';
import type { TableState } from './resolve-table.js';
import type { TableColumnId, ValidationTableSource } from './types.js';

/** Plain-English column headers (#5138): printed as-is, the same way a list's own (user-authored) column labels are never routed through i18n. */
export const VALIDATION_COLUMN_LABEL: Record<TableColumnId, string> = {
  rule: 'Rule', result: 'Result', entityType: 'Entity type', name: 'Name', globalId: 'GlobalId',
  model: 'Model', actual: 'Actual', expected: 'Expected', reason: 'Reason', set: 'Set', members: 'Members',
};

const specName = (spec: SpecificationResult): string => spec.specification.name || spec.specification.id;

function entityColumnValue(column: TableColumnId, spec: SpecificationResult, entity: EntityResult, modelName: string): string {
  // The first failing requirement carries the actual/expected/reason a reviewer needs; a fully
  // passing entity (rows: 'all' | 'passed') has none, so those columns are blank, not an error.
  const failed = entity.requirementResults.find((r) => r.status === 'fail');
  switch (column) {
    case 'rule': return specName(spec);
    case 'result': return entity.passed ? 'pass' : 'fail';
    case 'entityType': return entity.entityType;
    case 'name': return entity.entityName ?? '';
    case 'globalId': return entity.globalId ?? '';
    case 'model': return modelName;
    case 'actual': return failed?.actualValue ?? '';
    case 'expected': return failed?.expectedValue ?? '';
    case 'reason': return failed?.failureReason ?? '';
    case 'set':
    case 'members':
      return '';
  }
}

function setColumnValue(column: TableColumnId, spec: SpecificationResult, set: SetResult): string {
  switch (column) {
    case 'rule': return specName(spec);
    case 'result': return set.passed ? 'pass' : 'fail';
    case 'set': return set.groupKey ? `${set.label} (${set.groupKey})` : set.label;
    case 'members': return String(set.members.length);
    case 'actual': return set.actual;
    case 'expected': return set.expected;
    case 'reason': return set.failureReason ?? '';
    case 'entityType':
    case 'name':
    case 'globalId':
    case 'model':
      return '';
  }
}

/**
 * Resolve `source` against `report` into the `TableState` a document's table
 * block renders. Never throws: a null/stale report, or a `ruleId` no longer
 * present in it, resolves to its own placeholder state instead of a crash —
 * the same "print a message instead of rows" mechanism a list uses for
 * `'no-model'` / `'error'`.
 */
export function resolveValidationTableState(source: ValidationTableSource, report: ValidationReport | null, modelName: (modelId: string) => string): TableState {
  if (!report) return { status: 'no-report' };

  const specs = source.ruleId ? report.specificationResults.filter((s) => s.specification.id === source.ruleId) : report.specificationResults;
  if (source.ruleId && specs.length === 0) return { status: 'rule-not-found' };

  // `id` carries the column through to the preview/editor for translation (#5138 review); `label`
  // is the plain-English fallback the PDF prints and the one used if a caller never translates.
  const columns = source.columns.map((c) => ({ id: c, label: VALIDATION_COLUMN_LABEL[c], numeric: c === 'members' }));
  const rows: TableRowOut[] = [];
  if (source.rows === 'sets') {
    for (const spec of specs) for (const set of spec.setResults ?? []) rows.push({ cells: source.columns.map((c) => setColumnValue(c, spec, set)), role: 'row' });
  } else {
    for (const spec of specs) {
      for (const entity of spec.entityResults) {
        if (source.rows === 'failed' && entity.passed) continue;
        if (source.rows === 'passed' && !entity.passed) continue;
        rows.push({ cells: source.columns.map((c) => entityColumnValue(c, spec, entity, modelName(entity.modelId))), role: 'row' });
      }
    }
  }
  return { status: 'ok', kind: 'validation', model: { columns, rows, totalRows: rows.length } };
}
