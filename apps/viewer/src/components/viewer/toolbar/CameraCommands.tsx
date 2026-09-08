/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rendering half of the shared camera command set (`camera-commands.ts`):
 * the icon per command, the hook that binds the list to the live camera,
 * and the classic toolbar's menu body. Each surface still renders in its
 * own idiom — the ribbon as labeled groups of buttons, the classic strip
 * as the block below inside its View-options dropdown — but the *set* is
 * single sourced, the same way `ClassVisibilityMenu` shares one dropdown
 * body between both styles.
 */

import React, { useMemo } from 'react';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  TopView,
  BottomView,
  FrontView,
  BackView,
  LeftView,
  RightView,
  IsometricView,
  ZoomIn,
  ZoomOut,
  FitAll,
  RotateLeft,
  RotateRight,
} from '@/icons';
import { useViewerStore } from '@/store';
import { goHomeFromStore } from '@/store/homeView';
import {
  buildCameraCommands,
  type CameraCommand,
  type CameraCommandGroup,
  type CameraCommandId,
} from './camera-commands';

/** Exhaustive by type: a new command id doesn't compile until it has an icon. */
const CAMERA_COMMAND_ICONS: Record<CameraCommandId, React.ElementType> = {
  home: IsometricView,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  fitAll: FitAll,
  viewTop: TopView,
  viewBottom: BottomView,
  viewFront: FrontView,
  viewBack: BackView,
  viewLeft: LeftView,
  viewRight: RightView,
  rotateLeft: RotateLeft,
  rotateRight: RotateRight,
};

export interface RenderableCameraCommand extends CameraCommand {
  icon: React.ElementType;
}

/** The command set bound to the live camera, each entry carrying its icon. */
export function useCameraCommands(): RenderableCameraCommand[] {
  const callbacks = useViewerStore((s) => s.cameraCallbacks);
  return useMemo(
    () => buildCameraCommands({ callbacks, goHome: goHomeFromStore })
      .map((command) => ({ ...command, icon: CAMERA_COMMAND_ICONS[command.id] })),
    [callbacks],
  );
}

const GROUP_LABEL: Record<CameraCommandGroup, string> = {
  camera: 'Camera',
  preset: 'Preset views',
  rotate: 'Rotate',
};

/**
 * The camera block of the classic toolbar's View-options dropdown. Group
 * order comes from the command list itself, so a group added there shows
 * up here without a second edit. Repeatable commands keep the menu open,
 * so zoom and rotate can be pressed several times in one visit.
 */
export function CameraCommandMenuItems() {
  const commands = useCameraCommands();
  const groups = [...new Set(commands.map((command) => command.group))];
  return (
    <>
      {groups.map((group, index) => (
        <React.Fragment key={group}>
          {index > 0 && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {GROUP_LABEL[group]}
          </DropdownMenuLabel>
          {commands
            .filter((command) => command.group === group)
            .map((command) => {
              const Icon = command.icon;
              return (
                <DropdownMenuItem
                  key={command.id}
                  onSelect={(event) => {
                    if (command.repeatable) event.preventDefault();
                    command.run();
                  }}
                >
                  <Icon className="h-4 w-4 mr-2" /> {command.label}
                  {command.shortcut && (
                    <span className="ml-auto text-xs opacity-60">{command.shortcut}</span>
                  )}
                </DropdownMenuItem>
              );
            })}
        </React.Fragment>
      ))}
    </>
  );
}
