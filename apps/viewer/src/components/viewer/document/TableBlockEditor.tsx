/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Editor for a validation-results table block (#5138): rows mode, an
 * optional rule filter (read from the live report's specifications so the
 * picker only ever offers rules that actually ran), which columns print,
 * and title/caption — split out of `BlockEditor.tsx` to keep that file
 * under its module-size budget.
 */
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { DEFAULT_TABLE_COLUMNS } from '@/lib/document/presets';
import { TABLE_COLUMN_IDS, type TableBlock, type TableColumnId, type TableRowsMode } from '@/lib/document/types';
import { TABLE_COLUMN_LABEL_KEY } from './table-column-labels';

const field = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs';

export function TableBlockEditor({ block, onChange }: { block: TableBlock; onChange: (block: TableBlock) => void }) {
  const { t } = useTranslation();
  const report = useViewerStore((s) => s.idsValidationReport);
  const rules = report?.specificationResults.map((s) => s.specification) ?? [];

  // A rows-mode switch resets to that mode's default columns ONLY when the
  // author never customized them yet, so flipping between "failed" and "all"
  // does not silently discard a column selection already tuned by hand.
  const setRows = (rows: TableRowsMode): void => {
    const stillDefault = JSON.stringify([...block.columns].sort()) === JSON.stringify([...DEFAULT_TABLE_COLUMNS[block.source.rows]].sort());
    onChange({ ...block, source: { ...block.source, rows }, columns: stillDefault ? DEFAULT_TABLE_COLUMNS[rows] : block.columns });
  };
  const toggleColumn = (column: TableColumnId): void => {
    const has = block.columns.includes(column);
    const columns = has ? block.columns.filter((c) => c !== column) : [...block.columns, column];
    if (columns.length > 0) onChange({ ...block, columns });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.tableRowsLabel')}
          <select className={field} value={block.source.rows} onChange={(e) => setRows(e.target.value as TableRowsMode)} aria-label={t('document.block.tableRowsAriaLabel')}>
            <option value="failed">{t('document.block.tableRowsFailed')}</option>
            <option value="passed">{t('document.block.tableRowsPassed')}</option>
            <option value="all">{t('document.block.tableRowsAll')}</option>
            <option value="sets">{t('document.block.tableRowsSets')}</option>
          </select>
        </label>
        <label className="inline-flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">{t('document.block.tableRuleLabel')}
          <select className={`${field} min-w-0 flex-1`} value={block.source.ruleId ?? ''} onChange={(e) => onChange({ ...block, source: { ...block.source, ruleId: e.target.value || undefined } })} aria-label={t('document.block.tableRuleAriaLabel')}>
            <option value="">{t('document.block.tableRuleAll')}</option>
            {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      </div>
      <input className={field} value={block.title ?? ''} placeholder={t('document.block.tableTitlePlaceholder')} onChange={(e) => onChange({ ...block, title: e.target.value || undefined })} aria-label={t('document.block.tableTitleAriaLabel')} />
      <input className={field} value={block.caption ?? ''} placeholder={t('document.block.captionPlaceholder')} onChange={(e) => onChange({ ...block, caption: e.target.value || undefined })} aria-label={t('document.block.tableCaptionAriaLabel')} />
      <div className="flex flex-wrap gap-x-2 gap-y-1" role="group" aria-label={t('document.block.tableColumnsLabel')}>
        {TABLE_COLUMN_IDS.map((c) => (
          <label key={c} className="inline-flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={block.columns.includes(c)} onChange={() => toggleColumn(c)} className="accent-[#7aa2f7]" />
            {t(TABLE_COLUMN_LABEL_KEY[c])}
          </label>
        ))}
      </div>
    </div>
  );
}
