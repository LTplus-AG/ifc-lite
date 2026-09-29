/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model tool rail's rows (charter #6232, M2 §1.3). One row per tool;
 * `ModelToolRail` renders them in table order with a divider between
 * groups, and each row's key is a `KEY_COMMANDS` row so the tooltip, the
 * shortcuts dialog and the palette name the same key. A tool whose command
 * does not exist yet has no row: each command's PR adds its own.
 */

import type { ComponentType } from 'react';
import { CopyPlus, LogOut, MousePointer2, Slice } from 'lucide-react';
import { BeamIcon, ColumnIcon, DoorIcon, OpeningIcon, RoomIcon, SlabIcon, WallIcon, WindowIcon } from './model-icons';
import type { TranslationKey } from '@/i18n';
import type { KeyCommandId } from '@/lib/commands/keyboard-commands';
import { launchModelCommand } from '@/lib/commands/modeling/keys-workspace';
import { useViewerStore, type ViewerState } from '@/store';

type RailGroup = 'select' | 'build' | 'host' | 'edit';

export interface RailTool {
  /** The command id it starts, or `select`. Also its tour anchor. */
  readonly id: string;
  readonly group: RailGroup;
  readonly labelKey: TranslationKey;
  readonly Icon: ComponentType<{ className?: string }>;
  readonly shortcut: KeyCommandId;
  /** Draws on the session's workplane, so it is disabled while there is none. */
  readonly drawsOnWorkplane: boolean;
  isActive(s: ViewerState): boolean;
  /** Why the tool cannot start right now, beyond the workplane (null: it can). */
  blockedKey?(s: ViewerState): TranslationKey | null;
  run(): void;
}

const commandActive = (id: string) => (s: ViewerState) => s.session?.activeCommandId === id;

export const RAIL_TOOLS: readonly RailTool[] = [
  {
    id: 'select', group: 'select', labelKey: 'modelWorkspace.tool.select', Icon: MousePointer2,
    shortcut: 'tool.select', drawsOnWorkplane: false,
    isActive: (s) => s.activeTool === 'select',
    run: () => useViewerStore.getState().setActiveTool('select'),
  },
  {
    id: 'wall.place', group: 'build', labelKey: 'modelWorkspace.tool.wall', Icon: WallIcon,
    shortcut: 'model.wall', drawsOnWorkplane: true,
    isActive: commandActive('wall.place'),
    run: () => { launchModelCommand('wall.place'); },
  },
  {
    id: 'slab.place', group: 'build', labelKey: 'modelWorkspace.tool.slab', Icon: SlabIcon,
    shortcut: 'model.slab', drawsOnWorkplane: true,
    isActive: commandActive('slab.place'),
    run: () => { launchModelCommand('slab.place'); },
  },
  {
    id: 'column.place', group: 'build', labelKey: 'modelWorkspace.tool.column', Icon: ColumnIcon,
    shortcut: 'model.column', drawsOnWorkplane: true,
    isActive: commandActive('column.place'),
    run: () => { launchModelCommand('column.place'); },
  },
  {
    id: 'beam.place', group: 'build', labelKey: 'modelWorkspace.tool.beam', Icon: BeamIcon,
    shortcut: 'model.beam', drawsOnWorkplane: true,
    isActive: commandActive('beam.place'),
    run: () => { launchModelCommand('beam.place'); },
  },
  {
    id: 'room.place', group: 'build', labelKey: 'roomTool.label', Icon: RoomIcon,
    shortcut: 'model.room', drawsOnWorkplane: true,
    isActive: commandActive('room.place'),
    run: () => { launchModelCommand('room.place'); },
  },
  {
    id: 'opening.place', group: 'host', labelKey: 'hostedPlace.tool.opening', Icon: OpeningIcon,
    shortcut: 'model.opening', drawsOnWorkplane: true,
    isActive: commandActive('opening.place'),
    run: () => { launchModelCommand('opening.place'); },
  },
  {
    id: 'door.place', group: 'host', labelKey: 'hostedPlace.tool.door', Icon: DoorIcon,
    shortcut: 'model.door', drawsOnWorkplane: true,
    isActive: commandActive('door.place'),
    run: () => { launchModelCommand('door.place'); },
  },
  {
    id: 'window.place', group: 'host', labelKey: 'hostedPlace.tool.window', Icon: WindowIcon,
    shortcut: 'model.window', drawsOnWorkplane: true,
    isActive: commandActive('window.place'),
    run: () => { launchModelCommand('window.place'); },
  },
  {
    id: 'element.split', group: 'edit', labelKey: 'modelWorkspace.tool.split', Icon: Slice,
    shortcut: 'tool.split', drawsOnWorkplane: false,
    isActive: commandActive('element.split'),
    blockedKey: (s) => (s.selectedEntityId === null ? 'modelWorkspace.blocked.split' : null),
    run: () => { launchModelCommand('element.split', { drawsOnWorkplane: false }); },
  },
  {
    id: 'element.array', group: 'edit', labelKey: 'copyArray.tool.array', Icon: CopyPlus,
    shortcut: 'model.array', drawsOnWorkplane: true,
    isActive: commandActive('element.array'),
    blockedKey: (s) => (s.selectedEntityId === null && s.selectedEntityIds.size === 0 ? 'copyArray.blocked.array' : null),
    run: () => { launchModelCommand('element.array'); },
  },
];

/** The rail's footer: leave the workspace (E, like the ribbon's Model button). */
export const LEAVE_TOOL = {
  id: 'leave',
  labelKey: 'modelWorkspace.tool.leave',
  Icon: LogOut,
  shortcut: 'edit.toggleEditMode',
  run: () => useViewerStore.getState().exitModelWorkspace(),
} as const satisfies Pick<RailTool, 'id' | 'labelKey' | 'Icon' | 'shortcut' | 'run'>;
