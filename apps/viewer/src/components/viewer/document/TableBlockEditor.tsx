/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A table block's editor (#5142): which list the block is a copy of, and
 * how it prints. The list itself is authored in the Lists panel — "Edit in
 * Lists" hands the copy over as a draft, and "Update from saved list" pulls
 * the saved edit back — so this stays a picker, never a second builder.
 */
import { useMemo } from 'react';
import type { ListDefinition } from '@ifc-lite/lists';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { LIST_PRESETS } from '@/lib/lists';
import { freshListCopyId } from '@/lib/document/persistence';
import { listCopyForDocument, TABLE_ROWS_DEFAULT, TABLE_ROWS_MAX, type TableBlock } from '@/lib/document/types';
import { ClampedNumberInput, field } from './BlockEditor.parts';

/** Above this many columns a portrait page ellipsizes most cells. */
const MANY_COLUMNS = 10;

export interface TableBlockEditorProps {
  block: TableBlock;
  onChange: (block: TableBlock) => void;
}

export function TableBlockEditor({ block, onChange }: TableBlockEditorProps) {
  const { t } = useTranslation();
  const listDefinitions = useViewerStore((s) => s.listDefinitions);
  const setPendingListDraft = useViewerStore((s) => s.setPendingListDraft);
  const setListPanelVisible = useViewerStore((s) => s.setListPanelVisible);
  const list = block.source.list;

  // The library or preset the copy came from, if it still exists here.
  const origin = useMemo<ListDefinition | null>(() => {
    const id = block.source.fromListId;
    if (!id) return null;
    return listDefinitions.find((d) => d.id === id) ?? LIST_PRESETS.find((p) => p.id === id) ?? null;
  }, [block.source.fromListId, listDefinitions]);
  const originNewer = origin !== null && origin.updatedAt > list.updatedAt;

  const replaceWith = (picked: ListDefinition): void => {
    // The copy cannot keep a selection snapshot (see `ListTableSource.list`); say so when one is dropped.
    if (picked.expressIdsByModel) toast.info(t('document.block.tableSelectionDropped'));
    onChange({ ...block, source: { kind: 'list', list: listCopyForDocument(picked, freshListCopyId()), fromListId: picked.id } });
  };
  const editInLists = (): void => {
    // Saving in the panel updates the saved list the copy came from; a copy of a preset (or of a
    // list this browser no longer has) becomes a new saved list, which the block then points at.
    const saved = listDefinitions.find((d) => d.id === block.source.fromListId);
    const draftId = saved ? saved.id : crypto.randomUUID();
    const { expressIdsByModel: _none, ...content } = list;
    void _none;
    setPendingListDraft({ ...content, id: draftId, updatedAt: Date.now() });
    if (!saved) onChange({ ...block, source: { ...block.source, fromListId: draftId } });
    setListPanelVisible(true);
    toast.info(t('document.block.tableEditInListsHint'));
  };

  const view = list.grouping?.view === 'schedule' ? t('document.block.tableViewSchedule')
    : list.grouping && (list.grouping.columnIds?.length || list.grouping.columnId) ? t('document.block.tableViewGrouped')
      : t('document.block.tableViewFlat');

  return (
    <div className="flex flex-col gap-1.5" data-table-block-editor>
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
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${field} min-w-0 flex-1`} value={block.title ?? ''} placeholder={list.name} onChange={(e) => onChange({ ...block, title: e.target.value || undefined })} aria-label={t('document.block.tableTitleAriaLabel')} />
        <input className={`${field} min-w-0 flex-1`} value={block.caption ?? ''} placeholder={t('document.block.captionPlaceholder')} onChange={(e) => onChange({ ...block, caption: e.target.value || undefined })} aria-label={t('document.block.tableCaptionAriaLabel')} />
        <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.tableRowsLabel')}
          <ClampedNumberInput value={block.maxRows} min={1} max={TABLE_ROWS_MAX} placeholder={String(TABLE_ROWS_DEFAULT)} allowUndefined ariaLabel={t('document.block.tableRowsAriaLabel')} onCommit={(maxRows) => onChange({ ...block, maxRows })} />
        </label>
      </div>
      <div className="text-muted-foreground" data-table-summary>
        {t('document.block.tableSummary', { columns: list.columns.length, view })}
        {list.columns.length > MANY_COLUMNS && <span className="ml-1 text-amber-700">{t('document.block.tableManyColumns')}</span>}
      </div>
    </div>
  );
}
