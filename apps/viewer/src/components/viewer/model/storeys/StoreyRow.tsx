/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One storey in the storey manager (#9013): the active-storey radio, then
 * name, elevation and floor-to-floor height edited in place, the element
 * count, and the row's actions. One click anywhere on the row that is not a
 * field or action makes it the storey to draw on.
 */

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpToLine, Check, Trash2 } from 'lucide-react';
import type { StoreySummary } from '@ifc-lite/create';
import { useTranslation } from '@/i18n';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { formatElevation, formatHeight } from '@/lib/storeys/storey-length';
import { METRE_SYMBOL } from '@/components/viewer/model-inspector/inspector-fields';
import { StoreyInlineField } from './StoreyInlineField';
import type { LevelDraft, LevelField } from './useStoreyManager';

interface StoreyRowProps {
  row: StoreySummary;
  active: boolean;
  /** Roving tab stop of the active-storey radio group. */
  tabbable: boolean;
  readOnly: boolean;
  draft: LevelDraft | null;
  onActivate: () => void;
  onArrow: (direction: 1 | -1) => void;
  onRename: (name: string) => boolean;
  onLevelDraft: (field: LevelField, text: string) => void;
  onLevelCommit: (field: LevelField, text: string) => boolean;
  onLevelCancel: () => void;
  onAdd: (side: 'above' | 'below') => void;
  onDelete: () => void;
  radioRef?: (element: HTMLButtonElement | null) => void;
  nameRef?: (element: HTMLInputElement | null) => void;
  children?: ReactNode;
}

/** Clicks on fields and buttons inside the row are theirs, not a storey switch. */
function fromControl(event: MouseEvent<HTMLElement>): boolean {
  return (event.target as HTMLElement).closest('input, button, [role="listbox"], [data-storey-row-ignore]') !== null;
}

export function StoreyRow({
  row, active, tabbable, readOnly, draft, onActivate, onArrow, onRename, onLevelDraft, onLevelCommit, onLevelCancel,
  onAdd, onDelete, radioRef, nameRef, children,
}: StoreyRowProps) {
  const { t } = useTranslation();
  const storey = row.Name;
  const fieldError = (field: LevelField) => (draft?.storeyId === row.expressId && draft.field === field ? draft.error : null);
  const onRadioKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); onArrow(-1); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); onArrow(1); }
  };

  return (
    // The row click is a pointer shortcut for the row's own radio, which is the
    // keyboard and screen-reader control for the same action.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <li
      data-storey-row={row.expressId}
      data-active={active || undefined}
      onClick={(event) => { if (!fromControl(event)) onActivate(); }}
      className={cn(
        'group relative rounded-md border px-1.5 py-1.5 transition-colors',
        active ? 'border-overlay-accent bg-overlay-accent-soft' : 'border-transparent hover:bg-accent/60',
      )}
    >
      <div className="flex items-center gap-1">
        {/* The design-system IconButton carries radio semantics in the roving radiogroup (arrow keys move the active storey). */}
        <IconButton
          ref={radioRef}
          // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="radio"
          size="icon-xs"
          aria-checked={active}
          label={t('storeyManager.activate', { storey })}
          tabIndex={tabbable ? 0 : -1}
          onClick={onActivate}
          onKeyDown={onRadioKey}
          className={cn('h-6 w-6 shrink-0 rounded-full border', active ? 'border-overlay-accent text-overlay-accent' : 'border-input text-transparent')}
        >
          <Check aria-hidden className="h-3 w-3" />
        </IconButton>
        <StoreyInlineField
          className="flex-1"
          value={row.Name}
          label={t('storeyManager.field.name', { storey })}
          readOnly={readOnly}
          onCommit={onRename}
          inputRef={nameRef}
          dataField="name"
        />
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground" title={t('storeyManager.column.elements')}>
          {t('storeyManager.elements', { count: row.elementCount })}
        </span>
      </div>
      <div className="mt-0.5 flex items-start gap-1 pl-7">
        <label className="flex min-w-0 flex-1 flex-col">
          <span className="px-1.5 text-2xs text-muted-foreground">{t('storeyManager.column.elevation')}</span>
          <StoreyInlineField
            value={formatElevation(row.elevation)}
            label={t('storeyManager.field.elevation', { storey })}
            suffix={METRE_SYMBOL}
            readOnly={readOnly}
            error={fieldError('elevation')}
            onDraft={(text) => onLevelDraft('elevation', text)}
            onCommit={(text) => onLevelCommit('elevation', text)}
            onCancel={onLevelCancel}
            dataField="elevation"
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col">
          <span className="px-1.5 text-2xs text-muted-foreground">{t('storeyManager.column.height')}</span>
          {row.height === null ? (
            <span className="flex h-7 items-center px-1.5 text-xs text-muted-foreground" title={t('storeyManager.noStoreyAbove')}>
              <span aria-hidden>—</span>
              <span className="sr-only">{t('storeyManager.noStoreyAbove')}</span>
            </span>
          ) : (
            <StoreyInlineField
              value={formatHeight(row.height)}
              label={t('storeyManager.field.height', { storey })}
              suffix={METRE_SYMBOL}
              readOnly={readOnly}
              error={fieldError('height')}
              onDraft={(text) => onLevelDraft('height', text)}
              onCommit={(text) => onLevelCommit('height', text)}
              onCancel={onLevelCancel}
              dataField="height"
            />
          )}
        </label>
        {!readOnly && (
          <div className="flex shrink-0 items-center self-end opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <IconButton size="icon-xs" label={t('storeyManager.addAboveOf', { storey })} onClick={() => onAdd('above')}>
              <ArrowUpToLine aria-hidden className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton size="icon-xs" label={t('storeyManager.addBelowOf', { storey })} onClick={() => onAdd('below')}>
              <ArrowDownToLine aria-hidden className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton size="icon-xs" label={t('storeyManager.delete', { storey })} onClick={onDelete} className="hover:text-danger">
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        )}
      </div>
      {active && <span className="sr-only">{t('storeyManager.active')}</span>}
      {children}
    </li>
  );
}
