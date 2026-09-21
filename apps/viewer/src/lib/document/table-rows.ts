/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rows for a `table` document block (#5138), resolved from the store's
 * validation report at render/print time — never a snapshot copied into the
 * document: a document opened after the model was re-validated shows THAT
 * run's rows, and one whose report was cleared or never run says so instead
 * of printing a stale table. Shared by `DocumentPreview.tsx` and
 * `generate-document-pdf.ts`, so the page prints exactly what it shows.
 */
import type { EntityResult, SetResult, SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import type { TableBlock, TableColumnId } from './types.js';

/** Above this many rows a table truncates; a document is a printed page, not a database dump. */
export const TABLE_ROW_CAP = 2000;

/** Why `rows` is empty and the caller should show a placeholder instead of an empty table. */
export type TableRowsPlaceholderReason = 'no-report' | 'rule-not-found';

export interface ResolvedTableRows {
  columns: TableColumnId[];
  /** One array per row, values in `columns` order — never translated; plain data. */
  rows: string[][];
  /** `true` when more rows matched than `TABLE_ROW_CAP`; the caller prints a truncation caption. */
  truncated: boolean;
  placeholderReason: TableRowsPlaceholderReason | null;
}

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
 * Resolve `block`'s rows against `report`. Never throws: a null/stale report
 * or a `ruleId` no longer present in it returns an empty, explained
 * placeholder instead — the row cap in a document must never crash a print.
 */
export function resolveTableRows(block: TableBlock, report: ValidationReport | null, modelName: (modelId: string) => string): ResolvedTableRows {
  const { columns, source } = block;
  if (!report) return { columns, rows: [], truncated: false, placeholderReason: 'no-report' };

  const specs = source.ruleId ? report.specificationResults.filter((s) => s.specification.id === source.ruleId) : report.specificationResults;
  if (source.ruleId && specs.length === 0) return { columns, rows: [], truncated: false, placeholderReason: 'rule-not-found' };

  const rows: string[][] = [];
  if (source.rows === 'sets') {
    for (const spec of specs) for (const set of spec.setResults ?? []) rows.push(columns.map((c) => setColumnValue(c, spec, set)));
  } else {
    for (const spec of specs) {
      for (const entity of spec.entityResults) {
        if (source.rows === 'failed' && entity.passed) continue;
        if (source.rows === 'passed' && !entity.passed) continue;
        rows.push(columns.map((c) => entityColumnValue(c, spec, entity, modelName(entity.modelId))));
      }
    }
  }
  return { columns, rows: rows.slice(0, TABLE_ROW_CAP), truncated: rows.length > TABLE_ROW_CAP, placeholderReason: null };
}
