/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List Library — the "Lists" landing view: saved lists + presets, each row
 * runnable/editable/duplicable/exportable/deletable. Split out of
 * `ListPanel.tsx` (which owns the run/import lifecycle and the other two
 * views) to keep that file under the module-size budget.
 */

import { Plus, Play, FileSpreadsheet, Trash2, Download, Pencil, Copy, Table2 } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { EmptyState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { LIST_PRESETS } from '@/lib/lists';
import type { ListDefinition } from '@/lib/lists';
import { useTranslation } from '@/i18n/useTranslation';

interface ListLibraryProps {
  definitions: ListDefinition[];
  activeListId: string | null;
  executing: boolean;
  hasData: boolean;
  onExecute: (def: ListDefinition) => void;
  onCreateNew: () => void;
  onEdit: (def: ListDefinition) => void;
  onDuplicate: (def: ListDefinition) => void;
  onDelete: (id: string) => void;
  onExport: (def: ListDefinition) => void;
}

export function ListLibrary({
  definitions,
  activeListId,
  executing,
  hasData,
  onExecute,
  onCreateNew,
  onEdit,
  onDuplicate,
  onDelete,
  onExport,
}: ListLibraryProps) {
  const { t } = useTranslation();
  const rowProps = { activeListId, executing, hasData, onExecute, onDuplicate };
  // New list and Import live in the panel header (#8802); the library is the
  // saved lists beside the templates, side by side once the dock is wide.
  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="@container">
        <div className="flex flex-col @3xl:flex-row">
          <section aria-label={t('lists.library.savedLists')} className="shrink-0 border-b border-border @3xl:w-80 @3xl:border-b-0 @3xl:border-r">
            {definitions.length === 0 ? (
              <EmptyState
                align="start"
                className="pt-4"
                icon={<Table2 />}
                title={t('lists.library.emptyTitle')}
                description={t('lists.library.emptyDescription')}
                action={(
                  <Button size="sm" className="h-7 gap-1.5" onClick={onCreateNew} disabled={!hasData}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('lists.library.newList')}
                  </Button>
                )}
              />
            ) : (
              <div className="px-3 py-2">
                <h3 className={SECTION_LABEL}>{t('lists.library.savedLists')}</h3>
                {definitions.map(def => (
                  <ListItem key={def.id} definition={def} {...rowProps} onEdit={onEdit} onDelete={onDelete} onExport={onExport} />
                ))}
              </div>
            )}
          </section>
          <section aria-label={t('lists.library.templates')} className="min-w-0 flex-1 px-3 py-2">
            <h3 className={SECTION_LABEL}>{t('lists.library.templates')}</h3>
            <div className="grid grid-cols-1 gap-x-4 @lg:grid-cols-2 @5xl:grid-cols-3">
              {LIST_PRESETS.map(preset => <ListItem key={preset.id} definition={preset} {...rowProps} isPreset />)}
            </div>
          </section>
        </div>
      </div>
    </ScrollArea>
  );
}

const SECTION_LABEL = 'mb-1 text-xs font-semibold text-muted-foreground';

interface ListItemProps {
  definition: ListDefinition;
  activeListId: string | null;
  executing: boolean;
  hasData: boolean;
  onExecute: (def: ListDefinition) => void;
  onEdit?: (def: ListDefinition) => void;
  onDuplicate?: (def: ListDefinition) => void;
  onDelete?: (id: string) => void;
  onExport?: (def: ListDefinition) => void;
  isPreset?: boolean;
}

function ListItem({ definition, activeListId, executing: anyExecuting, hasData, onExecute, onEdit, onDuplicate, onDelete, onExport, isPreset }: ListItemProps) {
  const { t } = useTranslation();
  const isActive = activeListId === definition.id;
  const executing = anyExecuting && isActive;
  return (
    <div
      className={cn('group flex h-7 items-center gap-2 rounded-md px-2 hover:bg-muted/50', isActive && 'bg-muted')}
    >
      <button type="button" disabled={!hasData} className="flex flex-1 min-w-0 items-center gap-2 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed" onClick={() => onExecute(definition)}>
        <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {/* The name keeps its width until it alone overflows, then truncates
            (full name on hover); the description takes what is left (#8802). */}
        <span className="min-w-0 truncate font-medium" title={definition.name} data-list-name>{definition.name}</span>
        {definition.description && <span className="min-w-0 flex-1 truncate text-muted-foreground">{definition.description}</span>}
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {executing ? (
          <Spinner size="sm" />
        ) : (
          <>
            <IconButton
              label={t('lists.library.runListAriaLabel', { name: definition.name })}
              tooltip={t('lists.library.run')}
              size="icon-sm"
              className="h-6 w-6"
              onClick={(e) => {
                e.stopPropagation();
                if (hasData) onExecute(definition);
              }}
              disabled={!hasData}
            >
              <Play className="h-3 w-3" />
            </IconButton>
            {!isPreset && onEdit && (
              <IconButton
                label={t('lists.library.editListAriaLabel', { name: definition.name })}
                tooltip={t('lists.library.edit')}
                size="icon-sm"
                className="h-6 w-6"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(definition);
                }}
              >
                <Pencil className="h-3 w-3" />
              </IconButton>
            )}
            {onDuplicate && (
              <IconButton
                label={isPreset ? t('lists.library.useAsTemplateAriaLabel', { name: definition.name }) : t('lists.library.duplicateListAriaLabel', { name: definition.name })}
                tooltip={isPreset ? t('lists.library.useAsTemplate') : t('lists.library.duplicate')}
                size="icon-sm"
                className="h-6 w-6"
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate(definition);
                }}
              >
                <Copy className="h-3 w-3" />
              </IconButton>
            )}
            {!isPreset && onExport && (
              <IconButton
                label={t('lists.library.exportListAriaLabel', { name: definition.name })}
                tooltip={t('lists.library.export')}
                size="icon-sm"
                className="h-6 w-6"
                onClick={(e) => {
                  e.stopPropagation();
                  onExport(definition);
                }}
              >
                <Download className="h-3 w-3" />
              </IconButton>
            )}
            {!isPreset && onDelete && (
              <IconButton
                label={t('lists.library.deleteListAriaLabel', { name: definition.name })}
                tooltip={t('lists.library.delete')}
                size="icon-sm"
                className="h-6 w-6 hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(definition.id);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </IconButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}
