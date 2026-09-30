/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Author controls whose actions or dialogs belong to the mounted ribbon. */
import { FileInput, History, PenLine, RotateCcw } from 'lucide-react';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import { useViewerStore } from '@/store';
import { runContextAction } from './surface-commands-context';
import type { SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const ribbonOnly = ['ribbon'] as const;
const canEdit = (state: SurfaceCommandState): boolean => state.canEditInSession;

export const RIBBON_AUTHOR_SURFACE_COMMANDS = [
  {
    id: 'author:undo', labelKey: 'ribbon.author.undo',
    keywords: 'undo workspace edit', category: 'Tools', icon: RotateCcw,
    surfaces: ribbonOnly, enabled: canEdit, shortcut: 'edit.undo',
    run: () => { replayWorkspaceHistory(useViewerStore.getState(), 'undo'); },
  },
  {
    id: 'author:redo', labelKey: 'ribbon.author.redo',
    keywords: 'redo workspace edit', category: 'Tools', icon: History,
    surfaces: ribbonOnly, enabled: canEdit, shortcut: 'edit.redo',
    run: () => { replayWorkspaceHistory(useViewerStore.getState(), 'redo'); },
  },
  {
    id: 'author:bulk-properties', labelKey: 'ribbon.author.bulkPropertyEditor',
    keywords: 'bulk edit properties', category: 'Tools', icon: PenLine,
    surfaces: ribbonOnly, enabled: canEdit,
    run: runContextAction,
  },
  {
    id: 'author:import-data', labelKey: 'ribbon.author.importData',
    keywords: 'import external data properties', category: 'Tools', icon: FileInput,
    surfaces: ribbonOnly, enabled: canEdit,
    run: runContextAction,
  },
] as const satisfies readonly SurfaceCommandDefinition[];
