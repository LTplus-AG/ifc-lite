/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A table block on the preview sheet (#5142): the same flattened rows the
 * PDF prints — head, group rows, the "… n more" line, the totals row — as
 * an HTML table, with the block's state (running, no model, an error, no
 * rows) in its place when there is nothing to print. The preview does not
 * paginate (text never did either); the composer's tests cover chunking.
 */
import { useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { localeCount } from '@/i18n/intlFormat';
import { flattenExportModel, type TableRowRole, type TableState } from '@/lib/document/resolve-table';
import { TABLE_ROWS_DEFAULT, type TableBlock } from '@/lib/document/types';
import { DOCUMENT_PREVIEW_MUTED_TEXT_CLASS } from './preview-theme';

const ROW_CLASS: Record<TableRowRole, string> = {
  row: '',
  group: 'bg-neutral-100 font-semibold',
  total: 'bg-neutral-100 font-semibold',
  more: 'italic text-neutral-500',
};

export interface TablePreviewProps {
  block: TableBlock;
  state: TableState | undefined;
}

export function TablePreview({ block, state }: TablePreviewProps) {
  const { t, locale } = useTranslation();
  const title = block.title?.trim() || block.source.list.name;
  const table = useMemo(() => (state?.status === 'ok'
    ? flattenExportModel(state.model, block.maxRows ?? TABLE_ROWS_DEFAULT, {
      more: (n) => t('document.table.moreRows', localeCount(locale, n)),
      total: (count) => t('document.table.total', { count: count.toLocaleString(locale) }),
    })
    : null), [state, block.maxRows, t, locale]);

  const message = !state || state.status === 'resolving' ? t('document.table.resolving')
    : state.status === 'no-model' ? t('document.table.noModel')
      : state.status === 'error' ? state.message
        : table && table.totalRows === 0 ? t('document.table.noRows')
          : null;

  return (
    <div data-block-table>
      <div className="truncate text-sm font-semibold" title={title}>{title}</div>
      {message !== null || !table ? (
        <div className={`rounded border border-dashed border-neutral-300 px-3 py-2 text-xs ${state?.status === 'error' ? 'text-amber-900' : 'text-neutral-500'}`} data-table-message>{message}</div>
      ) : (
        <table className="w-full border-collapse text-[8px] leading-tight" data-table-rows={table.rows.length}>
          <thead>
            <tr>
              {table.columns.map((c, i) => <th key={i} className={`border border-neutral-200 bg-slate-700 px-1 py-0.5 font-semibold text-white ${c.numeric ? 'text-right' : 'text-left'}`}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, ri) => (
              <tr key={ri} className={ROW_CLASS[r.role]} data-role={r.role}>
                {r.cells.map((cell, ci) => <td key={ci} className={`max-w-0 truncate border border-neutral-200 px-1 py-0.5 ${table.columns[ci]?.numeric ? 'text-right tabular-nums' : 'text-left'}`} title={cell}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {block.caption && <div className={`mt-1 text-[10px] ${DOCUMENT_PREVIEW_MUTED_TEXT_CLASS}`}>{block.caption}</div>}
    </div>
  );
}
