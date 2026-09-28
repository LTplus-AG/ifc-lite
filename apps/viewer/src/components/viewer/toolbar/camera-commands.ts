/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The camera command set — Home, zoom, six preset views and 90°
 * rotations — in ribbon order. Camera callbacks stay behind this table so
 * keyboard metadata and visible controls share command ids.
 *
 * Icons and rendering live in `CameraCommands.tsx`; keeping command data
 * here lets dispatch be asserted in a plain Node test.
 */

import type { TranslationKey } from '@/i18n';
import type { CameraCallbacks } from '@/store/types';
import type { KeyCommandId } from '@/lib/commands/keyboard-commands';

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
  /** Longer tooltip; the registered surface command owns the button label. */
  tooltipKey: TranslationKey;
  /** Keyboard command naming this action's key, where one exists (`lib/commands`). */
  shortcut?: KeyCommandId;
  group: CameraCommandGroup;
  /** Repeated zoom and rotation action. */
  repeatable?: boolean;
  run: () => void;
}

export interface CameraCommandContext {
  callbacks: CameraCallbacks;
  /** Camera Home is shared across the toolbar and ribbon. */
  goHome: () => void;
}

export function buildCameraCommands({ callbacks, goHome }: CameraCommandContext): CameraCommand[] {
  return [
    {
      id: 'home',
      tooltipKey: 'cameraCommands.home.tooltip',
      shortcut: 'camera.home',
      group: 'camera',
      run: () => goHome(),
    },
    {
      id: 'zoomIn',
      tooltipKey: 'cameraCommands.zoomIn.tooltip',
      group: 'camera',
      repeatable: true,
      run: () => callbacks.zoomIn?.(),
    },
    {
      id: 'zoomOut',
      tooltipKey: 'cameraCommands.zoomOut.tooltip',
      group: 'camera',
      repeatable: true,
      run: () => callbacks.zoomOut?.(),
    },
    {
      id: 'fitAll',
      tooltipKey: 'cameraCommands.fitAll.tooltip',
      shortcut: 'camera.fitAll',
      group: 'camera',
      run: () => callbacks.fitAll?.(),
    },
    {
      id: 'viewTop',
      tooltipKey: 'cameraCommands.viewTop.tooltip',
      shortcut: 'camera.viewTop',
      group: 'preset',
      run: () => callbacks.setPresetView?.('top'),
    },
    {
      id: 'viewBottom',
      tooltipKey: 'cameraCommands.viewBottom.tooltip',
      shortcut: 'camera.viewBottom',
      group: 'preset',
      run: () => callbacks.setPresetView?.('bottom'),
    },
    {
      id: 'viewFront',
      tooltipKey: 'cameraCommands.viewFront.tooltip',
      shortcut: 'camera.viewFront',
      group: 'preset',
      run: () => callbacks.setPresetView?.('front'),
    },
    {
      id: 'viewBack',
      tooltipKey: 'cameraCommands.viewBack.tooltip',
      shortcut: 'camera.viewBack',
      group: 'preset',
      run: () => callbacks.setPresetView?.('back'),
    },
    {
      id: 'viewLeft',
      tooltipKey: 'cameraCommands.viewLeft.tooltip',
      shortcut: 'camera.viewLeft',
      group: 'preset',
      run: () => callbacks.setPresetView?.('left'),
    },
    {
      id: 'viewRight',
      tooltipKey: 'cameraCommands.viewRight.tooltip',
      shortcut: 'camera.viewRight',
      group: 'preset',
      run: () => callbacks.setPresetView?.('right'),
    },
    {
      id: 'rotateLeft',
      tooltipKey: 'cameraCommands.rotateLeft.tooltip',
      group: 'rotate',
      repeatable: true,
      run: () => callbacks.rotateLeft?.(),
    },
    {
      id: 'rotateRight',
      tooltipKey: 'cameraCommands.rotateRight.tooltip',
      group: 'rotate',
      repeatable: true,
      run: () => callbacks.rotateRight?.(),
    },
  ];
}
