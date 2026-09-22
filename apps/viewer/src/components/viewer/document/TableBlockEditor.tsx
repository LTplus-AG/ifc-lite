/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A table block's editor (#5142, #5138): a source-kind switch (List |
 * Validation results), then the fields for whichever source is picked —
 * title/caption/max-rows are shared, so switching kind keeps them.
 *
 * For a list source: which list the block is a copy of. The list itself is
 * authored in the Lists panel — "Edit in Lists" hands the copy over as a
 * draft, and "Update from saved list" pulls the saved edit back — so this
 * stays a picker, never a second builder.
 *
 * For a validation source: rows mode, an optional rule filter (read from
 * the live report so it only offers rules that actually ran), and which
 * columns print.
 */
import { useEffect, useMemo, useState } from 'react';
import { groupingColumnIds, type ListDefinition } from '@ifc-lite/lists';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { LIST_PRESETS } from '@/lib/lists';
import { freshListCopyId } from '@/lib/document/persistence';
import { DEFAULT_VALIDATION_COLUMNS } from '@/lib/document/presets';
import {
  listCopyForDocument, TABLE_COLUMN_IDS, TABLE_ROWS_DEFAULT, TABLE_ROWS_MAX,
  type ListTableSource, type TableBlock, type TableColumnId, type TableSource, type ValidationRowsMode, type ValidationTableSource,
} from '@/lib/document/types';
import { ClampedNumberInput, field } from './BlockEditor.parts';
import { TABLE_COLUMN_LABEL_KEY } from './table-column-labels';

/** Above this many columns a portrait page ellipsizes most cells. */
const MANY_COLUMNS = 10;

export interface TableBlockEditorProps {
  block: TableBlock;
  onChange: (block: TableBlock) => void;
}

/** A blank validation source: "every rule, failed entities" with that mode's default columns. */
function blankValidationSource(): ValidationTableSource {
  return { kind: 'validation', rows: 'failed', columns: DEFAULT_VALIDATION_COLUMNS.failed };
}

function ListSourceEditor({ block, source, onChange }: { block: TableBlock; source: ListTableSource; onChange: (block: TableBlock) => void }) {
  const { t } = useTranslation();
  const listDefinitions = useViewerStore((s) => s.listDefinitions);
  const setPendingListDraft = useViewerStore((s) => s.setPendingListDraft);
  const setListPanelVisible = useViewerStore((s) => s.setListPanelVisible);
  const list = source.list;

  // The library or preset the copy came from, if it still exists here.
  const origin = useMemo<ListDefinition | null>(() => {
    const id = source.fromListId;
    if (!id) return null;
    return listDefinitions.find((d) => d.id === id) ?? LIST_PRESETS.find((p) => p.id === id) ?? null;
  }, [source.fromListId, listDefinitions]);
  const originNewer = origin !== null && origin.updatedAt > list.updatedAt;

  const replaceWith = (picked: ListDefinition): void => {
    // The copy cannot keep a selection snapshot (see `ListTableSource.list`); say so when one is dropped.
    if (picked.expressIdsByModel) toast.info(t('document.block.tableSelectionDropped'));
    onChange({ ...block, source: { kind: 'list', list: listCopyForDocument(picked, freshListCopyId()), fromListId: picked.id } });
  };
  // A copy of a preset (or of a list this browser no longer has) edited in Lists becomes a NEW saved
  // list; the block points at it only once it exists — cancelling in the builder must not leave the
  // block pointing at nothing (review finding).
  const [pendingDraftId, setPendingDraftId] = useState<string | null>(null);
  useEffect(() => {
    if (pendingDraftId && listDefinitions.some((d) => d.id === pendingDraftId)) {
      setPendingDraftId(null);
      onChange({ ...block, source: { ...source, fromListId: pendingDraftId } });
    }
  }, [pendingDraftId, listDefinitions, block, onChange]);

  const editInLists = (): void => {
    const saved = listDefinitions.find((d) => d.id === source.fromListId);
    // Saving in the panel updates the saved list the copy came from — unless the saved list has moved
    // on since the copy was taken, in which case the saved list itself is what gets edited, never
    // overwritten by the block's older copy (review finding).
    const { expressIdsByModel: _none, ...content } = originNewer && saved ? saved : list;
    void _none;
    const draftId = saved ? saved.id : crypto.randomUUID();
    setPendingListDraft({ ...content, id: draftId, updatedAt: Date.now() });
    if (!saved) setPendingDraftId(draftId);
    setListPanelVisible(true);
    toast.info(t('document.block.tableEditInListsHint'));
  };

  const view = list.grouping?.view === 'schedule' ? t('document.block.tableViewSchedule')
    : groupingColumnIds(list.grouping).length > 0 ? t('document.block.tableViewGrouped')
      : t('document.block.tableViewFlat');

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">{t('document.block.kindTable')}
          <select
            className={`${field} min-w-0 flex-1`}
            value=""
            onChange={(e) => {
              const [kind, id] = e.target.value.split(':', 2);
              const picked = kind === 'saved' ? listDefinitions.find((d) => d.id === id) : LIST_PRESETS.find((p) => p.id === id);
              if (picked) replaceWith(picked);
            }}
            aria-label={t('document.block.tableReplaceAriaLabel')}
          >
            <option value="">{t('document.block.tableReplaceOption', { name: list.name })}</option>
            {listDefinitions.length > 0 && (
              <optgroup label={t('document.block.tableSavedGroup')}>
                {listDefinitions.map((d) => <option key={d.id} value={`saved:${d.id}`}>{d.name}</option>)}
              </optgroup>
            )}
            <optgroup label={t('document.block.tablePresetGroup')}>
              {LIST_PRESETS.map((p) => <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>)}
            </optgroup>
          </select>
        </label>
        {origin && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => replaceWith(origin)} title={originNewer ? t('document.block.tableSavedNewer') : undefined} data-table-update>
            {t('document.block.tableUpdateFromSaved')}{originNewer ? ' •' : ''}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={editInLists} data-table-edit-in-lists>{t('document.block.tableEditInLists')}</Button>
      </div>
      <div className="text-muted-foreground" data-table-summary>
        {t('document.block.tableSummary', { columns: list.columns.length, view })}
        {list.columns.length > MANY_COLUMNS && <span className="ml-1 text-amber-700">{t('document.block.tableManyColumns')}</span>}
      </div>
    </>
  );
}

function ValidationSourceEditor({ block, source, onChange }: { block: TableBlock; source: ValidationTableSource; onChange: (block: TableBlock) => void }) {
  const { t } = useTranslation();
  const report = useViewerStore((s) => s.idsValidationReport);
  const rules = report?.specificationResults.map((s) => s.specification) ?? [];

  // A rows-mode switch resets to that mode's default columns ONLY when the author never
  // customized them yet, so flipping between "failed" and "all" does not silently discard a
  // column selection already tuned by hand.
  const setRows = (rows: ValidationRowsMode): void => {
    const stillDefault = JSON.stringify([...source.columns].sort()) === JSON.stringify([...DEFAULT_VALIDATION_COLUMNS[source.rows]].sort());
    onChange({ ...block, source: { ...source, rows, columns: stillDefault ? DEFAULT_VALIDATION_COLUMNS[rows] : source.columns } });
  };
  const toggleColumn = (column: TableColumnId): void => {
    const has = source.columns.includes(column);
    const columns = has ? source.columns.filter((c) => c !== column) : [...source.columns, column];
    if (columns.length > 0) onChange({ ...block, source: { ...source, columns } });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.tableValidationRowsLabel')}
          <select className={field} value={source.rows} onChange={(e) => setRows(e.target.value as ValidationRowsMode)} aria-label={t('document.block.tableValidationRowsAriaLabel')}>
            <option value="failed">{t('document.block.tableValidationRowsFailed')}</option>
            <option value="passed">{t('document.block.tableValidationRowsPassed')}</option>
            <option value="all">{t('document.block.tableValidationRowsAll')}</option>
            <option value="sets">{t('document.block.tableValidationRowsSets')}</option>
          </select>
        </label>
        <label className="inline-flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">{t('document.block.tableRuleLabel')}
          <select className={`${field} min-w-0 flex-1`} value={source.ruleId ?? ''} onChange={(e) => onChange({ ...block, source: { ...source, ruleId: e.target.value || undefined } })} aria-label={t('document.block.tableRuleAriaLabel')}>
            <option value="">{t('document.block.tableRuleAll')}</option>
            {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-1" role="group" aria-label={t('document.block.tableColumnsLabel')} data-table-columns>
        {TABLE_COLUMN_IDS.map((c) => (
          <label key={c} className="inline-flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={source.columns.includes(c)} onChange={() => toggleColumn(c)} className="accent-[#7aa2f7]" />
            {t(TABLE_COLUMN_LABEL_KEY[c])}
          </label>
        ))}
      </div>
    </>
  );
}

export function TableBlockEditor({ block, onChange }: TableBlockEditorProps) {
  const { t } = useTranslation();
  const listDefinitions = useViewerStore((s) => s.listDefinitions);
  const source = block.source;

  const switchSourceKind = (kind: TableSource['kind']): void => {
    if (kind === source.kind) return;
    const nextSource: TableSource = kind === 'list'
      ? { kind: 'list', list: listCopyForDocument(listDefinitions[0] ?? LIST_PRESETS[0], freshListCopyId()), fromListId: (listDefinitions[0] ?? LIST_PRESETS[0]).id }
      : blankValidationSource();
    onChange({ ...block, source: nextSource });
  };

  return (
    <div className="flex flex-col gap-1.5" data-table-block-editor>
      <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.tableSourceLabel')}
        <select className={field} value={source.kind} onChange={(e) => switchSourceKind(e.target.value as TableSource['kind'])} aria-label={t('document.block.tableSourceAriaLabel')}>
          <option value="list">{t('document.block.tableSourceList')}</option>
          <option value="validation">{t('document.block.tableSourceValidation')}</option>
        </select>
      </label>
      {source.kind === 'list' ? <ListSourceEditor block={block} source={source} onChange={onChange} /> : <ValidationSourceEditor block={block} source={source} onChange={onChange} />}
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${field} min-w-0 flex-1`} value={block.title ?? ''} placeholder={source.kind === 'list' ? source.list.name : t('document.block.tableSourceValidation')} onChange={(e) => onChange({ ...block, title: e.target.value || undefined })} aria-label={t('document.block.tableTitleAriaLabel')} />
        <input className={`${field} min-w-0 flex-1`} value={block.caption ?? ''} placeholder={t('document.block.captionPlaceholder')} onChange={(e) => onChange({ ...block, caption: e.target.value || undefined })} aria-label={t('document.block.tableCaptionAriaLabel')} />
        <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.tableRowsLabel')}
          <ClampedNumberInput value={block.maxRows} min={1} max={TABLE_ROWS_MAX} placeholder={String(TABLE_ROWS_DEFAULT)} allowUndefined ariaLabel={t('document.block.tableRowsAriaLabel')} onCommit={(maxRows) => onChange({ ...block, maxRows })} />
        </label>
      </div>
    </div>
  );
}
