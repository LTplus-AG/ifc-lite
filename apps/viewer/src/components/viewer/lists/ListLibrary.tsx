/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List Library — the "Lists" landing view: saved lists + presets, each row
 * runnable/editable/duplicable/exportable/deletable. Split out of
 * `ListPanel.tsx` (which owns the run/import lifecycle and the other two
 * views) to keep that file under the module-size budget.
 */

import {
  Plus,
  Play,
  FileSpreadsheet,
  Trash2,
  Download,
  Upload,
  Loader2,
  Pencil,
  Copy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
      className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer hover:bg-muted/50 ${
        isActive ? 'bg-muted' : ''
      }`}
      onClick={() => hasData && onExecute(definition)}
    >
      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="truncate text-xs font-medium">{definition.name}</div>
        {definition.description && (
          <div className="truncate text-xs text-muted-foreground">{definition.description}</div>
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {executing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasData) onExecute(definition);
                  }}
                  disabled={!hasData}
                  aria-label={t('lists.library.runListAriaLabel', { name: definition.name })}
                >
                  <Play className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('lists.library.run')}</TooltipContent>
            </Tooltip>
            {!isPreset && onEdit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(definition);
                    }}
                    aria-label={t('lists.library.editListAriaLabel', { name: definition.name })}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('lists.library.edit')}</TooltipContent>
              </Tooltip>
            )}
            {onDuplicate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicate(definition);
                    }}
                    aria-label={isPreset ? t('lists.library.useAsTemplateAriaLabel', { name: definition.name }) : t('lists.library.duplicateListAriaLabel', { name: definition.name })}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isPreset ? t('lists.library.useAsTemplate') : t('lists.library.duplicate')}</TooltipContent>
              </Tooltip>
            )}
            {!isPreset && onExport && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      onExport(definition);
                    }}
                    aria-label={t('lists.library.exportListAriaLabel', { name: definition.name })}
                  >
                    <Download className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('lists.library.export')}</TooltipContent>
              </Tooltip>
            )}
            {!isPreset && onDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(definition.id);
                    }}
                    aria-label={t('lists.library.deleteListAriaLabel', { name: definition.name })}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('lists.library.delete')}</TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}
