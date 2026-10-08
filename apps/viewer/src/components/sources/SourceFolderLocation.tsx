/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SourceContainer } from '@ifc-lite/plugin-api';
import { Star } from 'lucide-react';
import { useTranslation } from '@/i18n';

export function SourceFolderLocation({ trail, folders, selected, searchActive, isFavourite, onSelect, onToggle }: {
  trail: readonly SourceContainer[]; folders: readonly SourceContainer[]; selected: SourceContainer;
  searchActive: boolean; isFavourite: (id: string) => boolean;
  onSelect: (folder: SourceContainer) => void; onToggle: (folder: SourceContainer) => void;
}) {
  const { t } = useTranslation();
  const pinned = folders.filter((folder) => isFavourite(folder.id));
  return <>
    {!searchActive && <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
      <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1" aria-label={t('sources.workspace.location')}>
        {trail.map((container, index) => <span key={container.id} className="flex min-w-0 items-center gap-1">
          <button type="button" className="truncate hover:text-foreground hover:underline" onClick={() => onSelect(container)}>{container.name}</button>
          {index < trail.length - 1 && <span aria-hidden>/</span>}
        </span>)}
      </nav>
      <button type="button" className={`shrink-0 rounded p-1 hover:bg-accent ${isFavourite(selected.id) ? 'text-amber-500' : ''}`}
        aria-label={t(isFavourite(selected.id) ? 'sources.workspace.unpinFolder' : 'sources.workspace.pinFolder', { name: selected.name })}
        aria-pressed={isFavourite(selected.id)} onClick={() => onToggle(selected)}>
        <Star className={`h-4 w-4 ${isFavourite(selected.id) ? 'fill-current' : ''}`} aria-hidden />
      </button>
    </div>}
    {pinned.length > 0 && <nav className="border-b px-3 py-2" aria-label={t('sources.workspace.pinnedFolders')}>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{t('sources.workspace.pinnedFolders')}</p>
      <div className="flex flex-wrap gap-1">
        {pinned.map((folder) => <button key={folder.id} type="button" className="flex max-w-full items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-accent"
          onClick={() => onSelect(folder)}><Star className="h-3 w-3 shrink-0 fill-current text-amber-500" aria-hidden /><span className="truncate">{folder.name}</span></button>)}
      </div>
    </nav>}
  </>;
}
