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
   * renderers (`CameraCommandMenuItems`, `ViewTab`) call `t(command.xKey)`.
   *
   * Short button caption.
   */
  labelKey: TranslationKey;
  /** Longer tooltip when the label isn't the whole story. */
  tooltipKey: TranslationKey;
  /** Keyboard command naming this action's key, where one exists (`lib/commands`). */
  shortcut?: KeyCommandId;
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
