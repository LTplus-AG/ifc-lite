/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The camera command set — Home, zoom, the six preset views and the 90°
 * rotations — as ONE ordered list, shared by the classic toolbar and the
 * ribbon so neither style can host a camera command the other lacks.
 *
 * This exists because they did fork: `rotateLeft`/`rotateRight` landed with
 * a single call site in the ribbon's View tab (#1829), leaving the classic
 * toolbar with no way to rotate the camera at all, and the same change hid
 * the viewport's desktop zoom cluster from BOTH styles on the (ribbon-only)
 * grounds that the ribbon owned those controls. A list is the fix that
 * scales: a command added here reaches both surfaces without anyone
 * remembering to wire the second one.
 *
 * Icons and rendering live in `CameraCommands.tsx` — the icon module is a
 * Vite virtual module, so keeping the command data here is what lets the
 * dispatch be asserted in a plain node test.
 */

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
  /** Longer tooltip when the label isn't the whole story. */
  tooltip: string;
  /** Keyboard shortcut, where one exists (see `useKeyboardShortcuts`). */
  shortcut?: string;
  group: CameraCommandGroup;
  /**
   * True when users press it repeatedly (zoom, rotate). Menu surfaces stay
   * open on select for these; a menu that closes after one 90° step makes a
   * half-turn a four-click errand.
   */
  repeatable?: boolean;
  run: () => void;
}

export interface CameraCommandContext {
  callbacks: CameraCallbacks;
  /** Home also resets visibility, so it is more than a camera pose — injected. */
  goHome: () => void;
}

export function buildCameraCommands({ callbacks, goHome }: CameraCommandContext): CameraCommand[] {
  return [
    {
      id: 'home',
      label: 'Isometric',
      tooltip: 'Home (isometric + reset visibility)',
      shortcut: 'H',
      group: 'camera',
      run: () => goHome(),
    },
    {
      id: 'zoomIn',
      label: 'Zoom in',
      tooltip: 'Zoom in',
      group: 'camera',
      repeatable: true,
      run: () => callbacks.zoomIn?.(),
    },
    {
      id: 'zoomOut',
      label: 'Zoom out',
      tooltip: 'Zoom out',
      group: 'camera',
      repeatable: true,
      run: () => callbacks.zoomOut?.(),
    },
    {
      id: 'fitAll',
      label: 'Fit all',
      tooltip: 'Fit all in view',
      shortcut: 'Z',
      group: 'camera',
      run: () => callbacks.fitAll?.(),
    },
    {
      id: 'viewTop',
      label: 'Top',
      tooltip: 'Top view',
      shortcut: '1',
      group: 'preset',
      run: () => callbacks.setPresetView?.('top'),
    },
    {
      id: 'viewBottom',
      label: 'Bottom',
      tooltip: 'Bottom view',
      shortcut: '2',
      group: 'preset',
      run: () => callbacks.setPresetView?.('bottom'),
    },
    {
      id: 'viewFront',
      label: 'Front',
      tooltip: 'Front view',
      shortcut: '3',
      group: 'preset',
      run: () => callbacks.setPresetView?.('front'),
    },
    {
      id: 'viewBack',
      label: 'Back',
      tooltip: 'Back view',
      shortcut: '4',
      group: 'preset',
      run: () => callbacks.setPresetView?.('back'),
    },
    {
      id: 'viewLeft',
      label: 'Left',
      tooltip: 'Left view',
      shortcut: '5',
      group: 'preset',
      run: () => callbacks.setPresetView?.('left'),
    },
    {
      id: 'viewRight',
      label: 'Right',
      tooltip: 'Right view',
      shortcut: '6',
      group: 'preset',
      run: () => callbacks.setPresetView?.('right'),
    },
    {
      id: 'rotateLeft',
      label: 'Rotate left',
      tooltip: 'Rotate left 90°',
      group: 'rotate',
      repeatable: true,
      run: () => callbacks.rotateLeft?.(),
    },
    {
      id: 'rotateRight',
      label: 'Rotate right',
      tooltip: 'Rotate right 90°',
      group: 'rotate',
      repeatable: true,
      run: () => callbacks.rotateRight?.(),
    },
  ];
}
