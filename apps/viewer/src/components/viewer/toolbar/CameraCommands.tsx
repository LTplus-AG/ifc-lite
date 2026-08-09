/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The camera command set — Home, zoom, the six preset views and the 90°
 * rotations — as ONE ordered list shared by the classic toolbar and the
 * ribbon, so neither style can host a camera command the other lacks.
 *
 * This exists because they did fork: `rotateLeft`/`rotateRight` landed
 * with a single call site in the ribbon's View tab (#1829), leaving the
 * classic toolbar with no way to rotate the camera at all, and the same
 * change hid the viewport's desktop zoom cluster for BOTH styles on the
 * (ribbon-only) grounds that "the ribbon owns these controls". A list is
 * the fix that scales: a command added here shows up in both surfaces
 * without anyone remembering to wire the second one.
 *
 * Each surface still renders in its own idiom — the ribbon as labeled
 * groups of large/small buttons, the classic strip as its View-options
 * dropdown (`CameraCommandMenuItems` below) — but the *set* is single
 * sourced. Same pattern as `ClassVisibilityMenu`.
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
import type { CameraCallbacks } from '@/store/types';

export type CameraCommandId =
  | 'home'
  | 'zoomIn'
  | 'zoomOut'
  | 'fitAll'
  | 'viewTop'
  | 'viewBottom'
  | 'viewFront'
  | 'viewBack'
  | 'viewLeft'
  | 'viewRight'
  | 'rotateLeft'
  | 'rotateRight';

/**
 * Layout hint, not a capability boundary: every surface renders every
 * group. `preset` is the six axis views (rendered as a compact block),
 * `rotate` the two 90° steps.
 */
export type CameraCommandGroup = 'camera' | 'preset' | 'rotate';

export interface CameraCommand {
  id: CameraCommandId;
  /** Short button caption. */
  label: string;
  /** Longer tooltip / menu-item description when the label isn't the whole story. */
  tooltip: string;
  /** Keyboard shortcut, when one exists (see `useKeyboardShortcuts`). */
  shortcut?: string;
  icon: React.ElementType;
  group: CameraCommandGroup;
  /**
   * True when users press it repeatedly (zoom, rotate). Menu surfaces keep
   * themselves open on select for these; a menu that closes after one 90°
   * step makes a half-turn a four-click errand.
   */
  repeatable?: boolean;
  run: () => void;
}

export interface CameraCommandContext {
  callbacks: CameraCallbacks;
  /** Home is more than a camera pose (it also resets visibility), so it's injected. */
  goHome: () => void;
}

/**
 * Pure builder — the hook below binds it to the live store. Kept separate
 * so the command set and its dispatch can be asserted without a renderer.
 */
export function buildCameraCommands({ callbacks, goHome }: CameraCommandContext): CameraCommand[] {
  return [
    {
      id: 'home',
      label: 'Isometric',
      tooltip: 'Home (isometric + reset visibility)',
      shortcut: 'H',
      icon: IsometricView,
      group: 'camera',
      run: () => goHome(),
    },
    {
      id: 'zoomIn',
      label: 'Zoom in',
      tooltip: 'Zoom in',
      icon: ZoomIn,
      group: 'camera',
      repeatable: true,
      run: () => callbacks.zoomIn?.(),
    },
    {
      id: 'zoomOut',
      label: 'Zoom out',
      tooltip: 'Zoom out',
      icon: ZoomOut,
      group: 'camera',
      repeatable: true,
      run: () => callbacks.zoomOut?.(),
    },
    {
      id: 'fitAll',
      label: 'Fit all',
      tooltip: 'Fit all in view',
      shortcut: 'Z',
      icon: FitAll,
      group: 'camera',
      run: () => callbacks.fitAll?.(),
    },
    {
      id: 'viewTop',
      label: 'Top',
      tooltip: 'Top view',
      shortcut: '1',
      icon: TopView,
      group: 'preset',
      run: () => callbacks.setPresetView?.('top'),
    },
    {
      id: 'viewBottom',
      label: 'Bottom',
      tooltip: 'Bottom view',
      shortcut: '2',
      icon: BottomView,
      group: 'preset',
      run: () => callbacks.setPresetView?.('bottom'),
    },
    {
      id: 'viewFront',
      label: 'Front',
      tooltip: 'Front view',
      shortcut: '3',
      icon: FrontView,
      group: 'preset',
      run: () => callbacks.setPresetView?.('front'),
    },
    {
      id: 'viewBack',
      label: 'Back',
      tooltip: 'Back view',
      shortcut: '4',
      icon: BackView,
      group: 'preset',
      run: () => callbacks.setPresetView?.('back'),
    },
    {
      id: 'viewLeft',
      label: 'Left',
      tooltip: 'Left view',
      shortcut: '5',
      icon: LeftView,
      group: 'preset',
      run: () => callbacks.setPresetView?.('left'),
    },
    {
      id: 'viewRight',
      label: 'Right',
      tooltip: 'Right view',
      shortcut: '6',
      icon: RightView,
      group: 'preset',
      run: () => callbacks.setPresetView?.('right'),
    },
    {
      id: 'rotateLeft',
      label: 'Rotate left',
      tooltip: 'Rotate left 90°',
      icon: RotateLeft,
      group: 'rotate',
      repeatable: true,
      run: () => callbacks.rotateLeft?.(),
    },
    {
      id: 'rotateRight',
      label: 'Rotate right',
      tooltip: 'Rotate right 90°',
      icon: RotateRight,
      group: 'rotate',
      repeatable: true,
      run: () => callbacks.rotateRight?.(),
    },
  ];
}

/** The command set bound to the live camera. */
export function useCameraCommands(): CameraCommand[] {
  const callbacks = useViewerStore((s) => s.cameraCallbacks);
  return useMemo(
    () => buildCameraCommands({ callbacks, goHome: goHomeFromStore }),
    [callbacks],
  );
}

const GROUP_LABEL: Record<CameraCommandGroup, string> = {
  camera: 'Camera',
  preset: 'Preset views',
  rotate: 'Rotate',
};

/**
 * The camera block of the classic toolbar's View-options dropdown.
 * Repeatable commands keep the menu open so zoom/rotate can be pressed
 * several times without re-opening it.
 */
export function CameraCommandMenuItems() {
  const commands = useCameraCommands();
  const groups: CameraCommandGroup[] = ['camera', 'preset', 'rotate'];
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
