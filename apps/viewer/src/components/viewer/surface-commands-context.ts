/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Entity-menu-only command metadata. The mounted menu supplies its active target action. */
import { Building2, Copy, CopyPlus, Layers, ShieldQuestion, Trash2 } from 'lucide-react';
import { ACTION_NAME_KEYS } from '@/lib/commands/action-names';
import type { DuplicateDirection } from '@/store/slices/mutationSlice';
import type { SurfaceCommandDefinition, SurfaceCommandContext, SurfaceCommandState } from './surface-commands';

const contextOnly = ['context'] as const;
const contextAndRibbon = ['context', 'ribbon'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;
const canEdit = (state: SurfaceCommandState): boolean => state.canEditInSession;

export function runContextAction(context: SurfaceCommandContext): void {
  if (!context.contextAction) throw new Error('Context command requires its active entity action');
  context.contextAction();
}

export function runContextOr(context: SurfaceCommandContext, fallback: () => void): void {
  if (context.surface === 'context') runContextAction(context);
  else fallback();
}

export const CONTEXT_SURFACE_COMMANDS = [
  {
    id: 'context:select-all-type', labelKey: 'entityContextMenu.selectAllType',
    contextLabelParams: (state: SurfaceCommandState) => ({ type: state.contextEntityType ?? '' }),
    keywords: 'select matching ifc type', category: 'Tools', icon: Layers,
    surfaces: contextOnly, enabled: alwaysEnabled, run: runContextAction,
  },
  {
    id: 'context:select-same-storey', labelKey: 'entityContextMenu.selectSameStorey',
    keywords: 'select storey floor', category: 'Tools', icon: Building2,
    surfaces: contextOnly, enabled: alwaysEnabled, run: runContextAction,
  },
  {
    id: 'context:copy-global-id', labelKey: ACTION_NAME_KEYS.copyGlobalId, ribbonTooltipKey: ACTION_NAME_KEYS.copyGlobalId,
    keywords: 'copy guid global id', category: 'Tools', icon: Copy,
    surfaces: contextAndRibbon, enabled: alwaysEnabled, run: runContextAction,
  },
  {
    id: 'context:export-anonymized', labelKey: 'entityContextMenu.exportAnonymized',
    keywords: 'export anonymized privacy', category: 'Export', icon: ShieldQuestion,
    surfaces: contextOnly, enabled: alwaysEnabled, run: runContextAction,
  },
  {
    id: 'context:duplicate', labelKey: 'entityContextMenu.duplicateLabel',
    keywords: 'duplicate copy entity', category: 'Tools', icon: CopyPlus,
    surfaces: contextOnly, enabled: canEdit, shortcut: 'edit.duplicate', run: runContextAction,
  },
  {
    id: 'context:duplicate-x-plus', labelKey: 'entityContextMenu.duplicateXPlus',
    direction: '+X',
    keywords: 'duplicate east', category: 'Tools', icon: CopyPlus,
    surfaces: contextOnly, enabled: canEdit, run: runContextAction,
  },
  {
    id: 'context:duplicate-x-minus', labelKey: 'entityContextMenu.duplicateXMinus',
    direction: '-X',
    keywords: 'duplicate west', category: 'Tools', icon: CopyPlus,
    surfaces: contextOnly, enabled: canEdit, run: runContextAction,
  },
  {
    id: 'context:duplicate-y-plus', labelKey: 'entityContextMenu.duplicateYPlus',
    direction: '+Y',
    keywords: 'duplicate north', category: 'Tools', icon: CopyPlus,
    surfaces: contextOnly, enabled: canEdit, run: runContextAction,
  },
  {
    id: 'context:duplicate-y-minus', labelKey: 'entityContextMenu.duplicateYMinus',
    direction: '-Y',
    keywords: 'duplicate south', category: 'Tools', icon: CopyPlus,
    surfaces: contextOnly, enabled: canEdit, run: runContextAction,
  },
  {
    id: 'context:duplicate-z-plus', labelKey: 'entityContextMenu.duplicateZPlus',
    direction: '+Z',
    keywords: 'duplicate up', category: 'Tools', icon: CopyPlus,
    surfaces: contextOnly, enabled: canEdit, run: runContextAction,
  },
  {
    id: 'context:duplicate-z-minus', labelKey: 'entityContextMenu.duplicateZMinus',
    direction: '-Z',
    keywords: 'duplicate down', category: 'Tools', icon: CopyPlus,
    surfaces: contextOnly, enabled: canEdit, run: runContextAction,
  },
  {
    id: 'context:delete', labelKey: 'entityContextMenu.deleteEntity',
    keywords: 'delete remove entity', category: 'Tools', icon: Trash2,
    surfaces: contextOnly, enabled: canEdit, run: runContextAction,
  },
] as const satisfies readonly (SurfaceCommandDefinition & { direction?: DuplicateDirection })[];

/** Derive submenu ordering and direction from the same command rows that own their labels. */
export const DUPLICATE_CONTEXT_DIRECTIONS = CONTEXT_SURFACE_COMMANDS
  .filter((command) => 'direction' in command)
  .map(({ id, direction }) => ({ id, direction }));
