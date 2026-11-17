/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Author controls whose actions or dialogs belong to the mounted ribbon. */
import { FileInput, History, PenLine, RotateCcw } from 'lucide-react';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import { useViewerStore } from '@/store';
import type { SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const authorSurfaces = ['ribbon', 'palette'] as const;
const canEdit = (state: SurfaceCommandState): boolean => state.canEditInSession;

export const RIBBON_AUTHOR_SURFACE_COMMANDS = [
  {
    id: 'author:undo', labelKey: 'ribbon.author.undo',
    keywords: 'undo workspace edit', category: 'Tools', icon: RotateCcw,
    surfaces: authorSurfaces, enabled: canEdit, shortcut: 'edit.undo',
    run: () => { replayWorkspaceHistory(useViewerStore.getState(), 'undo'); },
  },
  {
    id: 'author:redo', labelKey: 'ribbon.author.redo',
    keywords: 'redo workspace edit', category: 'Tools', icon: History,
    surfaces: authorSurfaces, enabled: canEdit, shortcut: 'edit.redo',
    run: () => { replayWorkspaceHistory(useViewerStore.getState(), 'redo'); },
  },
  {
    id: 'author:bulk-properties', keywordsKey: 'commandPalette.aliases.bulk', labelKey: 'ribbon.author.bulkPropertyEditor',
    keywords: 'bulk edit properties query set attribute construction stage', category: 'Tools', icon: PenLine,
    surfaces: authorSurfaces, enabled: canEdit,
    run: (context) => { context.openBulkProperties?.(); },
  },
  {
    id: 'author:import-data', keywordsKey: 'commandPalette.aliases.import', labelKey: 'ribbon.author.importData',
    keywords: 'import external data properties CSV spreadsheet mapping', category: 'Tools', icon: FileInput,
    surfaces: authorSurfaces, enabled: canEdit,
    run: (context) => { context.openImportData?.(); },
  },
] as const satisfies readonly SurfaceCommandDefinition[];
