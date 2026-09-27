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
  /**
   * Translation keys, not text — this list has no React import, so it
   * cannot call `t()` itself (`shared-commands.en.ts` holds the English);
   * the ribbon's `ViewTab` calls `t(command.xKey)`.
   *
   * Short button caption.
   */
  labelKey: TranslationKey;
  /** Longer tooltip when the label isn't the whole story. */
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
      labelKey: 'cameraCommands.home.label',
      tooltipKey: 'cameraCommands.home.tooltip',
      shortcut: 'camera.home',
      group: 'camera',
      run: () => goHome(),
    },
    {
      id: 'zoomIn',
      labelKey: 'cameraCommands.zoomIn.label',
      tooltipKey: 'cameraCommands.zoomIn.tooltip',
      group: 'camera',
      repeatable: true,
      run: () => callbacks.zoomIn?.(),
    },
    {
      id: 'zoomOut',
      labelKey: 'cameraCommands.zoomOut.label',
      tooltipKey: 'cameraCommands.zoomOut.tooltip',
      group: 'camera',
      repeatable: true,
      run: () => callbacks.zoomOut?.(),
    },
    {
      id: 'fitAll',
      labelKey: 'cameraCommands.fitAll.label',
      tooltipKey: 'cameraCommands.fitAll.tooltip',
      shortcut: 'camera.fitAll',
      group: 'camera',
      run: () => callbacks.fitAll?.(),
    },
    {
      id: 'viewTop',
      labelKey: 'cameraCommands.viewTop.label',
      tooltipKey: 'cameraCommands.viewTop.tooltip',
      shortcut: 'camera.viewTop',
      group: 'preset',
      run: () => callbacks.setPresetView?.('top'),
    },
    {
      id: 'viewBottom',
      labelKey: 'cameraCommands.viewBottom.label',
      tooltipKey: 'cameraCommands.viewBottom.tooltip',
      shortcut: 'camera.viewBottom',
      group: 'preset',
      run: () => callbacks.setPresetView?.('bottom'),
    },
    {
      id: 'viewFront',
      labelKey: 'cameraCommands.viewFront.label',
      tooltipKey: 'cameraCommands.viewFront.tooltip',
      shortcut: 'camera.viewFront',
      group: 'preset',
      run: () => callbacks.setPresetView?.('front'),
    },
    {
      id: 'viewBack',
      labelKey: 'cameraCommands.viewBack.label',
      tooltipKey: 'cameraCommands.viewBack.tooltip',
      shortcut: 'camera.viewBack',
      group: 'preset',
      run: () => callbacks.setPresetView?.('back'),
    },
    {
      id: 'viewLeft',
      labelKey: 'cameraCommands.viewLeft.label',
      tooltipKey: 'cameraCommands.viewLeft.tooltip',
      shortcut: 'camera.viewLeft',
      group: 'preset',
      run: () => callbacks.setPresetView?.('left'),
    },
    {
      id: 'viewRight',
      labelKey: 'cameraCommands.viewRight.label',
      tooltipKey: 'cameraCommands.viewRight.tooltip',
      shortcut: 'camera.viewRight',
      group: 'preset',
      run: () => callbacks.setPresetView?.('right'),
    },
    {
      id: 'rotateLeft',
      labelKey: 'cameraCommands.rotateLeft.label',
      tooltipKey: 'cameraCommands.rotateLeft.tooltip',
      group: 'rotate',
      repeatable: true,
      run: () => callbacks.rotateLeft?.(),
    },
    {
      id: 'rotateRight',
      labelKey: 'cameraCommands.rotateRight.label',
      tooltipKey: 'cameraCommands.rotateRight.tooltip',
      group: 'rotate',
      repeatable: true,
      run: () => callbacks.rotateRight?.(),
    },
  ];
}
