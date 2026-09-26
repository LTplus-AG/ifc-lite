/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Named section cuts, selectable as the Drawing panel's source (#5514,
 * charter #5478). Replaces the header's plain cut label with a menu:
 * save the live cut under a name, or apply/rename/delete a saved one.
 * Applying a cut writes `sectionPlane` (`store/savedSectionCutsStore.ts`),
 * so BCF viewpoint capture and the floor-plan command pick it up through
 * the same Section/Drawing contract every other section writer uses —
 * this component only manages the named list, not their reuse.
 */

import { ChevronDown, Pencil, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { promptDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslation } from '@/i18n';
import {
  applySavedSectionCut,
  removeSavedSectionCut,
  renameSavedSectionCut,
  saveCurrentSectionCut,
  useSavedSectionCuts,
} from '@/store/savedSectionCutsStore';

export interface DrawingSectionCutMenuProps {
  /** The live cut's label, exactly as the header already formats it. */
  cutLabel: string;
}

export function DrawingSectionCutMenu({ cutLabel }: DrawingSectionCutMenuProps) {
  const { t } = useTranslation();
  const cuts = useSavedSectionCuts((s) => s.cuts);
  const activeCutId = useSavedSectionCuts((s) => s.activeCutId);

  const handleSaveCurrent = async () => {
    const name = (await promptDialog({ description: t('section2d.savedCuts.savePrompt'), defaultValue: '' }))?.trim();
    if (name) saveCurrentSectionCut(name);
  };

  const handleRename = async (id: string, currentName: string) => {
    const name = (await promptDialog({ description: t('section2d.savedCuts.renamePrompt'), defaultValue: currentName }))?.trim();
    if (name) renameSavedSectionCut(id, name);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground tabular-nums"
          aria-label={t('section2d.savedCuts.menuLabel', { label: cutLabel })}
        >
          <span className="truncate">{cutLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onClick={handleSaveCurrent} className="text-xs">
          <Save className="mr-2 h-3.5 w-3.5" />
          {t('section2d.savedCuts.saveCurrent')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">{t('section2d.savedCuts.savedGroup')}</DropdownMenuLabel>
        {cuts.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('section2d.savedCuts.empty')}</div>
        )}
        {cuts.map((cut) => (
          <div
            key={cut.id}
            data-testid="saved-section-cut-row"
            className="flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-accent"
          >
            <button
              type="button"
              title={t('section2d.savedCuts.applyTitle')}
              aria-current={activeCutId === cut.id ? 'true' : undefined}
              onClick={() => applySavedSectionCut(cut.id)}
              className="min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left text-xs"
            >
              {cut.name}
            </button>
            <button
              type="button"
              title={t('section2d.savedCuts.renameTitle')}
              onClick={() => handleRename(cut.id, cut.name)}
              className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              title={t('section2d.savedCuts.deleteTitle')}
              onClick={() => removeSavedSectionCut(cut.id)}
              className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
