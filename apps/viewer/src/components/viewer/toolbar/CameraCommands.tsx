/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bind the shared camera command list to the live camera for the ribbon. */

import React, { useMemo } from 'react';
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
