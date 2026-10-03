/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveEnglish } from '@/i18n/registry';
import { blockTitle } from './block-title.js';
import type { TableBlock } from './types.js';
import { tableMessageKind, type TableLabels, type TableMessageKind, type TableState, type TableColumnOut } from './resolve-table.js';
import { capturedDocumentNumber, type DocumentLabelFormatter } from './document-labels.js';
import { TABLE_COLUMN_LABEL_KEY } from './table-column-labels.js';

const columnKeys = new Map(Object.entries(TABLE_COLUMN_LABEL_KEY));

/** Translate only canonical validation columns; authored list labels stay authored. */
export function documentTableColumns(columns: TableColumnOut[], t?: DocumentLabelFormatter): TableColumnOut[] {
  return t ? columns.map(column => {
    const key = column.id ? columnKeys.get(column.id) : undefined;
    return key ? { ...column, label: t(key) } : column;
  }) : columns;
}


/** The English the PDF prints for a table block's rows, like every other string this module prints. */
export const TABLE_PDF_LABELS: TableLabels = {
  more: (n) => `… ${n.toLocaleString()} more row${n === 1 ? '' : 's'}`,
  total: (count) => `Total (${count.toLocaleString()})`,
};

export function documentTableLabels(t?: DocumentLabelFormatter): TableLabels {
  return t ? {
    more: count => t('document.table.moreRows', { count, countDisplay: capturedDocumentNumber(t, count) ?? count.toLocaleString() }),
    total: count => t('document.table.total', { count: capturedDocumentNumber(t, count) ?? count.toLocaleString() }),
  } : TABLE_PDF_LABELS;
}

const TABLE_MESSAGES: Record<Exclude<TableMessageKind, 'error' | 'no-rows'>, string> = {
  resolving: 'Table not ready: the list is still running.',
  'no-model': 'Load a model to fill this table.',
  'no-report': resolveEnglish('document.table.noReport'),
  'rule-not-found': 'The rule this table refers to is not in the current validation report.',
};

/** Generated table labels must remain visible even when a captured catalogue
 * explicitly contains an empty/whitespace translation (#6610, review4172078887). */
function tableLabel(key: string, t?: DocumentLabelFormatter, fallback = resolveEnglish(key)): string {
  return t?.(key).trim() || fallback;
}

const messageKeys: Record<Exclude<TableMessageKind, 'error' | 'no-rows'>, string> = {
  resolving: 'document.table.resolving', 'no-model': 'document.table.noModel',
  'no-report': 'document.table.noReport', 'rule-not-found': 'document.table.ruleNotFound',
};

/** What a table block prints in place of its rows, by state; `null` when it has rows to print. */
export function tableMessage(state: TableState | undefined, t?: DocumentLabelFormatter): string | null {
  const kind = tableMessageKind(state);
  if (kind === null) return null;
  if (kind === 'error') return (state?.status === 'error' && state.message.trim())
    || tableLabel('document.table.error', t);
  if (kind === 'no-rows') return tableLabel(state?.status === 'ok' && state.kind === 'comparison'
    ? 'document.table.comparisonNoRows' : state?.status === 'ok' && state.kind === 'validation'
      ? 'document.table.validationNoRows' : 'document.table.noRows', t);
  return t ? tableLabel(messageKeys[kind], t) : TABLE_MESSAGES[kind];
}

/** The title a table block prints: its own, the list's name, or "Validation results". */
export const tableTitle = (block: TableBlock, t?: DocumentLabelFormatter): string => blockTitle(block, (block.source.kind === 'list' ? block.source.list.name : block.source.kind === 'comparison' ? block.source.comparison.name : tableLabel('document.block.tableSourceValidation', t)), false);
