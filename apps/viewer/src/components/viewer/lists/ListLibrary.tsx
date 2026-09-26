/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List Library — the "Lists" landing view: saved lists + presets, each row
 * runnable/editable/duplicable/exportable/deletable. Split out of
 * `ListPanel.tsx` (which owns the run/import lifecycle and the other two
 * views) to keep that file under the module-size budget.
 */

import { Plus, Play, FileSpreadsheet, Trash2, Download, Upload, Pencil, Copy } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
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
  onImport: () => void;
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
  onImport,
}: ListLibraryProps) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Actions */}
      <div className="flex items-center gap-1 px-3 py-2 border-b">
        <Button
          variant="outline"
          size="sm"
          onClick={onCreateNew}
          disabled={!hasData}
          className="text-xs h-7"
        >
          <Plus className="h-3 w-3 mr-1" />
          {t('lists.library.newList')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onImport} className="text-xs h-7">
          <Upload className="h-3 w-3 mr-1" />
          {t('lists.library.import')}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {/* User's saved lists */}
        {definitions.length > 0 && (
          <div className="px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('lists.library.savedLists')}
            </span>
            <div className="mt-1 space-y-1">
              {definitions.map(def => (
                <ListItem
                  key={def.id}
                  definition={def}
                  isActive={activeListId === def.id}
                  executing={executing && activeListId === def.id}
                  hasData={hasData}
                  onExecute={onExecute}
                  onEdit={onEdit}
                  onDuplicate={onDuplicate}
                  onDelete={onDelete}
                  onExport={onExport}
                />
              ))}
            </div>
          </div>
        )}

        {definitions.length > 0 && <Separator className="my-1" />}

        {/* Presets */}
        <div className="px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('lists.library.templates')}
          </span>
          <div className="mt-1 space-y-1">
            {LIST_PRESETS.map(preset => (
              <ListItem
                key={preset.id}
                definition={preset}
                isActive={activeListId === preset.id}
                executing={executing && activeListId === preset.id}
                hasData={hasData}
                onExecute={onExecute}
                onDuplicate={onDuplicate}
                isPreset
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

// ============================================================================
// List Item
// ============================================================================

interface ListItemProps {
  definition: ListDefinition;
  isActive: boolean;
  executing: boolean;
  hasData: boolean;
  onExecute: (def: ListDefinition) => void;
  onEdit?: (def: ListDefinition) => void;
  onDuplicate?: (def: ListDefinition) => void;
  onDelete?: (id: string) => void;
  onExport?: (def: ListDefinition) => void;
  isPreset?: boolean;
}

function ListItem({ definition, isActive, executing, hasData, onExecute, onEdit, onDuplicate, onDelete, onExport, isPreset }: ListItemProps) {
  const { t } = useTranslation();
  return (
    <div
      className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted/50 ${
        isActive ? 'bg-muted' : ''
      }`}
    >
      <button type="button" disabled={!hasData} className="flex flex-1 min-w-0 items-center gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed" onClick={() => onExecute(definition)}>
        <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0"><span className="block truncate text-xs font-medium">{definition.name}</span>
        {definition.description && (
          <span className="block truncate text-xs text-muted-foreground">{definition.description}</span>
        )}
        </span>
      </button>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
