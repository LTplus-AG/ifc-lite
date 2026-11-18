/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Model workspace operations reuse the rail and keyboard flows (#8947). */
import { ArrowDown, ArrowUp, Copy, CopyPlus, LogOut, Move, ClipboardPaste, RotateCw } from 'lucide-react';
import { useViewerStore } from '@/store';
import { launchModelCommand } from '@/lib/commands/modeling/keys-workspace';
import { copyShortcut, pasteShortcut } from '@/lib/commands/modeling/copy-keys';
import { stepSessionStorey } from '@/lib/commands/modeling/workspace-storeys';
import { leaveModelWorkspace } from './model/leave-model-workspace';
import type { SurfaceCommandDefinition } from './surface-command-types';

export const MODEL_EDIT_SURFACE_COMMANDS = ([
  { id: 'tool:array', labelKey: 'commandPalette.model.array', keywords: 'array repeat elements linear polar copies radial spacing count', icon: CopyPlus,
    shortcut: 'model.array', run: () => { launchModelCommand('element.array'); } },
  { id: 'tool:move', labelKey: 'commandPalette.model.move', keywords: 'move selected elements translate base target distance direction', icon: Move,
    shortcut: 'model.move', run: () => { launchModelCommand('element.move'); } },
  { id: 'tool:rotate', labelKey: 'commandPalette.model.rotate', keywords: 'rotate selected elements pivot angle turn', icon: RotateCw,
    shortcut: 'model.rotate', run: () => { launchModelCommand('element.rotate'); } },
  { id: 'model:copy', labelKey: 'commandPalette.model.copy', keywords: 'copy selected elements clipboard', icon: Copy,
    shortcut: 'model.copy', run: () => { copyShortcut(); } },
  { id: 'model:paste', labelKey: 'commandPalette.model.paste', keywords: 'paste copied elements clipboard cursor', icon: ClipboardPaste,
    shortcut: 'model.paste', run: () => { pasteShortcut(launchModelCommand, false); } },
  { id: 'model:paste-in-place', labelKey: 'commandPalette.model.pasteInPlace', keywords: 'paste copied elements same position current storey clipboard', icon: ClipboardPaste,
    shortcut: 'model.pasteInPlace', run: () => { pasteShortcut(launchModelCommand, true); } },
  { id: 'model:storey-up', labelKey: 'commandPalette.model.storeyUp', keywords: 'work storey above floor level up', icon: ArrowUp,
    shortcut: 'model.storeyUp', run: () => { stepSessionStorey(useViewerStore.getState(), 1); } },
  { id: 'model:storey-down', labelKey: 'commandPalette.model.storeyDown', keywords: 'work storey below floor level down', icon: ArrowDown,
    shortcut: 'model.storeyDown', run: () => { stepSessionStorey(useViewerStore.getState(), -1); } },
  { id: 'model:exit', labelKey: 'modelWorkspace.tool.leave', keywords: 'leave exit close model workspace cancel drawing', icon: LogOut,
    run: () => { leaveModelWorkspace(); } },
] as const).map(entry => ({ ...entry, category: 'Tools' as const, surfaces: ['palette'] as const,
  enabled: ({ canEditInSession }: { canEditInSession: boolean }) => entry.id === 'model:exit' || canEditInSession,
})) satisfies readonly SurfaceCommandDefinition[];
